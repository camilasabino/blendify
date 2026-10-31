import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import {
  SpotifyPreviewSchema,
  SpotifyPreviewStateSchema,
  SpotifyPreviewStreamEventSchema,
  type SpotifyPreviewDto,
  type SpotifyPreviewStreamEvent,
} from '@blendify/contracts';
import { GenreTrackCatalogService } from '@/application/services/genre-track-catalog.service';
import { PublishPlaylistService } from '@/application/services/publish-playlist.service';
import { SpotifyPublicationRunner } from '@/application/services/spotify-publication.runner';
import { CreateSpotifyPreviewUseCase } from '@/application/use-cases/create-spotify-preview.use-case';
import { GenerateArtistMixUseCase } from '@/application/use-cases/generate-artist-mix.use-case';
import { GenerateDiscoverPlaylistUseCase } from '@/application/use-cases/generate-discover-playlist.use-case';
import { GenerateGenreMixUseCase } from '@/application/use-cases/generate-genre-mix.use-case';
import { GeneratePlaylistUseCase } from '@/application/use-cases/generate-playlist.use-case';
import { GetSpotifyPreviewUseCase } from '@/application/use-cases/get-spotify-preview.use-case';
import { SaveSpotifyPreviewUseCase } from '@/application/use-cases/save-spotify-preview.use-case';
import { memoryPreviewRepository } from '@/application/use-cases/spotify-preview-world.testing';
import { Artist } from '@/domain/artist/artist.entity';
import { BusinessRuleError } from '@/domain/errors/business-rule.error';
import { CatalogUnavailableError } from '@/domain/errors/catalog-unavailable.error';
import { ProviderOutcomeUnknownError } from '@/domain/errors/provider-outcome-unknown.error';
import { SpotifyProviderError } from '@/domain/errors/spotify-provider.error';
import { SpotifyReauthRequiredError } from '@/domain/errors/spotify-reauth-required.error';
import type { Playlist } from '@/domain/playlist/playlist.entity';
import {
  DISCOVERY_CATALOG,
  type DiscoveryArtistIdentity,
} from '@/domain/repositories/discovery-catalog.port';
import { MUSIC_PROVIDER_FACTORY } from '@/domain/repositories/music-provider.factory.port';
import {
  CATALOG_PROVIDER_FACTORY,
  type ResolveTrackOptions,
} from '@/domain/repositories/catalog-provider.port';
import { PLAYLIST_REPOSITORY } from '@/domain/repositories/playlist.repository.port';
import { PROVIDER_QUOTA } from '@/domain/repositories/provider-quota.port';
import { SPOTIFY_PREVIEW_REPOSITORY } from '@/domain/repositories/spotify-preview.repository.port';
import { USAGE_STATS_REPOSITORY } from '@/domain/repositories/usage-stats.repository.port';
import { USER_REPOSITORY } from '@/domain/repositories/user.repository.port';
import { Track } from '@/domain/track/track.entity';
import { User } from '@/domain/user/user.entity';
import { ArtistId } from '@/domain/value-objects/artist-id.vo';
import { TrackId } from '@/domain/value-objects/track-id.vo';
import { JwtAuthGuard } from '@/infrastructure/auth/jwt-auth.guard';
import { GlobalExceptionFilter } from '@/presentation/filters/global-exception.filter';
import { inMemoryRequestLimitProviders } from '@/presentation/request-limits/request-limits.testing';
import { listenOnLoopback } from '@/presentation/http/loopback.testing';
import { PreviewsController } from './previews.controller';

const SPOTIFY_PLAYLIST = {
  id: 'spotify-playlist-1',
  url: 'https://open.spotify.com/playlist/spotify-playlist-1',
  imageUrl: 'https://images.example/spotify-cover.jpg',
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/(^-)|(-$)/g, '');
}

function makeArtist(name: string): Artist {
  return Artist.create({
    id: ArtistId.create(slug(name)),
    name,
    imageUrl: `https://images.example/${slug(name)}.jpg`,
  });
}

