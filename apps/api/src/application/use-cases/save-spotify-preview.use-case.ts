import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { SpotifyPreviewStateDto } from '@blendify/contracts';
import { PreviewError } from '@/domain/errors/preview.error';
import { Playlist } from '@/domain/playlist/playlist.entity';
import {
  destinationRecordFor,
  withDestination,
  type SpotifyPreview,
  type SpotifyPreviewDestinationRecord,
} from '@/domain/preview/spotify-preview';
import { PUBLICATION_OUTCOME_RETENTION_MS } from '@/domain/preview/spotify-preview.policy';
import type {
  PublishingSpotifyDestination,
  SpotifyDestination,
} from '@/domain/publication/spotify-destination';
import {
  SPOTIFY_PREVIEW_REPOSITORY,
  type SpotifyPreviewRepositoryPort,
} from '@/domain/repositories/spotify-preview.repository.port';
import { fromTrackResponse } from '@/application/dto/playlist-response.dto';
import { toSpotifyPreviewStateResponse } from '@/application/dto/spotify-preview-response.dto';
import {
  readableDestination,
  readableLivePreview,
} from '@/application/services/spotify-preview-access';
import {
  logPreviewDiagnostic,
  logPreviewSave,
  saveFailureOutcome,
  saveOutcomeOf,
} from '@/application/services/spotify-preview-observability';
import {
  SpotifyPublicationRunner,
  type DestinationStore,
} from '@/application/services/spotify-publication.runner';
import type { User } from '@/domain/user/user.entity';

export interface SaveSpotifyPreviewCommand {
  previewId: string;
  userId: string;
  name: string;
  coverImageBase64?: string;
  persistToLibrary: boolean;
}

@Injectable()
export class SaveSpotifyPreviewUseCase {
  constructor(
    @Inject(SPOTIFY_PREVIEW_REPOSITORY)
    private readonly previews: SpotifyPreviewRepositoryPort,
    private readonly runner: SpotifyPublicationRunner,
  ) {}

  async execute(
    command: SaveSpotifyPreviewCommand,
  ): Promise<SpotifyPreviewStateDto> {
    const store = new SpotifyPreviewDestinationStore(this.previews, command);
    let destination: SpotifyDestination | null;
    try {
      ({ destination } = await this.runner.run({
        userId: command.userId,
        store,
        coverImageBase64: command.coverImageBase64,
        persistToLibrary: command.persistToLibrary,
        loadPlaylist: (user) => store.playlistFor(user, command.name),
        inProgressError: () => PreviewError.saveInProgress(),
        onOutcome: (event) =>
          logPreviewSave(saveOutcomeOf(event), {
            kind: event.playlistKind,
            trackCount: event.trackCount,
          }),
        onDiagnostic: (event) => logPreviewDiagnostic(event),
      }));
    } catch (error) {
      logPreviewSave(saveFailureOutcome(error));
      throw error;
    }

    return toSpotifyPreviewStateResponse({
      previewId: command.previewId,
      expiresAt: store.previewExpiresAt,
      playlist: await this.livePlaylist(store, command),
      destination: destination ?? (await store.currentDestination()),
    });
  }

  private async livePlaylist(
    store: SpotifyPreviewDestinationStore,
    command: SaveSpotifyPreviewCommand,
  ) {
    const preview =
      store.preview ??
      readableLivePreview(
        await this.previews.find(command.previewId),
        command.userId,
        new Date(),
      );
    return preview?.playlist ?? null;
  }
}

class SpotifyPreviewDestinationStore implements DestinationStore {
  private current: SpotifyPreviewDestinationRecord | null = null;
  private loaded: SpotifyPreview | null = null;
  private expiresAt = '';

  constructor(
    private readonly previews: SpotifyPreviewRepositoryPort,
    private readonly command: { previewId: string; userId: string },
  ) {}

  get preview(): SpotifyPreview | null {
    return this.loaded;
  }

  get previewExpiresAt(): string {
    return this.expiresAt;
  }

  async read(): Promise<SpotifyDestination | null> {
    const record = readableDestination(
      await this.previews.findDestination(this.command.previewId),
      this.command.userId,
    );
    if (record) {
      this.current = record;
      this.expiresAt = record.previewExpiresAt;
      return record.destination;
    }

    const preview = readableLivePreview(
      await this.previews.find(this.command.previewId),
      this.command.userId,
      new Date(),
    );
    if (!preview) {
      throw PreviewError.notFound();
    }
    this.loaded = preview;
    this.expiresAt = preview.expiresAt;
    return null;
  }

  async currentDestination(): Promise<SpotifyDestination | null> {
    const record = await this.previews.findDestination(this.command.previewId);
    return record?.destination ?? null;
  }

  playlistFor(user: User, name: string): Playlist {
    if (!this.loaded) {
      throw PreviewError.notFound();
    }
    const { playlist } = this.loaded;
    return Playlist.create({
      id: randomUUID(),
      userId: user.id,
      name,
      description: playlist.description,
      seeds: [...playlist.seeds],
      tracks: playlist.tracks.map(fromTrackResponse),
      generation: playlist.generation,
    });
  }

  acquireClaim(ttlMs: number): Promise<string | null> {
    return this.previews.acquireSaveClaim(this.command.previewId, ttlMs);
  }

  renewClaim(claimId: string, ttlMs: number): Promise<boolean> {
    return this.previews.renewSaveClaim(this.command.previewId, claimId, ttlMs);
  }

  releaseClaim(claimId: string): Promise<void> {
    return this.previews.releaseSaveClaim(this.command.previewId, claimId);
  }

  async start(publishing: PublishingSpotifyDestination): Promise<boolean> {
    if (!this.loaded) {
      throw PreviewError.notFound();
    }
    const record = destinationRecordFor(this.loaded, publishing, new Date());
    const started = await this.previews.createDestinationIfAbsent(
      record,
      PUBLICATION_OUTCOME_RETENTION_MS,
    );
    if (started) {
      this.current = record;
    }
    return started;
  }

  saveOutcome(
    destination: SpotifyDestination,
    attemptId: string,
  ): Promise<boolean> {
    if (!this.current) {
      throw PreviewError.notFound();
    }
    this.current = withDestination(this.current, destination, new Date());
    return this.previews.saveDestinationOutcome(
      this.current,
      attemptId,
      PUBLICATION_OUTCOME_RETENTION_MS,
    );
  }

  restore(attemptId: string): Promise<boolean> {
    return this.previews.deleteDestinationIfAttempt(
      this.command.previewId,
      attemptId,
    );
  }
}
