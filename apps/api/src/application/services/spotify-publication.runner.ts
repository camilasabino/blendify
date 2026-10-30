import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PlaylistKind } from '@blendify/contracts';
import { BusinessRuleError } from '@/domain/errors/business-rule.error';
import type { Playlist } from '@/domain/playlist/playlist.entity';
import {
  classifyPublicationFailure,
  completePublication,
  failPublication,
  interruptPublication,
  isSettled,
  recordRemoteCreated,
  startPublication,
  type PublishingSpotifyDestination,
  type SpotifyDestination,
  type SpotifyPublishIncompleteReason,
} from '@/domain/publication/spotify-destination';
import {
  MUSIC_PROVIDER_FACTORY,
  type MusicProviderFactoryPort,
} from '@/domain/repositories/music-provider.factory.port';
import {
  PUBLICATION_QUOTA,
  type PublicationQuotaPort,
} from '@/domain/repositories/publication-quota.port';
import {
  USAGE_STATS_REPOSITORY,
  type UsageStatsRepositoryPort,
} from '@/domain/repositories/usage-stats.repository.port';
import {
  USER_REPOSITORY,
  type UserRepositoryPort,
} from '@/domain/repositories/user.repository.port';
import type { User } from '@/domain/user/user.entity';
import {
  DestinationLease,
  type DestinationLeaseEvent,
} from './destination-lease';
import {
  DESTINATION_LEASE_MS,
  DESTINATION_LEASE_RENEW_INTERVAL_MS,
} from './destination-lease.policy';
import { usageRecordFor } from './playlist-usage-record';
import { PublishPlaylistService } from './publish-playlist.service';

export interface DestinationStore {
  read(): Promise<SpotifyDestination | null>;
  acquireClaim(ttlMs: number): Promise<string | null>;
  renewClaim(claimId: string, ttlMs: number): Promise<boolean>;
  releaseClaim(claimId: string): Promise<void>;
  start(publishing: PublishingSpotifyDestination): Promise<boolean>;
  saveOutcome(
    destination: SpotifyDestination,
    attemptId: string,
  ): Promise<boolean>;
  restore(attemptId: string): Promise<boolean>;
}

export type PublicationOutcome =
  'reused' | 'published' | 'publish_incomplete' | 'interrupted' | 'superseded';

export interface PublicationOutcomeEvent {
  outcome: PublicationOutcome;
  playlistKind?: PlaylistKind;
  trackCount?: number;
  savedToLibrary?: boolean;
  reason?: SpotifyPublishIncompleteReason;
  spotifyPlaylistCreated?: boolean;
  error?: unknown;
}

export type PublicationDiagnostic =
  | DestinationLeaseEvent
  | 'state_not_persisted'
  | 'usage_not_recorded'
  | 'publish_interrupted';

export interface SpotifyPublicationRequest {
  userId: string;
  store: DestinationStore;
  coverImageBase64?: string;
  persistToLibrary: boolean;
  assertStartable?: () => void;
  loadPlaylist: (user: User) => Playlist | Promise<Playlist>;
  inProgressError: () => Error;
  onOutcome?: (event: PublicationOutcomeEvent) => void;
  onDiagnostic?: (event: PublicationDiagnostic, error?: unknown) => void;
}

export interface SpotifyPublicationResult {
  outcome: PublicationOutcome;
  destination: SpotifyDestination | null;
}

@Injectable()
export class SpotifyPublicationRunner {
  constructor(
    private readonly publisher: PublishPlaylistService,
    @Inject(PUBLICATION_QUOTA) private readonly quota: PublicationQuotaPort,
    @Inject(USAGE_STATS_REPOSITORY)
    private readonly usageStats: UsageStatsRepositoryPort,
    @Inject(USER_REPOSITORY) private readonly users: UserRepositoryPort,
    @Inject(MUSIC_PROVIDER_FACTORY)
    private readonly providers: MusicProviderFactoryPort,
  ) {}

  async run(
    request: SpotifyPublicationRequest,
  ): Promise<SpotifyPublicationResult> {
    const { store } = request;
    const existing = await store.read();
    if (isSettled(existing)) {
      return reused(request, existing);
    }
    request.assertStartable?.();

    const user = await this.users.findById(request.userId);
    if (!user) {
      throw new BusinessRuleError('User not found', 'USER_NOT_FOUND');
    }

    const claimId = await store.acquireClaim(DESTINATION_LEASE_MS);
    if (!claimId) {
      throw request.inProgressError();
    }

    const lease = new DestinationLease(
      {
        renew: (ttlMs) => store.renewClaim(claimId, ttlMs),
        release: () => store.releaseClaim(claimId),
      },
      {
        leaseMs: DESTINATION_LEASE_MS,
        renewIntervalMs: DESTINATION_LEASE_RENEW_INTERVAL_MS,
      },
      (event) => request.onDiagnostic?.(event),
    );
    try {
      const current = await store.read();
      if (isSettled(current)) {
        return reused(request, current);
      }
      if (current?.status === 'publishing') {
        return await this.settleAbandoned(request, current);
      }
      const playlist = await request.loadPlaylist(user);
      await this.quota.consume(user.id);
      return await this.publishOnce(request, { playlist, user, lease });
    } finally {
      await lease.release();
    }
  }

