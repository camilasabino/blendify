import type { PublishedPlaylist } from '@/application/services/publish-playlist.service';
import type { SpotifyPreviewPlaylist } from '@/domain/preview/spotify-preview';
import type { MusicProviderPort } from '@/domain/repositories/music-provider.port';
import type { UsageStatsRepositoryPort } from '@/domain/repositories/usage-stats.repository.port';
import type { UserRepositoryPort } from '@/domain/repositories/user.repository.port';
import { User } from '@/domain/user/user.entity';
import {
  RedisCacheService,
  type CoordinationFallback,
} from '@/infrastructure/cache/redis-cache.service';
import type { RedisConnection } from '@/infrastructure/cache/redis-connection';
import { RedisSpotifyPreviewRepository } from '@/infrastructure/preview/redis-spotify-preview.repository';
import type { PublishPlaylistService } from '@/application/services/publish-playlist.service';
import { SpotifyPublicationRunner } from '@/application/services/spotify-publication.runner';
import { CreateSpotifyPreviewUseCase } from './create-spotify-preview.use-case';
import { GetSpotifyPreviewUseCase } from './get-spotify-preview.use-case';
import { SaveSpotifyPreviewUseCase } from './save-spotify-preview.use-case';
import type { GeneratePlaylistUseCase } from './generate-playlist.use-case';

export const OWNER = User.create({
  id: 'user-1',
  spotifyId: 'spotify-user-1',
  displayName: 'Listener',
});
export const REMOTE = {
  id: 'sp-1',
  url: 'https://open.spotify.com/playlist/sp-1',
};

export const TRACK_URIS = [
  'spotify:track:z',
  'spotify:track:a',
  'spotify:track:m',
];

export function previewPlaylist(): SpotifyPreviewPlaylist {
  return {
    name: 'Blendify · Mix · Sade',
    description: 'Made with Blendify from Sade.',
    generation: {
      version: 1,
      kind: 'artist_mix',
      filters: {
        region: null,
        femaleVocals: false,
        releaseRange: null,
        excludeLive: false,
      },
      tracksPerSeed: 3,
      seeds: [{ id: 'sade', name: 'Sade' }],
      popularity: 'balanced',
      orderMode: 'random',
    },
    seeds: [{ type: 'artist', id: 'sade', name: 'Sade' }],
    tracks: TRACK_URIS.map((uri, index) => ({
      id: uri.split(':')[2],
      name: `Song ${index}`,
      artistId: 'sade',
      artistName: 'Sade',
      durationMs: 200_000,
      popularity: 40,
      uri,
    })),
  };
}

export function unavailableConnection(): RedisConnection {
  return { readyClient: () => null } as unknown as RedisConnection;
}

export function memoryPreviewRepository(
  fallback: CoordinationFallback = 'memory',
): RedisSpotifyPreviewRepository {
  return new RedisSpotifyPreviewRepository(
    new RedisCacheService(unavailableConnection(), fallback),
  );
}

type PublishInput = Parameters<PublishPlaylistService['execute']>[0];

export function createPreviewWorld(
  repository: RedisSpotifyPreviewRepository = memoryPreviewRepository(),
) {
  const publish = jest.fn((input: PublishInput) =>
    (async () => {
      await input.onRemotePlaylistCreated?.(REMOTE);
      return {
        spotifyId: REMOTE.id,
        spotifyUrl: REMOTE.url,
      } as PublishedPlaylist;
    })(),
  );
  const quota = { consume: jest.fn(() => Promise.resolve()) };
  const usageStats = { recordMix: jest.fn(() => Promise.resolve()) };
  const users = {
    findById: jest.fn((id: string) =>
      Promise.resolve<User | null>(id === OWNER.id ? OWNER : null),
    ),
  };
  const providers = { forUser: jest.fn(() => ({}) as MusicProviderPort) };
  const runner = new SpotifyPublicationRunner(
    { execute: publish } as unknown as PublishPlaylistService,
    quota,
    usageStats as unknown as UsageStatsRepositoryPort,
    users as unknown as UserRepositoryPort,
    providers,
  );
  const get = new GetSpotifyPreviewUseCase(repository);
  const save = new SaveSpotifyPreviewUseCase(repository, runner);

  return {
    repository,
    publish,
    quota,
    usageStats,
    users,
    providers,
    get,
    save,
    create: (generator: Pick<GeneratePlaylistUseCase, 'execute'>) =>
      new CreateSpotifyPreviewUseCase(
        generator as GeneratePlaylistUseCase,
        repository,
      ),
    runner,
    userRepository: users as unknown as UserRepositoryPort,
  };
}

export function deferredPublish(world: ReturnType<typeof createPreviewWorld>) {
  const pending: Array<{
    input: PublishInput;
    succeed: () => void;
    fail: (error: unknown) => void;
    createRemote: () => Promise<void>;
  }> = [];
  world.publish.mockImplementation(
    (input: PublishInput) =>
      new Promise<PublishedPlaylist>((resolve, reject) => {
        pending.push({
          input,
          createRemote: () =>
            input.onRemotePlaylistCreated?.(REMOTE) ?? Promise.resolve(),
          succeed: () =>
            resolve({
              spotifyId: REMOTE.id,
              spotifyUrl: REMOTE.url,
            } as PublishedPlaylist),
          fail: reject,
        });
      }),
  );
  return pending;
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