function makeTrack(artistName: string, trackName: string): Track {
  const id = `${slug(artistName)}--${slug(trackName)}`;
  const popularity =
    [...id].reduce((sum, char) => sum + char.codePointAt(0)!, 0) % 90;
  return Track.create({
    id: TrackId.create(id),
    name: trackName,
    artistId: ArtistId.create(slug(artistName)),
    artistName,
    durationMs: 200_000,
    popularity: popularity + 5,
    uri: `spotify:track:${id}`,
    albumImageUrl: `https://images.example/album-${id}.jpg`,
  });
}

function chartFor(artistName: string, size = 20) {
  return Array.from({ length: size }, (_, index) => ({
    artistName,
    trackName: `${artistName} Song ${index + 1}`,
    rank: index + 1,
  }));
}

function createWorld() {
  const provider = {
    searchArtists: jest.fn((name: string) =>
      Promise.resolve([makeArtist(name)]),
    ),
    getArtistsByIds: jest.fn((ids: string[]) =>
      Promise.resolve(
        ids.map((id) =>
          makeArtist(id === 'sade' ? 'Sade' : id.replaceAll('-', ' ')),
        ),
      ),
    ),
    resolveTrack: jest.fn(
      (artistName: string, trackName: string, options?: ResolveTrackOptions) =>
        Promise.resolve(
          options?.artistId && options.artistId !== slug(artistName)
            ? null
            : makeTrack(artistName, trackName),
        ),
    ),
    searchTracks: jest.fn((query: string) => {
      const match = /^track:"(.+)" artist:"(.+)"$/.exec(query);
      return Promise.resolve(match ? [makeTrack(match[2], match[1])] : []);
    }),
    createPlaylist: jest.fn(() =>
      Promise.resolve({ id: SPOTIFY_PLAYLIST.id, url: SPOTIFY_PLAYLIST.url }),
    ),
    addTracksToPlaylist: jest.fn((_id: string, _uris: string[]) =>
      Promise.resolve(),
    ),
    uploadPlaylistCover: jest.fn(() => Promise.resolve()),
    getPlaylistSnapshot: jest.fn(() =>
      Promise.resolve({
        id: SPOTIFY_PLAYLIST.id,
        name: 'snapshot',
        url: SPOTIFY_PLAYLIST.url,
        trackCount: 0,
        totalDurationMs: 0,
        imageUrl: SPOTIFY_PLAYLIST.imageUrl,
      }),
    ),
  };

  const discovery = {
    isConfigured: jest.fn(() => true),
    getTopTracksForArtist: jest.fn((artist: DiscoveryArtistIdentity) =>
      Promise.resolve(chartFor(artist.name)),
    ),
    getSimilarArtists: jest.fn((name: string) =>
      Promise.resolve([
        { name },
        ...Array.from({ length: 15 }, (_, index) => ({
          name: `${name} Echo ${index + 1}`,
        })),
      ]),
    ),
    getSimilarTracks: jest.fn((artistName: string, trackName: string) =>
      Promise.resolve([
        { name: trackName, artistName },
        ...Array.from({ length: 30 }, (_, index) => ({
          name: `Neighbor Tune ${index + 1}`,
          artistName: `Neighbor ${(index % 6) + 1}`,
        })),
      ]),
    ),
    getTopTracksForTag: jest.fn((tag: string) =>
      Promise.resolve(
        Array.from({ length: 40 }, (_, index) => ({
          artistName: `${tag} Artist ${(index % 8) + 1}`,
          trackName: `${tag} Anthem ${index + 1}`,
          rank: index + 1,
        })),
      ),
    ),
    getTopArtistsForTag: jest.fn(
      (_tag: string): Promise<Array<{ name: string }>> => Promise.resolve([]),
    ),
    getTopTagsForArtist: jest.fn(
      (
        _artist: DiscoveryArtistIdentity,
      ): Promise<Array<{ name: string; count: number }>> => Promise.resolve([]),
    ),
  };

  const users = {
    findById: jest.fn((id: string) =>
      Promise.resolve(
        id === 'user-1'
          ? User.create({
              id: 'user-1',
              spotifyId: 'spotify-user-1',
              displayName: 'Listener',
            })
          : null,
      ),
    ),
  };

  const quota = { assertAvailable: jest.fn() };
  const usageStats = { recordMix: jest.fn(() => Promise.resolve()) };
  const playlists = {
    save: jest.fn((playlist: Playlist) => Promise.resolve(playlist)),
  };

  return { provider, discovery, users, quota, usageStats, playlists };
}

