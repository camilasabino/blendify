import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  currentDestination,
  withDestination,
  type AiGenerationResult,
  type AiSession,
  type AiSessionDestination,
} from '@/domain/ai/ai-session';
import { AiSessionError } from '@/domain/errors/ai-session.error';
import { Playlist } from '@/domain/playlist/playlist.entity';
import type {
  PublishingSpotifyDestination,
  SpotifyDestination,
} from '@/domain/publication/spotify-destination';
import {
  AI_SESSION_REPOSITORY,
  type AiSessionRepositoryPort,
} from '@/domain/repositories/ai-session.repository.port';
import type { User } from '@/domain/user/user.entity';
import { fromTrackResponse } from '@/application/dto/playlist-response.dto';
import {
  findReadableAiSession,
  remainingTtlMs,
  requireGeneratedResult,
} from '@/application/services/ai-session-access';
import {
  aiErrorCode,
  logAiDiagnostic,
  traceAiOperation,
  type AiOperationTrace,
} from '@/application/services/ai-observability';
import {
  SpotifyPublicationRunner,
  type DestinationStore,
  type PublicationOutcomeEvent,
} from '@/application/services/spotify-publication.runner';
import type { AiSessionCommandResult } from './create-ai-session.use-case';

export interface PublishAiPlaylistCommand {
  token: string;
  userId: string;
  name: string;
  coverImageBase64?: string;
  persistToLibrary: boolean;
}

@Injectable()
export class PublishAiPlaylistUseCase {
  constructor(
    @Inject(AI_SESSION_REPOSITORY)
    private readonly sessions: AiSessionRepositoryPort,
    private readonly runner: SpotifyPublicationRunner,
  ) {}

  execute(command: PublishAiPlaylistCommand): Promise<AiSessionCommandResult> {
    return traceAiOperation('destination_publish', (trace) =>
      this.publishTraced(command, trace),
    );
  }

  private async publishTraced(
    command: PublishAiPlaylistCommand,
    trace: AiOperationTrace,
  ): Promise<AiSessionCommandResult> {
    const store = new AiSessionDestinationStore(this.sessions, command);
    await this.runner.run({
      userId: command.userId,
      store,
      coverImageBase64: command.coverImageBase64,
      persistToLibrary: command.persistToLibrary,
      assertStartable: () => requireNoPendingRefinement(store.session),
      loadPlaylist: (user) => {
        requireNoPendingRefinement(store.session);
        return toPlaylist(
          requireGeneratedResult(store.session),
          user,
          command.name,
        );
      },
      inProgressError: () => AiSessionError.destinationInProgress(),
      onOutcome: (event) => recordOutcome(trace, event),
      onDiagnostic: (event, error) =>
        logAiDiagnostic('destination_publish', event, error),
    });
    return { token: command.token, session: store.session };
  }
}

class AiSessionDestinationStore implements DestinationStore {
  private current: AiSession | null = null;
  private previous: AiSessionDestination | null = null;

  constructor(
    private readonly sessions: AiSessionRepositoryPort,
    private readonly command: { token: string; userId: string },
  ) {}

  get session(): AiSession {
    if (!this.current) {
      throw AiSessionError.notFound();
    }
    return this.current;
  }

  async read(): Promise<SpotifyDestination | null> {
    this.current = await this.find();
    requireGeneratedResult(this.current);
    return spotifyDestinationOf(this.current);
  }

  acquireClaim(ttlMs: number): Promise<string | null> {
    return this.sessions.acquireDestinationClaim(this.command.token, ttlMs);
  }

  renewClaim(claimId: string, ttlMs: number): Promise<boolean> {
    return this.sessions.renewDestinationClaim(
      this.command.token,
      claimId,
      ttlMs,
    );
  }

  releaseClaim(claimId: string): Promise<void> {
    return this.sessions.releaseDestinationClaim(this.command.token, claimId);
  }

  async start(publishing: PublishingSpotifyDestination): Promise<boolean> {
    const current = this.session;
    const ttlMs = remainingTtlMs(current);
    if (ttlMs <= 0) {
      throw AiSessionError.notFound();
    }
    const started = withDestination(current, publishing, new Date());
    this.previous = current.destination;
    if (
      await this.sessions.savePublishStart(
        this.command.token,
        started,
        current.updatedAt,
        ttlMs,
      )
    ) {
      this.current = started;
      return true;
    }
    requireNoPendingRefinement(await this.find());
    return false;
  }

  saveOutcome(
    destination: SpotifyDestination,
    attemptId: string,
  ): Promise<boolean> {
    return this.write(destination, attemptId);
  }

  restore(attemptId: string): Promise<boolean> {
    return this.write(this.previous, attemptId);
  }

  private async write(
    destination: AiSessionDestination | null,
    attemptId: string,
  ): Promise<boolean> {
    const next = withDestination(this.session, destination, new Date());
    this.current = next;
    const ttlMs = remainingTtlMs(next);
    if (ttlMs <= 0) {
      return true;
    }
    return this.sessions.savePublishOutcome(
      this.command.token,
      next,
      attemptId,
      ttlMs,
    );
  }

  private find(): Promise<AiSession> {
    return findReadableAiSession(
      this.sessions,
      this.command.token,
      this.command.userId,
    );
  }
}

function spotifyDestinationOf(session: AiSession): SpotifyDestination | null {
  const destination = currentDestination(session, new Date());
  return destination?.status === 'transfer_prepared' ? null : destination;
}

function recordOutcome(
  trace: AiOperationTrace,
  event: PublicationOutcomeEvent,
): void {
  const fields = {
    intentKind: event.playlistKind,
    trackCount: event.trackCount,
  };
  switch (event.outcome) {
    case 'reused':
      trace.record('reused');
      return;
    case 'interrupted':
      trace.record('publish_incomplete');
      return;
    case 'superseded':
      trace.record('superseded', fields);
      return;
    case 'published':
      trace.record('published', {
        ...fields,
        savedToLibrary: event.savedToLibrary,
      });
      return;
    case 'publish_incomplete':
      trace.record('publish_incomplete', {
        ...fields,
        errorCode: aiErrorCode(event.error),
        spotifyPlaylistCreated: event.spotifyPlaylistCreated,
      });
      return;
  }
}

function requireNoPendingRefinement(session: AiSession): void {
  if (session.pendingRefinement !== null) {
    throw AiSessionError.destinationBlockedByRefinement();
  }
}

function toPlaylist(
  result: AiGenerationResult,
  user: User,
  name: string,
): Playlist {
  return Playlist.create({
    id: randomUUID(),
    userId: user.id,
    name,
    description: result.playlist.description,
    seeds: [...result.playlist.seeds],
    tracks: result.playlist.tracks.map(fromTrackResponse),
    generation: result.recipe,
  });
}
