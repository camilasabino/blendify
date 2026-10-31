import type { PublishedPlaylist } from '@/application/services/publish-playlist.service';
import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import { PlaylistPublishIncompleteError } from '@/domain/errors/playlist-publish-incomplete.error';
import { ProviderOutcomeUnknownError } from '@/domain/errors/provider-outcome-unknown.error';
import { SpotifyProviderError } from '@/domain/errors/spotify-provider.error';
import { Playlist } from '@/domain/playlist/playlist.entity';
import type {
  PublishingSpotifyDestination,
  SpotifyDestination,
} from '@/domain/publication/spotify-destination';
import type {
  MusicProviderPort,
  ProviderPlaylist,
} from '@/domain/repositories/music-provider.port';
import type { UsageStatsRepositoryPort } from '@/domain/repositories/usage-stats.repository.port';
import type { UserRepositoryPort } from '@/domain/repositories/user.repository.port';
import { User } from '@/domain/user/user.entity';
import { fromTrackResponse } from '@/application/dto/playlist-response.dto';
import {
  DESTINATION_LEASE_MS,
  DESTINATION_LEASE_RENEW_INTERVAL_MS,
} from './destination-lease.policy';
import type { PublishPlaylistService } from './publish-playlist.service';
import {
  SpotifyPublicationRunner,
  type DestinationStore,
  type PublicationOutcomeEvent,
  type SpotifyPublicationRequest,
} from './spotify-publication.runner';

const USER = User.create({
  id: 'user-1',
  spotifyId: 'spotify-user-1',
  displayName: 'Listener',
});
const REMOTE: ProviderPlaylist = { id: 'p1', url: 'https://sp/p1' };

class InProgress extends Error {}

class FakeDestinationStore implements DestinationStore {
  record: SpotifyDestination | null = null;
  claim: { id: string; expiresAt: number } | null = null;
  startFailure: 'reject' | 'applied_then_reject' | null = null;
  outcomeFailure: Error | null = null;
  private claims = 0;

  read = jest.fn(() => Promise.resolve(this.record));

  acquireClaim = jest.fn((ttlMs: number) => {
    if (this.liveClaim()) {
      return Promise.resolve(null);
    }
    this.claims += 1;
    this.claim = { id: `claim-${this.claims}`, expiresAt: Date.now() + ttlMs };
    return Promise.resolve<string | null>(this.claim.id);
  });

  renewClaim = jest.fn((claimId: string, ttlMs: number) => {
    const claim = this.liveClaim();
    if (claim?.id !== claimId) {
      return Promise.resolve(false);
    }
    claim.expiresAt = Date.now() + ttlMs;
    return Promise.resolve(true);
  });

  releaseClaim = jest.fn((claimId: string) => {
    if (this.liveClaim()?.id === claimId) {
      this.claim = null;
    }
    return Promise.resolve();
  });

  start = jest.fn((publishing: PublishingSpotifyDestination) => {
    if (this.startFailure === 'reject') {
      return Promise.reject(new CoordinationUnavailableError());
    }
    if (this.record !== null) {
      return Promise.resolve(false);
    }
    this.record = publishing;
    if (this.startFailure === 'applied_then_reject') {
      return Promise.reject(new CoordinationUnavailableError());
    }
    return Promise.resolve(true);
  });

  saveOutcome = jest.fn(
    (destination: SpotifyDestination, attemptId: string) => {
      if (this.outcomeFailure) {
        return Promise.reject(this.outcomeFailure);
      }
      if (!this.ownedBy(attemptId)) {
        return Promise.resolve(false);
      }
      this.record = destination;
      return Promise.resolve(true);
    },
  );

  restore = jest.fn((attemptId: string) => {
    if (!this.ownedBy(attemptId)) {
      return Promise.resolve(false);
    }
    this.record = null;
    return Promise.resolve(true);
  });

  loseClaim(): void {
    this.claim = null;
  }

  private ownedBy(attemptId: string): boolean {
    return (
      this.record?.status === 'publishing' &&
      this.record.attemptId === attemptId
    );
  }

  private liveClaim() {
    if (this.claim && this.claim.expiresAt <= Date.now()) {
      this.claim = null;
    }
    return this.claim;
  }
}

type PublishInput = Parameters<PublishPlaylistService['execute']>[0];

interface PendingPublish {
  input: PublishInput;
  createRemote: () => Promise<void>;
  succeed: (detail?: Partial<PublishedPlaylist>) => void;
  fail: (error: unknown) => void;
}