type World = ReturnType<typeof createWorld> & { userId: string };

async function createApp(world: World): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [PreviewsController],
    providers: [
      GenerateArtistMixUseCase,
      GenerateGenreMixUseCase,
      GenerateDiscoverPlaylistUseCase,
      GeneratePlaylistUseCase,
      CreateSpotifyPreviewUseCase,
      GetSpotifyPreviewUseCase,
      SaveSpotifyPreviewUseCase,
      SpotifyPublicationRunner,
      PublishPlaylistService,
      GenreTrackCatalogService,
      {
        provide: SPOTIFY_PREVIEW_REPOSITORY,
        useValue: memoryPreviewRepository(),
      },
      {
        provide: CATALOG_PROVIDER_FACTORY,
        useValue: { forMarket: () => world.provider },
      },
      {
        provide: MUSIC_PROVIDER_FACTORY,
        useValue: { forUser: () => world.provider },
      },
      { provide: PROVIDER_QUOTA, useValue: world.quota },
      { provide: DISCOVERY_CATALOG, useValue: world.discovery },
      { provide: USER_REPOSITORY, useValue: world.users },
      { provide: USAGE_STATS_REPOSITORY, useValue: world.usageStats },
      { provide: PLAYLIST_REPOSITORY, useValue: world.playlists },
      ...inMemoryRequestLimitProviders(),
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({
      canActivate(context: {
        switchToHttp(): { getRequest(): { user?: { id: string } } };
      }) {
        context.switchToHttp().getRequest().user = { id: world.userId };
        return true;
      },
    })
    .compile();

  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await listenOnLoopback(app);
  return app;
}

type NdjsonStream = {
  setEncoding(encoding: 'utf8'): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'end', listener: () => void): void;
};

function readNdjson(
  res: unknown,
  callback: (error: Error | null, body: string) => void,
): void {
  const stream = res as NdjsonStream;
  let data = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    data += chunk;
  });
  stream.on('end', () => callback(null, data));
}

function parseEvents(body: string): SpotifyPreviewStreamEvent[] {
  return body
    .split('\n')
    .filter(Boolean)
    .map((line) => SpotifyPreviewStreamEventSchema.parse(JSON.parse(line)));
}

function progressEvents(events: SpotifyPreviewStreamEvent[]) {
  return events.flatMap((event) => (event.type === 'progress' ? [event] : []));
}

function distinctPhases(events: SpotifyPreviewStreamEvent[]): string[] {
  return progressEvents(events)
    .map((event) => event.phase)
    .filter((phase, index, all) => phase !== all[index - 1]);
}