  private async settleAbandoned(
    request: SpotifyPublicationRequest,
    abandoned: PublishingSpotifyDestination,
  ): Promise<SpotifyPublicationResult> {
    const interrupted = interruptPublication(abandoned, new Date());
    const persisted = await this.persist(
      request,
      interrupted,
      abandoned.attemptId,
    );
    request.onDiagnostic?.('publish_interrupted');
    request.onOutcome?.({ outcome: 'interrupted', reason: 'interrupted' });
    return {
      outcome: 'interrupted',
      destination: persisted ? interrupted : await request.store.read(),
    };
  }

  private async publishOnce(
    request: SpotifyPublicationRequest,
    attempt: { playlist: Playlist; user: User; lease: DestinationLease },
  ): Promise<SpotifyPublicationResult> {
    const { playlist, user, lease } = attempt;
    if (lease.isLost) {
      throw request.inProgressError();
    }

    const provider = this.providers.forUser(user.id);
    const attemptId = randomUUID();
    let working = startPublication(attemptId, new Date());
    await this.start(request, working);

    const fields = {
      playlistKind: playlist.kind,
      trackCount: playlist.trackCount,
    };
    let remoteCreated = false;
    let published: SpotifyDestination;
    try {
      const detail = await this.publisher.execute({
        playlist,
        provider,
        spotifyUserId: user.spotifyId,
        coverImageBase64: request.coverImageBase64,
        persistToLibrary: request.persistToLibrary,
        onRemotePlaylistCreated: async (created) => {
          remoteCreated = true;
          working = recordRemoteCreated(working, {
            spotifyId: created.id,
            spotifyUrl: created.url,
          });
          await this.persist(request, working, attemptId);
        },
      });
      published = completePublication(
        {
          spotifyPlaylist: {
            spotifyId:
              detail.spotifyId ?? working.spotifyPlaylist?.spotifyId ?? '',
            spotifyUrl:
              detail.spotifyUrl ?? working.spotifyPlaylist?.spotifyUrl ?? null,
          },
          savedToLibrary: request.persistToLibrary,
          coverUploadFailed: detail.coverUploadFailed === true,
        },
        new Date(),
      );
    } catch (error) {
      const failure = classifyPublicationFailure(error, remoteCreated);
      if (failure.kind === 'confirmed_not_created') {
        await this.restore(request, attemptId);
        throw error;
      }
      return this.settle(
        request,
        failPublication(working, failure.reason, new Date()),
        attemptId,
        {
          outcome: 'publish_incomplete',
          ...fields,
          reason: failure.reason,
          spotifyPlaylistCreated: remoteCreated,
          error,
        },
      );
    }

    await this.recordUsage(request, user.id, playlist);
    return this.settle(request, published, attemptId, {
      outcome: 'published',
      ...fields,
      savedToLibrary: request.persistToLibrary,
    });
  }

  private async start(
    request: SpotifyPublicationRequest,
    publishing: PublishingSpotifyDestination,
  ): Promise<void> {
    let started: boolean;
    try {
      started = await request.store.start(publishing);
    } catch (error) {
      await this.restore(request, publishing.attemptId);
      throw error;
    }
    if (!started) {
      throw request.inProgressError();
    }
  }

  private async settle(
    request: SpotifyPublicationRequest,
    destination: SpotifyDestination,
    attemptId: string,
    event: PublicationOutcomeEvent,
  ): Promise<SpotifyPublicationResult> {
    if (!(await this.persist(request, destination, attemptId))) {
      request.onOutcome?.({
        outcome: 'superseded',
        playlistKind: event.playlistKind,
        trackCount: event.trackCount,
      });
      return { outcome: 'superseded', destination: await request.store.read() };
    }
    request.onOutcome?.(event);
    return { outcome: event.outcome, destination };
  }

  private async persist(
    request: SpotifyPublicationRequest,
    destination: SpotifyDestination,
    attemptId: string,
  ): Promise<boolean> {
    try {
      return await request.store.saveOutcome(destination, attemptId);
    } catch (error) {
      request.onDiagnostic?.('state_not_persisted', error);
      return true;
    }
  }

  private async restore(
    request: SpotifyPublicationRequest,
    attemptId: string,
  ): Promise<void> {
    try {
      await request.store.restore(attemptId);
    } catch (error) {
      request.onDiagnostic?.('state_not_persisted', error);
    }
  }

  private async recordUsage(
    request: SpotifyPublicationRequest,
    userId: string,
    playlist: Playlist,
  ): Promise<void> {
    try {
      await this.usageStats.recordMix({ userId, ...usageRecordFor(playlist) });
    } catch (error) {
      request.onDiagnostic?.('usage_not_recorded', error);
    }
  }
}

function reused(
  request: SpotifyPublicationRequest,
  destination: SpotifyDestination,
): SpotifyPublicationResult {
  request.onOutcome?.({ outcome: 'reused' });
  return { outcome: 'reused', destination };
}