function playlist(): Playlist {
  return Playlist.create({
    id: 'local-1',
    userId: USER.id,
    name: 'Saved name',
    description: 'Made with Blendify.',
    seeds: [{ type: 'artist', id: 'a1', name: 'Artist' }],
    tracks: [
      fromTrackResponse({
        id: 't1',
        name: 'Song',
        artistId: 'a1',
        artistName: 'Artist',
        durationMs: 200_000,
        popularity: 50,
        uri: 'spotify:track:t1',
      }),
    ],
    generation: {
      version: 1,
      kind: 'artist_mix',
      filters: {
        region: null,
        femaleVocals: false,
        releaseRange: null,
        excludeLive: false,
      },
      tracksPerSeed: 1,
      seeds: [{ id: 'a1', name: 'Artist' }],
      popularity: 'balanced',
      orderMode: 'random',
    },
  });
}

function setup() {
  const store = new FakeDestinationStore();
  const pending: PendingPublish[] = [];
  const publish = jest.fn(
    (input: PublishInput) =>
      new Promise<PublishedPlaylist>((resolve, reject) => {
        pending.push({
          input,
          createRemote: () =>
            input.onRemotePlaylistCreated?.(REMOTE) ?? Promise.resolve(),
          succeed: (detail = {}) =>
            resolve({
              spotifyId: REMOTE.id,
              spotifyUrl: REMOTE.url,
              ...detail,
            } as PublishedPlaylist),
          fail: reject,
        });
      }),
  );
  const quota = { consume: jest.fn(() => Promise.resolve()) };
  const usageStats = { recordMix: jest.fn(() => Promise.resolve()) };
  const users = { findById: jest.fn(() => Promise.resolve<User | null>(USER)) };
  const providers = { forUser: jest.fn(() => ({}) as MusicProviderPort) };
  const runner = new SpotifyPublicationRunner(
    { execute: publish } as unknown as PublishPlaylistService,
    quota,
    usageStats as unknown as UsageStatsRepositoryPort,
    users as unknown as UserRepositoryPort,
    providers,
  );
  const events: PublicationOutcomeEvent[] = [];
  const diagnostics: string[] = [];
  const loadPlaylist = jest.fn(() => playlist());
  const request: SpotifyPublicationRequest = {
    userId: USER.id,
    store,
    persistToLibrary: true,
    coverImageBase64: 'cover',
    loadPlaylist,
    inProgressError: () => new InProgress(),
    onOutcome: (event) => events.push(event),
    onDiagnostic: (event) => diagnostics.push(event),
  };
  return {
    runner,
    request,
    store,
    publish,
    pending,
    quota,
    usageStats,
    users,
    providers,
    loadPlaylist,
    events,
    diagnostics,
    run: () => runner.run(request),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function spotifyRejection(): SpotifyProviderError {
  return new SpotifyProviderError('SPOTIFY_REQUEST_REJECTED', {
    operation: 'createPlaylist',
    category: 'rejected',
    status: 400,
  });
}

describe('SpotifyPublicationRunner', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('a successful attempt', () => {
    it('publishes the loaded playlist once, records the link before tracks, then settles as published', async () => {
      const world = setup();

      const running = world.run();
      await flush();
      expect(world.store.record).toMatchObject({
        status: 'publishing',
        spotifyPlaylist: null,
      });
      await world.pending[0].createRemote();
      expect(world.store.record).toMatchObject({
        status: 'publishing',
        spotifyPlaylist: { spotifyId: 'p1', spotifyUrl: 'https://sp/p1' },
      });
      world.pending[0].succeed();

      const result = await running;

      expect(result).toEqual({
        outcome: 'published',
        destination: {
          status: 'published',
          publishedAt: expect.any(String),
          spotifyPlaylist: { spotifyId: 'p1', spotifyUrl: 'https://sp/p1' },
          savedToLibrary: true,
          coverUploadFailed: false,
        },
      });
      expect(world.store.record).toEqual(result.destination);
      expect(world.publish).toHaveBeenCalledTimes(1);
      const input = world.pending[0].input;
      expect(input.spotifyUserId).toBe('spotify-user-1');
      expect(input.coverImageBase64).toBe('cover');
      expect(input.persistToLibrary).toBe(true);
      expect(input.playlist.tracks.map((track) => track.uri)).toEqual([
        'spotify:track:t1',
      ]);
      expect(world.quota.consume).toHaveBeenCalledWith('user-1');
      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
      expect(world.store.claim).toBeNull();
      expect(world.events.map((event) => event.outcome)).toEqual(['published']);
    });

    it('keeps a cover upload failure as a successful publication', async () => {
      const world = setup();

      const running = world.run();
      await flush();
      world.pending[0].succeed({ coverUploadFailed: true });

      await expect(running).resolves.toMatchObject({
        outcome: 'published',
        destination: { status: 'published', coverUploadFailed: true },
      });
    });

    it('keeps the publication when usage stats cannot be recorded', async () => {
      const world = setup();
      world.usageStats.recordMix.mockRejectedValueOnce(new Error('db down'));

      const running = world.run();
      await flush();
      world.pending[0].succeed();

      await expect(running).resolves.toMatchObject({ outcome: 'published' });
      expect(world.diagnostics).toContain('usage_not_recorded');
    });
  });

  describe('outcome reuse', () => {
    it.each([
      [
        'published',
        {
          status: 'published',
          publishedAt: '2026-10-30T12:00:00.000Z',
          spotifyPlaylist: { spotifyId: 'p1', spotifyUrl: 'https://sp/p1' },
          savedToLibrary: false,
          coverUploadFailed: false,
        },
      ],
      [
        'incomplete',
        {
          status: 'publish_incomplete',
          failedAt: '2026-10-30T12:00:00.000Z',
          spotifyPlaylist: null,
          reason: 'outcome_unknown',
        },
      ],
    ] satisfies [string, SpotifyDestination][])(
      'returns a %s outcome without claiming, charging quota or calling Spotify',
      async (_label, settled) => {
        const world = setup();
        world.store.record = settled;

        await expect(world.run()).resolves.toEqual({
          outcome: 'reused',
          destination: settled,
        });
        expect(world.store.acquireClaim).not.toHaveBeenCalled();
        expect(world.users.findById).not.toHaveBeenCalled();
        expect(world.quota.consume).not.toHaveBeenCalled();
        expect(world.publish).not.toHaveBeenCalled();
        expect(world.usageStats.recordMix).not.toHaveBeenCalled();
      },
    );

    it('returns an outcome that settled while it waited for the claim', async () => {
      const world = setup();
      const settled: SpotifyDestination = {
        status: 'publish_incomplete',
        failedAt: '2026-10-30T12:00:00.000Z',
        spotifyPlaylist: null,
        reason: 'outcome_unknown',
      };
      world.store.read
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(settled);

      await expect(world.run()).resolves.toEqual({
        outcome: 'reused',
        destination: settled,
      });
      expect(world.quota.consume).not.toHaveBeenCalled();
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.store.claim).toBeNull();
    });
  });

  describe('concurrency and claims', () => {
    it('rejects a concurrent attempt while the claim is held, without charging quota', async () => {
      const world = setup();

      const first = world.run();
      await flush();
      await expect(world.run()).rejects.toBeInstanceOf(InProgress);
      world.pending[0].succeed();
      await first;

      expect(world.publish).toHaveBeenCalledTimes(1);
      expect(world.quota.consume).toHaveBeenCalledTimes(1);
    });

    it('lets many simultaneous attempts reach Spotify at most once', async () => {
      const world = setup();

      const attempts = Promise.allSettled(
        Array.from({ length: 5 }, () => world.run()),
      );
      await flush();
      world.pending[0].succeed();
      const results = await attempts;

      expect(world.publish).toHaveBeenCalledTimes(1);
      expect(world.quota.consume).toHaveBeenCalledTimes(1);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === 'rejected' && result.reason instanceof InProgress,
        ),
      ).toHaveLength(4);
    });

    it('renews its lease while Spotify is slow and stays authoritative', async () => {
      const world = setup();

      const running = world.run();
      await flush();
      await jest.advanceTimersByTimeAsync(5 * DESTINATION_LEASE_MS);

      expect(world.store.renewClaim).toHaveBeenCalledWith(
        'claim-1',
        DESTINATION_LEASE_MS,
      );
      await expect(world.run()).rejects.toBeInstanceOf(InProgress);
      world.pending[0].succeed();
      await expect(running).resolves.toMatchObject({ outcome: 'published' });
    });

    it('settles an abandoned attempt as interrupted once its claim expired, without quota or Spotify', async () => {
      const world = setup();
      world.store.record = {
        status: 'publishing',
        attemptId: 'attempt-dead',
        startedAt: '2026-10-30T12:00:00.000Z',
        spotifyPlaylist: { spotifyId: 'p0', spotifyUrl: 'https://sp/p0' },
      };

      const result = await world.run();

      expect(result).toEqual({
        outcome: 'interrupted',
        destination: {
          status: 'publish_incomplete',
          failedAt: expect.any(String),
          spotifyPlaylist: { spotifyId: 'p0', spotifyUrl: 'https://sp/p0' },
          reason: 'interrupted',
        },
      });
      expect(world.store.record).toEqual(result.destination);
      expect(world.quota.consume).not.toHaveBeenCalled();
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.loadPlaylist).not.toHaveBeenCalled();
    });

    it('refuses to start after losing its lease, without calling Spotify', async () => {
      const world = setup();
      world.quota.consume.mockImplementationOnce(async () => {
        world.store.loseClaim();
        await jest.advanceTimersByTimeAsync(
          DESTINATION_LEASE_RENEW_INTERVAL_MS,
        );
      });

      await expect(world.run()).rejects.toBeInstanceOf(InProgress);
      expect(world.diagnostics).toContain('lease_lost');
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.store.record).toBeNull();
    });

    it('refuses to start when a destination appeared between the re-read and the start', async () => {
      const world = setup();
      world.quota.consume.mockImplementationOnce(() => {
        world.store.record = {
          status: 'publishing',
          attemptId: 'attempt-other',
          startedAt: '2026-10-30T12:00:00.000Z',
          spotifyPlaylist: null,
        };
        return Promise.resolve();
      });

      await expect(world.run()).rejects.toBeInstanceOf(InProgress);
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.store.record).toMatchObject({ attemptId: 'attempt-other' });
    });

    it('cannot overwrite a newer settlement after its lease was lost', async () => {
      const world = setup();
      const stale = world.run();
      await flush();
      await world.pending[0].createRemote();
      world.store.loseClaim();
      await jest.advanceTimersByTimeAsync(DESTINATION_LEASE_RENEW_INTERVAL_MS);
      const newer = await world.run();

      world.pending[0].succeed();

      await expect(stale).resolves.toEqual({
        outcome: 'superseded',
        destination: newer.destination,
      });
      expect(newer.outcome).toBe('interrupted');
      expect(world.store.record).toEqual(newer.destination);
      expect(world.publish).toHaveBeenCalledTimes(1);
    });

    it('cannot release a claim that now belongs to another owner', async () => {
      const world = setup();
      const stale = world.run();
      await flush();
      world.store.loseClaim();
      await jest.advanceTimersByTimeAsync(DESTINATION_LEASE_RENEW_INTERVAL_MS);
      const newer = await world.store.acquireClaim(DESTINATION_LEASE_MS);

      world.pending[0].succeed();
      await stale;

      expect(world.store.claim?.id).toBe(newer);
    });
  });

  describe('pre-request failures', () => {
    it('rejects an unknown user before claiming anything', async () => {
      const world = setup();
      world.users.findById.mockResolvedValueOnce(null);

      await expect(world.run()).rejects.toMatchObject({
        code: 'USER_NOT_FOUND',
      });
      expect(world.store.acquireClaim).not.toHaveBeenCalled();
      expect(world.quota.consume).not.toHaveBeenCalled();
    });

    it('starts no attempt when the quota rejects, and releases the claim', async () => {
      const world = setup();
      const limited = new Error('RATE_LIMITED');
      world.quota.consume.mockRejectedValueOnce(limited);

      await expect(world.run()).rejects.toBe(limited);
      expect(world.store.record).toBeNull();
      expect(world.store.start).not.toHaveBeenCalled();
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.store.claim).toBeNull();
    });

    it('charges no quota when the playlist cannot be loaded under the claim', async () => {
      const world = setup();
      const gone = new Error('PREVIEW_NOT_FOUND');
      world.loadPlaylist.mockImplementationOnce(() => {
        throw gone;
      });

      await expect(world.run()).rejects.toBe(gone);
      expect(world.quota.consume).not.toHaveBeenCalled();
      expect(world.store.claim).toBeNull();
    });

    it('fails closed when the coordination store cannot record the start', async () => {
      const world = setup();
      world.store.startFailure = 'reject';

      await expect(world.run()).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.store.record).toBeNull();
      expect(world.store.claim).toBeNull();
    });

    it('rolls back a start that was applied before the store reported a failure', async () => {
      const world = setup();
      world.store.startFailure = 'applied_then_reject';

      await expect(world.run()).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
      expect(world.store.restore).toHaveBeenCalledTimes(1);
      expect(world.store.record).toBeNull();
      expect(world.publish).not.toHaveBeenCalled();
    });
  });

  describe('failure classes', () => {
    it('frees the destination after a confirmed rejection so a later attempt can retry and is charged again', async () => {
      const world = setup();
      const first = world.run();
      await flush();
      world.pending[0].fail(spotifyRejection());

      await expect(first).rejects.toBeInstanceOf(SpotifyProviderError);
      expect(world.store.record).toBeNull();
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();

      const retry = world.run();
      await flush();
      world.pending[1].succeed();
      await expect(retry).resolves.toMatchObject({ outcome: 'published' });
      expect(world.quota.consume).toHaveBeenCalledTimes(2);
    });

    it.each([
      [
        'an unknown provider outcome',
        new ProviderOutcomeUnknownError('timeout'),
      ],
      ['an unexpected error', new Error('socket hang up')],
      ['an unexpected TypeError', new TypeError('x is undefined')],
    ])(
      'settles %s on create as outcome_unknown and never publishes again',
      async (_label, error) => {
        const world = setup();
        const first = world.run();
        await flush();
        world.pending[0].fail(error);

        const result = await first;
        const replay = await world.run();

        expect(result.destination).toEqual({
          status: 'publish_incomplete',
          failedAt: expect.any(String),
          spotifyPlaylist: null,
          reason: 'outcome_unknown',
        });
        expect(replay).toEqual({
          outcome: 'reused',
          destination: result.destination,
        });
        expect(world.publish).toHaveBeenCalledTimes(1);
        expect(world.store.restore).not.toHaveBeenCalled();
        expect(world.usageStats.recordMix).not.toHaveBeenCalled();
        expect(world.events[0]).toMatchObject({
          outcome: 'publish_incomplete',
          reason: 'outcome_unknown',
          spotifyPlaylistCreated: false,
        });
      },
    );

    it('settles a failure after creation as tracks_incomplete with the link, even for a rejection', async () => {
      const world = setup();
      const first = world.run();
      await flush();
      await world.pending[0].createRemote();
      world.pending[0].fail(
        new PlaylistPublishIncompleteError(
          {
            spotifyId: 'p1',
            spotifyUrl: 'https://sp/p1',
            failedStep: 'add_tracks',
            tracksAdded: 'none',
          },
          { cause: spotifyRejection() },
        ),
      );

      await expect(first).resolves.toEqual({
        outcome: 'publish_incomplete',
        destination: {
          status: 'publish_incomplete',
          failedAt: expect.any(String),
          spotifyPlaylist: { spotifyId: 'p1', spotifyUrl: 'https://sp/p1' },
          reason: 'tracks_incomplete',
        },
      });
      await world.run();
      expect(world.publish).toHaveBeenCalledTimes(1);
    });

    it('settles a Library failure as library_not_saved with the link', async () => {
      const world = setup();
      const first = world.run();
      await flush();
      await world.pending[0].createRemote();
      world.pending[0].fail(
        new PlaylistPublishIncompleteError({
          spotifyId: 'p1',
          spotifyUrl: 'https://sp/p1',
          failedStep: 'save_to_library',
          tracksAdded: 'all',
        }),
      );

      await expect(first).resolves.toMatchObject({
        destination: {
          reason: 'library_not_saved',
          spotifyPlaylist: { spotifyId: 'p1' },
        },
      });
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();
    });
  });

  describe('outcome persistence failures', () => {
    it('reports the publication when its outcome cannot be persisted, and the stuck attempt later settles as interrupted', async () => {
      const world = setup();
      const first = world.run();
      await flush();
      await world.pending[0].createRemote();
      world.store.outcomeFailure = new CoordinationUnavailableError();
      world.pending[0].succeed();

      await expect(first).resolves.toMatchObject({ outcome: 'published' });
      expect(world.diagnostics).toContain('state_not_persisted');
      expect(world.store.record).toMatchObject({ status: 'publishing' });

      world.store.outcomeFailure = null;
      const later = await world.run();

      expect(later).toMatchObject({
        outcome: 'interrupted',
        destination: {
          reason: 'interrupted',
          spotifyPlaylist: { spotifyId: 'p1' },
        },
      });
      expect(world.publish).toHaveBeenCalledTimes(1);
      expect(world.quota.consume).toHaveBeenCalledTimes(1);
    });

    it('keeps the destination blocked when a confirmed rejection cannot be rolled back', async () => {
      const world = setup();
      world.store.restore.mockRejectedValueOnce(
        new CoordinationUnavailableError(),
      );
      const first = world.run();
      await flush();
      world.pending[0].fail(spotifyRejection());

      await expect(first).rejects.toBeInstanceOf(SpotifyProviderError);
      expect(world.store.record).toMatchObject({ status: 'publishing' });

      await expect(world.run()).resolves.toMatchObject({
        outcome: 'interrupted',
      });
      expect(world.publish).toHaveBeenCalledTimes(1);
    });
  });
});