describe('Spotify Mode preview and save characterization', () => {
  let world: World;
  let app: INestApplication;

  beforeEach(async () => {
    world = { ...createWorld(), userId: 'user-1' };
    app = await createApp(world);
  });

  afterEach(async () => {
    await app.close();
  });

  function httpServer(): Server {
    return app.getHttpServer() as Server;
  }

  function previewRequest(path: 'mix' | 'discover', body: object) {
    return request(httpServer()).post(`/api/previews/${path}`).send(body);
  }

  async function preview(
    path: 'mix' | 'discover',
    body: object,
  ): Promise<SpotifyPreviewDto> {
    const response = await previewRequest(path, body).expect(201);
    return SpotifyPreviewSchema.parse(response.body);
  }

  function save(previewId: string, body: object = {}) {
    return request(httpServer())
      .post(`/api/previews/${previewId}/save`)
      .send({ name: 'Late night', persistToLibrary: true, ...body });
  }

  async function saved(previewId: string, body: object = {}) {
    const response = await save(previewId, body).expect(200);
    return SpotifyPreviewStateSchema.parse(response.body);
  }

  function publishedUris(): string[] {
    return world.provider.addTracksToPlaylist.mock.calls[0][1];
  }

  function expectNoSpotifyWrites() {
    expect(world.provider.createPlaylist).not.toHaveBeenCalled();
    expect(world.provider.addTracksToPlaylist).not.toHaveBeenCalled();
    expect(world.provider.uploadPlaylistCover).not.toHaveBeenCalled();
    expect(world.playlists.save).not.toHaveBeenCalled();
    expect(world.usageStats.recordMix).not.toHaveBeenCalled();
  }

  const artistMixBody = {
    kind: 'artist_mix',
    artistIds: ['sade', 'massive-attack'],
    artists: [
      { id: 'sade', name: 'Sade', imageUrl: 'https://images.example/sade.jpg' },
      {
        id: 'massive-attack',
        name: 'Massive Attack',
        imageUrl: 'https://images.example/massive-attack.jpg',
      },
    ],
    tracksPerSeed: 3,
    popularity: 'balanced',
  };

  describe('artist mix', () => {
    it('previews without writing, then saves the previewed tracks and records stats', async () => {
      const { playlist } = await preview('mix', artistMixBody);

      expect(playlist).toMatchObject({
        name: 'Blendify · Mix · Sade + Massive Attack',
        description: 'Made with Blendify from Sade and Massive Attack.',
        seeds: [
          {
            type: 'artist',
            id: 'sade',
            name: 'Sade',
            imageUrl: 'https://images.example/sade.jpg',
          },
          {
            type: 'artist',
            id: 'massive-attack',
            name: 'Massive Attack',
            imageUrl: 'https://images.example/massive-attack.jpg',
          },
        ],
        generation: {
          version: 1,
          kind: 'artist_mix',
          tracksPerSeed: 3,
          popularity: 'balanced',
          orderMode: 'random',
          seeds: [
            {
              id: 'sade',
              name: 'Sade',
              imageUrl: 'https://images.example/sade.jpg',
            },
            {
              id: 'massive-attack',
              name: 'Massive Attack',
              imageUrl: 'https://images.example/massive-attack.jpg',
            },
          ],
        },
      });
      expect(playlist.tracks).toHaveLength(6);
      expect(
        playlist.tracks.filter((track) => track.artistId === 'sade'),
      ).toHaveLength(3);
      expect(
        playlist.tracks.filter((track) => track.artistId === 'massive-attack'),
      ).toHaveLength(3);
      expectNoSpotifyWrites();
    });

    it('publishes the stored tracks with the saved name, records stats, and keeps the recipe', async () => {
      const { previewId, playlist } = await preview('mix', artistMixBody);

      const state = await saved(previewId);

      expect(state.destination).toEqual({
        status: 'published',
        spotifyUrl: SPOTIFY_PLAYLIST.url,
        savedToLibrary: true,
        spotifyId: SPOTIFY_PLAYLIST.id,
        coverUploadFailed: false,
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledWith({
        userId: 'spotify-user-1',
        name: 'Late night',
        description: playlist.description,
        isPublic: false,
      });
      expect(world.provider.addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(publishedUris()).toEqual(
        playlist.tracks.map((track) => track.uri),
      );
      expect(world.provider.uploadPlaylistCover).not.toHaveBeenCalled();
      const [libraryEntry] = world.playlists.save.mock.calls[0];
      expect(libraryEntry.generation).toEqual(playlist.generation);
      expect(world.usageStats.recordMix).toHaveBeenCalledWith({
        userId: 'user-1',
        kind: 'artist',
        seeds: [
          {
            kind: 'artist',
            seedKey: 'sade',
            name: 'Sade',
            imageUrl: 'https://images.example/sade.jpg',
          },
          {
            kind: 'artist',
            seedKey: 'massive-attack',
            name: 'Massive Attack',
            imageUrl: 'https://images.example/massive-attack.jpg',
          },
        ],
      });
    });

    it('keeps the custom description and order mode, uploads the cover, and skips the Library when not persisting', async () => {
      const { previewId, playlist } = await preview('mix', {
        ...artistMixBody,
        description: 'Slow and warm',
        orderMode: 'title',
      });
      expect(playlist).toMatchObject({
        description: 'Slow and warm',
        generation: { kind: 'artist_mix', orderMode: 'title' },
      });

      const state = await saved(previewId, {
        coverImageBase64: 'jpeg-data',
        persistToLibrary: false,
      });

      expect(state.destination).toMatchObject({
        status: 'published',
        savedToLibrary: false,
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Late night',
          description: 'Slow and warm',
        }),
      );
      expect(world.provider.uploadPlaylistCover).toHaveBeenCalledWith(
        SPOTIFY_PLAYLIST.id,
        'jpeg-data',
      );
      expect(world.playlists.save).not.toHaveBeenCalled();
      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
    });

    it('streams ordered progress phases that stop at the preview', async () => {
      const response = await previewRequest('mix', artistMixBody)
        .set('Accept', 'application/x-ndjson')
        .buffer(true)
        .parse(readNdjson)
        .expect(200);

      const events = parseEvents(response.body as string);
      expect(distinctPhases(events)).toEqual([
        'resolving_seeds',
        'matching_tracks',
      ]);
      const last = events.at(-1);
      expect(last?.type).toBe('result');
      if (last?.type === 'result') {
        expect(last.playlist.playlist).toMatchObject({
          generation: { kind: 'artist_mix' },
        });
        expect(last.playlist.playlist.tracks).toHaveLength(6);
      }
      expectNoSpotifyWrites();
    });

    it('keeps the published outcome when stats recording fails', async () => {
      world.usageStats.recordMix.mockRejectedValue(new Error('stats down'));
      const { previewId } = await preview('mix', artistMixBody);

      const state = await saved(previewId);

      expect(state.destination).toMatchObject({
        status: 'published',
        spotifyId: SPOTIFY_PLAYLIST.id,
      });
      expect(world.playlists.save).toHaveBeenCalledTimes(1);
    });

    it('fails without a preview when no tracks are found', async () => {
      world.discovery.getTopTracksForArtist.mockResolvedValue([]);

      const response = await previewRequest('mix', artistMixBody).expect(422);

      expect(response.body).toMatchObject({ code: 'NO_TRACKS_FOUND' });
      expectNoSpotifyWrites();
    });

    it('fails as unavailable, not as missing tracks, when the catalog cannot be reached', async () => {
      world.provider.resolveTrack.mockRejectedValue(
        new CatalogUnavailableError(),
      );

      const response = await previewRequest('mix', artistMixBody).expect(503);

      expect(response.body).toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
      expect(world.provider.resolveTrack).toHaveBeenCalledTimes(1);
      expectNoSpotifyWrites();
    });

    it('fails without catalog or publication work when the quota is blocked', async () => {
      world.quota.assertAvailable.mockImplementation(() => {
        throw new BusinessRuleError(
          'Spotify rate limit.',
          'SPOTIFY_RATE_LIMITED',
        );
      });

      const response = await previewRequest('mix', artistMixBody).expect(429);

      expect(response.body).toMatchObject({ code: 'SPOTIFY_RATE_LIMITED' });
      expect(world.provider.resolveTrack).not.toHaveBeenCalled();
      expectNoSpotifyWrites();
    });

    it('fails a save without publishing when the session user no longer exists', async () => {
      const { previewId } = await preview('mix', artistMixBody);
      world.userId = 'missing-user';

      await save(previewId).expect(404);

      expectNoSpotifyWrites();
    });
  });

  describe('genre mix', () => {
    const genreMixBody = {
      kind: 'genre_mix',
      genreIds: ['jazz'],
      tracksPerSeed: 4,
      popularity: 'balanced',
    };

    it('previews from genre charts, then publishes and records genre stats on save', async () => {
      const { previewId, playlist } = await preview('mix', genreMixBody);

      expect(playlist).toMatchObject({
        name: 'Blendify · Mix · Jazz',
        description: 'Made with Blendify from Jazz.',
        seeds: [{ type: 'genre', id: 'jazz', name: 'Jazz' }],
        generation: {
          version: 1,
          kind: 'genre_mix',
          tracksPerSeed: 4,
          popularity: 'balanced',
          orderMode: 'random',
          seeds: [{ id: 'jazz', name: 'Jazz' }],
        },
      });
      expect(playlist.tracks).toHaveLength(4);
      expectNoSpotifyWrites();

      await saved(previewId);

      expect(world.provider.createPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'spotify-user-1',
          isPublic: false,
        }),
      );
      expect(publishedUris()).toEqual(
        playlist.tracks.map((track) => track.uri),
      );
      expect(world.playlists.save).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledWith({
        userId: 'user-1',
        kind: 'genre',
        seeds: [
          expect.objectContaining({
            kind: 'genre',
            seedKey: 'jazz',
            name: 'Jazz',
          }),
        ],
      });
    });
  });

  describe('genre mix with a region', () => {
    function mockArgentinianJazz() {
      world.discovery.getTopArtistsForTag.mockImplementation((tag) =>
        Promise.resolve(
          tag === 'argentina'
            ? [
                { name: 'jazz Artist 1' },
                { name: 'tango Artist 1' },
                { name: 'jazz Artist 2' },
              ]
            : [],
        ),
      );
      world.discovery.getTopTagsForArtist.mockImplementation((artist) =>
        Promise.resolve([
          { name: artist.name.split(' ')[0], count: 100 },
          { name: 'argentina', count: 80 },
        ]),
      );
    }

    it('filters the genre by region and records the region in the recipe', async () => {
      mockArgentinianJazz();

      const { playlist } = await preview('mix', {
        kind: 'genre_mix',
        genreIds: ['jazz'],
        filters: { region: 'argentina' },
        tracksPerSeed: 4,
        popularity: 'balanced',
      });

      expect(playlist.name).toBe('Blendify · Mix · Jazz · Argentina');
      expect(playlist.generation).toMatchObject({
        kind: 'genre_mix',
        seeds: [{ id: 'jazz', name: 'Jazz' }],
        filters: { region: 'argentina' },
      });
      expect(new Set(playlist.tracks.map((track) => track.artistName))).toEqual(
        new Set(['jazz Artist 1', 'jazz Artist 2']),
      );
      expect(world.discovery.getTopTracksForTag).not.toHaveBeenCalled();
      expect(
        world.discovery.getTopArtistsForTag.mock.calls.map(([tag]) => tag),
      ).toEqual(['argentina']);
    });

    it('keeps an explicit playlist name without appending the region', async () => {
      mockArgentinianJazz();

      const { playlist } = await preview('mix', {
        kind: 'genre_mix',
        name: 'Ruta 40',
        genreIds: ['jazz'],
        filters: { region: 'argentina' },
        tracksPerSeed: 4,
        popularity: 'balanced',
      });

      expect(playlist.name).toBe('Ruta 40');
    });

    it('rejects the former top-level region field instead of ignoring it', async () => {
      await previewRequest('mix', {
        kind: 'genre_mix',
        genreIds: ['jazz'],
        region: 'argentina',
        tracksPerSeed: 4,
        popularity: 'balanced',
      }).expect(400);

      expectNoSpotifyWrites();
    });

    it('rejects a region on an artist mix instead of ignoring it', async () => {
      await previewRequest('mix', {
        kind: 'artist_mix',
        artistIds: ['artist-1'],
        filters: { region: 'argentina' },
        tracksPerSeed: 4,
        popularity: 'balanced',
      }).expect(400);

      expectNoSpotifyWrites();
    });
  });

  describe('genre mix with an unavailable catalog', () => {
    it('fails as unavailable instead of falling back to empty genre results', async () => {
      world.provider.resolveTrack.mockRejectedValue(
        new CatalogUnavailableError(),
      );

      const response = await previewRequest('mix', {
        kind: 'genre_mix',
        genreIds: ['jazz'],
        tracksPerSeed: 4,
        popularity: 'balanced',
      }).expect(503);

      expect(response.body).toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
      expect(world.provider.searchArtists).not.toHaveBeenCalled();
      expectNoSpotifyWrites();
    });
  });

  describe('discover artist', () => {
    const discoverArtistBody = {
      kind: 'discover_artist',
      artistId: 'sade',
      artist: {
        id: 'sade',
        name: 'Sade',
        imageUrl: 'https://images.example/sade.jpg',
      },
      targetTrackCount: 15,
      popularity: 'balanced',
    };

    it('builds from similar artists, excludes the seed, publishes on save, and records the seed', async () => {
      const { previewId, playlist } = await preview(
        'discover',
        discoverArtistBody,
      );

      expect(playlist).toMatchObject({
        name: 'Blendify · Discover · Sade',
        description: 'In the orbit of Sade. Made with Blendify.',
        seeds: [
          {
            type: 'artist',
            id: 'sade',
            name: 'Sade',
            imageUrl: 'https://images.example/sade.jpg',
          },
        ],
        generation: {
          version: 1,
          kind: 'discover_artist',
          targetTrackCount: 15,
          popularity: 'balanced',
          orderMode: 'random',
          seed: {
            id: 'sade',
            name: 'Sade',
            imageUrl: 'https://images.example/sade.jpg',
          },
        },
      });
      expect(playlist.tracks).toHaveLength(15);
      expect(playlist.tracks.some((track) => track.artistId === 'sade')).toBe(
        false,
      );
      expectNoSpotifyWrites();

      await saved(previewId);

      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(publishedUris()).toEqual(
        playlist.tracks.map((track) => track.uri),
      );
      expect(world.playlists.save).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledWith({
        userId: 'user-1',
        kind: 'artist',
        seeds: [
          {
            kind: 'artist',
            seedKey: 'sade',
            name: 'Sade',
            imageUrl: 'https://images.example/sade.jpg',
          },
        ],
      });
    });

    it('streams monotonic progress that ends at the preview', async () => {
      const response = await previewRequest('discover', discoverArtistBody)
        .set('Accept', 'application/x-ndjson')
        .buffer(true)
        .parse(readNdjson)
        .expect(200);

      const events = parseEvents(response.body as string);
      const percents = progressEvents(events).map((event) => event.percent);
      expect(percents).toEqual([...percents].sort((a, b) => a - b));
      expect(distinctPhases(events).at(-1)).toBe('matching_tracks');
      expect(events.at(-1)?.type).toBe('result');
    });
  });

  describe('discover track', () => {
    it('builds from similar tracks, excludes the seed track, publishes on save, and records the seed artist', async () => {
      const seed = makeTrack('Sade', 'Smooth Operator');

      const { previewId, playlist } = await preview('discover', {
        kind: 'discover_track',
        trackId: seed.id.getValue(),
        track: {
          id: seed.id.getValue(),
          name: 'Smooth Operator',
          artistId: 'sade',
          artistName: 'Sade',
        },
        targetTrackCount: 15,
        popularity: 'balanced',
      });

      expect(playlist).toMatchObject({
        name: 'Blendify · Discover · Smooth Operator',
        description: 'Around “Smooth Operator” by Sade. Made with Blendify.',
        seeds: [
          {
            type: 'track',
            id: seed.id.getValue(),
            name: 'Smooth Operator',
            artistId: 'sade',
            artistName: 'Sade',
            albumImageUrl: seed.albumImageUrl,
            uri: seed.uri,
          },
        ],
        generation: {
          version: 1,
          kind: 'discover_track',
          targetTrackCount: 15,
          popularity: 'balanced',
          orderMode: 'random',
          seed: {
            id: seed.id.getValue(),
            name: 'Smooth Operator',
            artistId: 'sade',
            artistName: 'Sade',
          },
        },
      });
      expect(playlist.tracks).toHaveLength(15);
      expect(
        playlist.tracks.some((track) => track.id === seed.id.getValue()),
      ).toBe(false);
      expectNoSpotifyWrites();

      await saved(previewId);

      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(publishedUris()).toEqual(
        playlist.tracks.map((track) => track.uri),
      );
      expect(world.playlists.save).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledWith({
        userId: 'user-1',
        kind: 'artist',
        seeds: [
          {
            kind: 'artist',
            seedKey: 'sade',
            name: 'Sade',
            imageUrl: seed.albumImageUrl,
          },
        ],
      });
    });
  });

  describe('Spotify provider failures while saving', () => {
    const discoverArtistBody = {
      kind: 'discover_artist',
      artistId: 'sade',
      artist: { id: 'sade', name: 'Sade', imageUrl: null },
      targetTrackCount: 15,
      popularity: 'balanced',
    };

    function previewDiscover() {
      return preview('discover', discoverArtistBody);
    }

    function expectNoPublishSideEffects() {
      expect(world.provider.addTracksToPlaylist).not.toHaveBeenCalled();
      expect(world.playlists.save).not.toHaveBeenCalled();
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();
    }

    it('settles a 502 on playlist creation as an unconfirmed outcome and never retries it', async () => {
      world.provider.createPlaylist.mockRejectedValueOnce(
        new ProviderOutcomeUnknownError(
          'Spotify createPlaylist outcome unknown',
          {
            operation: 'createPlaylist',
            category: 'upstream_error',
            status: 502,
          },
        ),
      );
      const { previewId } = await previewDiscover();

      const first = await saved(previewId);
      const again = await saved(previewId);

      expect(first.destination).toEqual({
        status: 'publish_incomplete',
        spotifyUrl: null,
        reason: 'outcome_unknown',
      });
      expect(again.destination).toEqual(first.destination);
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expectNoPublishSideEffects();
    });

    it('reports a creation that never reached Spotify as a retryable provider failure', async () => {
      world.provider.createPlaylist.mockRejectedValueOnce(
        new SpotifyProviderError('SPOTIFY_UNAVAILABLE', {
          operation: 'createPlaylist',
          category: 'network',
          status: null,
        }),
      );
      const { previewId } = await previewDiscover();

      const response = await save(previewId).expect(503);

      expect(response.body).toMatchObject({
        statusCode: 503,
        code: 'SPOTIFY_UNAVAILABLE',
        details: { operation: 'createPlaylist', category: 'network' },
      });
      expectNoPublishSideEffects();

      const retry = await saved(previewId);
      expect(retry.destination).toMatchObject({ status: 'published' });
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(2);
    });

    it('keeps the created playlist link when adding songs fails', async () => {
      world.provider.addTracksToPlaylist.mockRejectedValueOnce(
        new ProviderOutcomeUnknownError('timeout', {
          operation: 'addTracksToPlaylist',
          category: 'timeout',
          status: null,
        }),
      );
      const { previewId } = await previewDiscover();

      const state = await saved(previewId);

      expect(state.destination).toEqual({
        status: 'publish_incomplete',
        spotifyUrl: SPOTIFY_PLAYLIST.url,
        reason: 'tracks_incomplete',
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(world.provider.addTracksToPlaylist).toHaveBeenCalledTimes(1);
      expect(world.playlists.save).not.toHaveBeenCalled();
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();
    });

    it('keeps the playlist and flags only the Library when saving to it fails', async () => {
      world.playlists.save.mockRejectedValueOnce(new Error('db down'));
      const { previewId } = await previewDiscover();

      const state = await saved(previewId);

      expect(state.destination).toMatchObject({
        status: 'publish_incomplete',
        spotifyUrl: SPOTIFY_PLAYLIST.url,
        reason: 'library_not_saved',
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
    });

    it('completes the playlist and flags only the cover when the cover upload fails', async () => {
      world.provider.uploadPlaylistCover.mockRejectedValueOnce(
        new Error('cover rejected'),
      );
      const { previewId } = await previewDiscover();

      const state = await saved(previewId, { coverImageBase64: 'jpeg-data' });

      expect(state.destination).toMatchObject({
        status: 'published',
        spotifyId: SPOTIFY_PLAYLIST.id,
        coverUploadFailed: true,
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(world.playlists.save).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'a revoked authorization',
        new SpotifyReauthRequiredError(),
        401,
        'SPOTIFY_REAUTH_REQUIRED',
      ],
      [
        'a forbidden action',
        new SpotifyProviderError('SPOTIFY_PERMISSION_DENIED', {
          operation: 'createPlaylist',
          category: 'forbidden',
          status: 403,
        }),
        403,
        'SPOTIFY_PERMISSION_DENIED',
      ],
    ])(
      'keeps %s distinct from input problems and allows a retry',
      async (_label, failure, statusCode, code) => {
        world.provider.createPlaylist.mockRejectedValueOnce(failure);
        const { previewId } = await previewDiscover();

        const response = await save(previewId).expect(statusCode);

        expect(response.body).toMatchObject({ statusCode, code });
        expectNoPublishSideEffects();
      },
    );

    it('reports a seed song Spotify cannot find at preview time as an input problem', async () => {
      world.provider.searchTracks.mockResolvedValue([]);
      world.provider.resolveTrack.mockResolvedValue(null);

      const response = await previewRequest('discover', {
        kind: 'discover_track',
        trackId: 'missing-song',
        track: {
          id: 'missing-song',
          name: 'Un Beso en la Nariz',
          artistId: 'artist-x',
          artistName: 'Artist X',
        },
        targetTrackCount: 15,
        popularity: 'balanced',
      }).expect(422);

      expect(response.body).toMatchObject({
        statusCode: 422,
        code: 'TRACK_RESOLVE_FAILED',
        details: { name: 'Un Beso en la Nariz' },
      });
      expectNoSpotifyWrites();
    });
  });
});
