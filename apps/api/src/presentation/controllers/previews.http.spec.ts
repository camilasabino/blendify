import {
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
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
import { PublishPlaylistService } from '@/application/services/publish-playlist.service';
import { SpotifyPublicationRunner } from '@/application/services/spotify-publication.runner';
import { BulkLibraryUseCase } from '@/application/use-cases/bulk-library.use-case';
import { CreateSpotifyPlaylistUseCase } from '@/application/use-cases/create-spotify-playlist.use-case';
import { CreateSpotifyPreviewUseCase } from '@/application/use-cases/create-spotify-preview.use-case';
import { GeneratePlaylistUseCase } from '@/application/use-cases/generate-playlist.use-case';
import { GetPlaylistDetailUseCase } from '@/application/use-cases/get-playlist-detail.use-case';
import { GetSpotifyPreviewUseCase } from '@/application/use-cases/get-spotify-preview.use-case';
import { ListLibraryPlaylistsUseCase } from '@/application/use-cases/list-library-playlists.use-case';
import { RemovePlaylistFromLibraryUseCase } from '@/application/use-cases/remove-playlist-from-library.use-case';
import { RenamePlaylistUseCase } from '@/application/use-cases/rename-playlist.use-case';
import { SaveSpotifyPreviewUseCase } from '@/application/use-cases/save-spotify-preview.use-case';
import { SyncLibraryUseCase } from '@/application/use-cases/sync-library.use-case';
import {
  createWorld as createGenerationWorld,
  titles,
} from '@/application/use-cases/generation-world.testing';
import { memoryPreviewRepository } from '@/application/use-cases/spotify-preview-world.testing';
import { ProviderOutcomeUnknownError } from '@/domain/errors/provider-outcome-unknown.error';
import { SpotifyProviderError } from '@/domain/errors/spotify-provider.error';
import type { Playlist } from '@/domain/playlist/playlist.entity';
import { MUSIC_PROVIDER_FACTORY } from '@/domain/repositories/music-provider.factory.port';
import { PLAYLIST_REPOSITORY } from '@/domain/repositories/playlist.repository.port';
import { SPOTIFY_PREVIEW_REPOSITORY } from '@/domain/repositories/spotify-preview.repository.port';
import { USAGE_STATS_REPOSITORY } from '@/domain/repositories/usage-stats.repository.port';
import { USER_REPOSITORY } from '@/domain/repositories/user.repository.port';
import { User } from '@/domain/user/user.entity';
import { JwtAuthGuard } from '@/infrastructure/auth/jwt-auth.guard';
import { GlobalExceptionFilter } from '@/presentation/filters/global-exception.filter';
import { OriginCsrfGuard } from '@/presentation/guards/origin-csrf.guard';
import { createBodyParser } from '@/presentation/http/body-limits';
import { listenOnLoopback } from '@/presentation/http/loopback.testing';
import { DEFAULT_RATE_LIMITS } from '@/presentation/request-limits/request-limits.config';
import { inMemoryRequestLimitProviders } from '@/presentation/request-limits/request-limits.testing';
import { PlaylistsController } from './playlists.controller';
import { PreviewsController } from './previews.controller';

const ORIGIN = 'http://127.0.0.1:5173';
const USER_HEADER = 'x-test-user';
const SPOTIFY = {
  id: 'spotify-playlist-1',
  url: 'https://open.spotify.com/playlist/spotify-playlist-1',
};

const MIX_BODY = {
  kind: 'artist_mix',
  artistIds: ['sade'],
  artists: [{ id: 'sade', name: 'Sade' }],
  tracksPerSeed: 4,
  popularity: 'balanced',
};

class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: { id: string };
    }>();
    const id = req.headers[USER_HEADER];
    if (!id) {
      throw new UnauthorizedException();
    }
    req.user = { id };
    return true;
  }
}

type ResponseBody = {
  code?: string;
  destination?: { status?: string } | null;
};

function bodyOf(res: { body: unknown }): ResponseBody {
  return res.body as ResponseBody;
}

function makeUser(id: string): User {
  return User.create({
    id,
    spotifyId: `spotify-${id}`,
    displayName: id,
  });
}

function createWorld(
  options: {
    charts?: Record<string, string[]>;
    similarArtists?: string[];
    repository?: ReturnType<typeof memoryPreviewRepository>;
  } = {},
) {
  const generation = createGenerationWorld({
    artistCharts: options.charts ?? { Sade: titles('Sade', 8) },
    similarArtists: options.similarArtists,
  });
  const provider = {
    createPlaylist: jest.fn(() =>
      Promise.resolve({ id: SPOTIFY.id, url: SPOTIFY.url }),
    ),
    addTracksToPlaylist: jest.fn((_id: string, _uris: string[]) =>
      Promise.resolve(),
    ),
    uploadPlaylistCover: jest.fn(() => Promise.resolve()),
    getPlaylistSnapshot: jest.fn(() =>
      Promise.resolve({
        id: SPOTIFY.id,
        name: 'snapshot',
        url: SPOTIFY.url,
        trackCount: 0,
        totalDurationMs: 0,
        imageUrl: null,
      }),
    ),
  };
  const users = {
    findById: jest.fn((id: string) =>
      Promise.resolve(id.startsWith('user-') ? makeUser(id) : null),
    ),
  };
  const usageStats = { recordMix: jest.fn(() => Promise.resolve()) };
  const playlists = {
    save: jest.fn((playlist: Playlist) => Promise.resolve(playlist)),
  };
  const repository = options.repository ?? memoryPreviewRepository();
  return { generation, provider, users, usageStats, playlists, repository };
}

type World = ReturnType<typeof createWorld>;

async function createApp(world: World): Promise<INestApplication> {
  const unused = { execute: jest.fn() };
  const module = await Test.createTestingModule({
    controllers: [PreviewsController, PlaylistsController],
    providers: [
      CreateSpotifyPreviewUseCase,
      GetSpotifyPreviewUseCase,
      SaveSpotifyPreviewUseCase,
      CreateSpotifyPlaylistUseCase,
      SpotifyPublicationRunner,
      PublishPlaylistService,
      {
        provide: GeneratePlaylistUseCase,
        useValue: new GeneratePlaylistUseCase(
          world.generation.artistMix,
          world.generation.genreMix,
          world.generation.discover,
        ),
      },
      { provide: SPOTIFY_PREVIEW_REPOSITORY, useValue: world.repository },
      {
        provide: MUSIC_PROVIDER_FACTORY,
        useValue: { forUser: () => world.provider },
      },
      { provide: USER_REPOSITORY, useValue: world.users },
      { provide: USAGE_STATS_REPOSITORY, useValue: world.usageStats },
      { provide: PLAYLIST_REPOSITORY, useValue: world.playlists },
      { provide: ListLibraryPlaylistsUseCase, useValue: unused },
      { provide: SyncLibraryUseCase, useValue: unused },
      { provide: GetPlaylistDetailUseCase, useValue: unused },
      { provide: RenamePlaylistUseCase, useValue: unused },
      { provide: RemovePlaylistFromLibraryUseCase, useValue: unused },
      { provide: BulkLibraryUseCase, useValue: unused },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => (key === 'FRONTEND_URL' ? ORIGIN : undefined),
        },
      },
      OriginCsrfGuard,
      { provide: APP_GUARD, useExisting: OriginCsrfGuard },
      ...inMemoryRequestLimitProviders({
        rateLimits: {
          ...DEFAULT_RATE_LIMITS,
          generation: { ...DEFAULT_RATE_LIMITS.generation, limit: 100 },
        },
      }),
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue(new HeaderAuthGuard())
    .compile();

  const app = module.createNestApplication({
    logger: false,
    bodyParser: false,
  });
  app.use(createBodyParser());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await listenOnLoopback(app);
  return app;
}

function parseEvents(body: string): SpotifyPreviewStreamEvent[] {
  return body
    .split('\n')
    .filter(Boolean)
    .map((line) => SpotifyPreviewStreamEventSchema.parse(JSON.parse(line)));
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

describe('Spotify previews over HTTP', () => {
  let world: World;
  let app: INestApplication;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(async () => {
    world = createWorld();
    app = await createApp(world);
  });

  afterEach(async () => {
    await app.close();
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  function post(path: string, user: string | null = 'user-1') {
    const call = request(server()).post(path).set('Origin', ORIGIN);
    return user ? call.set(USER_HEADER, user) : call;
  }

  function get(path: string, user: string | null = 'user-1') {
    const call = request(server()).get(path);
    return user ? call.set(USER_HEADER, user) : call;
  }

  async function generate(user = 'user-1'): Promise<SpotifyPreviewDto> {
    const res = await post('/api/previews/mix', user)
      .send(MIX_BODY)
      .expect(201);
    return SpotifyPreviewSchema.parse(res.body);
  }

  function save(previewId: string, user = 'user-1', body: object = {}) {
    return post(`/api/previews/${previewId}/save`, user).send({
      name: 'Late night',
      persistToLibrary: true,
      ...body,
    });
  }

  function spotifyWrites(): number {
    return (
      world.provider.createPlaylist.mock.calls.length +
      world.provider.addTracksToPlaylist.mock.calls.length +
      world.provider.uploadPlaylistCover.mock.calls.length +
      world.playlists.save.mock.calls.length +
      world.usageStats.recordMix.mock.calls.length
    );
  }

  describe('authentication', () => {
    it.each([
      ['POST', '/api/previews/mix'],
      ['POST', '/api/previews/discover'],
      ['GET', `/api/previews/${'A'.repeat(22)}`],
      ['POST', `/api/previews/${'A'.repeat(22)}/save`],
    ])('requires a session on %s %s', async (method, path) => {
      const call =
        method === 'GET'
          ? request(server()).get(path)
          : request(server()).post(path).set('Origin', ORIGIN).send({});

      const res = await call.expect(401);

      expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
      expect(spotifyWrites()).toBe(0);
    });
  });

  describe('CSRF protection', () => {
    it.each([
      ['/api/previews/mix', MIX_BODY],
      ['/api/previews/discover', {}],
      [
        `/api/previews/${'A'.repeat(22)}/save`,
        { name: 'x', persistToLibrary: true },
      ],
    ])('rejects a POST to %s without a matching origin', async (path, body) => {
      await request(server())
        .post(path)
        .set(USER_HEADER, 'user-1')
        .send(body)
        .expect(403);
      await request(server())
        .post(path)
        .set(USER_HEADER, 'user-1')
        .set('Origin', 'https://evil.example')
        .send(body)
        .expect(403);
      expect(spotifyWrites()).toBe(0);
    });

    it('does not require an origin for reads', async () => {
      await get(`/api/previews/${'A'.repeat(22)}`).expect(404);
    });
  });

  describe('generation', () => {
    it('streams progress and ends with a strict preview result', async () => {
      const res = await post('/api/previews/mix')
        .set('Accept', 'application/x-ndjson')
        .send(MIX_BODY)
        .buffer(true)
        .parse(readNdjson)
        .expect(200);

      expect(res.headers['content-type']).toContain('application/x-ndjson');
      const events = parseEvents(res.body as string);
      const last = events[events.length - 1];
      expect(events.some((event) => event.type === 'progress')).toBe(true);
      expect(
        events.flatMap((event) =>
          event.type === 'progress' ? [event.phase] : [],
        ),
      ).not.toContain('publishing');
      expect(last.type).toBe('result');
      if (last.type === 'result') {
        expect(last.playlist.playlist.tracks).toHaveLength(4);
      }
    });

    it('creates nothing in Spotify, the Library or usage stats', async () => {
      const preview = await generate();
      await get(`/api/previews/${preview.previewId}`).expect(200);

      expect(world.provider.createPlaylist).not.toHaveBeenCalled();
      expect(world.provider.addTracksToPlaylist).not.toHaveBeenCalled();
      expect(world.provider.uploadPlaylistCover).not.toHaveBeenCalled();
      expect(world.playlists.save).not.toHaveBeenCalled();
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();
    });

    it('serves discover previews and rejects the wrong kind per route', async () => {
      const similar = ['Portishead', 'Morcheeba', 'Zero 7', 'Lamb', 'Bonobo'];
      world = createWorld({
        charts: {
          Sade: titles('Sade', 8),
          ...Object.fromEntries(similar.map((name) => [name, titles(name, 8)])),
        },
        similarArtists: similar,
      });
      await app.close();
      app = await createApp(world);

      await post('/api/previews/discover').send(MIX_BODY).expect(400);
      await post('/api/previews/mix')
        .send({
          kind: 'discover_artist',
          artistId: 'sade',
          targetTrackCount: 5,
          popularity: 'balanced',
        })
        .expect(400);
      const res = await post('/api/previews/discover')
        .send({
          kind: 'discover_artist',
          artistId: 'sade',
          artist: { id: 'sade', name: 'Sade' },
          targetTrackCount: 3,
          popularity: 'balanced',
        })
        .expect(201);

      const preview = SpotifyPreviewSchema.parse(res.body);
      expect(preview.playlist.generation.kind).toBe('discover_artist');
      expect(preview.playlist.tracks.length).toBeGreaterThan(0);
      expect(world.provider.createPlaylist).not.toHaveBeenCalled();
    });

    it.each([
      { coverImageBase64: 'aGVsbG8=' },
      { persistToLibrary: false },
      { tracks: [] },
      { market: 'US' },
    ])('rejects %j on generation', async (extra) => {
      const res = await post('/api/previews/mix')
        .send({ ...MIX_BODY, ...extra })
        .expect(400);

      expect(bodyOf(res).code).toBe('VALIDATION_ERROR');
    });

    it('stores no preview and reports the typed error for an empty generation', async () => {
      world = createWorld({ charts: { Sade: [] } });
      await app.close();
      app = await createApp(world);
      const create = jest.spyOn(world.repository, 'create');

      const res = await post('/api/previews/mix').send(MIX_BODY).expect(422);

      expect(res.body).toMatchObject({ code: 'NO_TRACKS_FOUND' });
      expect(create).not.toHaveBeenCalled();
    });

    it('reports an empty generation as a stream error event', async () => {
      world = createWorld({ charts: { Sade: [] } });
      await app.close();
      app = await createApp(world);

      const res = await post('/api/previews/mix')
        .set('Accept', 'application/x-ndjson')
        .send(MIX_BODY)
        .buffer(true)
        .parse(readNdjson)
        .expect(200);

      const events = parseEvents(res.body as string);
      expect(events[events.length - 1]).toMatchObject({
        type: 'error',
        code: 'NO_TRACKS_FOUND',
      });
    });

    it('applies the 32kb body limit to generation', async () => {
      const res = await post('/api/previews/mix')
        .send({ ...MIX_BODY, filler: 'x'.repeat(40 * 1024) })
        .expect(413);

      expect(bodyOf(res).code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('fails with 503 when the store is unavailable in production', async () => {
      world = createWorld({
        repository: memoryPreviewRepository('fail-closed'),
      });
      await app.close();
      app = await createApp(world);

      const res = await post('/api/previews/mix').send(MIX_BODY).expect(503);

      expect(res.body).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(res.headers['retry-after']).toBeDefined();
    });
  });

  describe('reading a preview', () => {
    it('returns the stored playlist to its owner', async () => {
      const preview = await generate();

      const res = await get(`/api/previews/${preview.previewId}`).expect(200);

      const state = SpotifyPreviewStateSchema.parse(res.body);
      expect(state.destination).toBeNull();
      expect(state.playlist?.tracks.map((track) => track.uri)).toEqual(
        preview.playlist.tracks.map((track) => track.uri),
      );
    });

    it('answers unknown, malformed and foreign ids with the identical 404', async () => {
      const preview = await generate();
      const responses = await Promise.all([
        get(`/api/previews/${'Z'.repeat(22)}`),
        get('/api/previews/not-a-valid-id'),
        get(`/api/previews/${preview.previewId}`, 'user-2'),
      ]);

      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          statusCode: 404,
          code: 'PREVIEW_NOT_FOUND',
          message: expect.any(String),
        });
      }
      expect(
        new Set(responses.map((res) => JSON.stringify(res.body))).size,
      ).toBe(1);
    });

    it('is not rate limited', async () => {
      const preview = await generate();

      for (let i = 0; i < 30; i += 1) {
        await get(`/api/previews/${preview.previewId}`).expect(200);
      }
    });
  });

  describe('saving a preview', () => {
    it('publishes exactly the stored tracks in order and returns the outcome', async () => {
      const preview = await generate();

      const res = await save(preview.previewId, 'user-1', {
        coverImageBase64: 'aGVsbG8=',
        persistToLibrary: false,
      }).expect(200);

      const state = SpotifyPreviewStateSchema.parse(res.body);
      expect(state.destination).toEqual({
        status: 'published',
        spotifyUrl: SPOTIFY.url,
        savedToLibrary: false,
        spotifyId: SPOTIFY.id,
        coverUploadFailed: false,
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Late night',
          description: preview.playlist.description,
        }),
      );
      expect(world.provider.addTracksToPlaylist).toHaveBeenCalledWith(
        SPOTIFY.id,
        preview.playlist.tracks.map((track) => track.uri),
      );
      expect(world.provider.uploadPlaylistCover).toHaveBeenCalledTimes(1);
      expect(world.playlists.save).not.toHaveBeenCalled();
      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
    });

    it('does not query the catalog or Last.fm while saving', async () => {
      const preview = await generate();
      const calls = () =>
        world.generation.catalog.resolveTrack.mock.calls.length +
        world.generation.catalog.searchTracks.mock.calls.length +
        world.generation.discovery.getTopTracksForArtist.mock.calls.length +
        world.generation.discovery.getSimilarArtists.mock.calls.length;
      const before = calls();

      await save(preview.previewId).expect(200);

      expect(calls()).toBe(before);
    });

    it.each([
      { tracks: [{ uri: 'spotify:track:evil' }] },
      { seeds: [] },
      { generation: {} },
      { description: 'hijack' },
      { kind: 'artist_mix' },
    ])('rejects client-supplied content %j', async (extra) => {
      const preview = await generate();

      const res = await save(preview.previewId, 'user-1', extra).expect(400);

      expect(bodyOf(res).code).toBe('VALIDATION_ERROR');
      expect(world.provider.createPlaylist).not.toHaveBeenCalled();
    });

    it('rejects an invalid name', async () => {
      const preview = await generate();

      await save(preview.previewId, 'user-1', { name: '   ' }).expect(400);
      await save(preview.previewId, 'user-1', { name: 'x'.repeat(101) }).expect(
        400,
      );
    });

    it('applies the 512kb body limit', async () => {
      const preview = await generate();

      await save(preview.previewId, 'user-1', {
        coverImageBase64: 'a'.repeat(600 * 1024),
      }).expect(413);
      expect(world.provider.createPlaylist).not.toHaveBeenCalled();
    });

    it('returns the stored outcome on repeat without calling Spotify again', async () => {
      const preview = await generate();
      const first = await save(preview.previewId).expect(200);

      const second = await save(preview.previewId, 'user-1', {
        name: 'Another name',
      }).expect(200);

      expect(bodyOf(second).destination).toEqual(bodyOf(first).destination);
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
    });

    it('answers unknown and foreign previews with the same 404 and no side effects', async () => {
      const preview = await generate();

      const unknown = await save('Y'.repeat(22)).expect(404);
      const foreign = await save(preview.previewId, 'user-2').expect(404);
      const malformed = await save('short').expect(404);

      expect(foreign.body).toEqual(unknown.body);
      expect(malformed.body).toEqual(unknown.body);
      expect(world.provider.createPlaylist).not.toHaveBeenCalled();
    });

    it('lets only one of many concurrent saves reach Spotify', async () => {
      const preview = await generate();
      world.provider.createPlaylist.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ id: SPOTIFY.id, url: SPOTIFY.url }),
              150,
            ),
          ),
      );

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => save(preview.previewId)),
      );

      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
      const statuses = responses.map((res) => res.status).sort();
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      for (const res of responses.filter((r) => r.status === 409)) {
        expect(res.body).toMatchObject({ code: 'PREVIEW_SAVE_IN_PROGRESS' });
      }
      const final = await get(`/api/previews/${preview.previewId}`).expect(200);
      expect(bodyOf(final).destination?.status).toBe('published');
    });

    it('allows a retry after a confirmed Spotify rejection', async () => {
      const preview = await generate();
      world.provider.createPlaylist.mockRejectedValueOnce(
        new SpotifyProviderError('SPOTIFY_REQUEST_REJECTED', {
          operation: 'createPlaylist',
          category: 'rejected',
          status: 400,
        }),
      );

      const rejected = await save(preview.previewId).expect(502);
      expect(bodyOf(rejected).code).toBe('SPOTIFY_REQUEST_REJECTED');
      const state = await get(`/api/previews/${preview.previewId}`).expect(200);
      expect(bodyOf(state).destination).toBeNull();

      const retried = await save(preview.previewId).expect(200);

      expect(bodyOf(retried).destination?.status).toBe('published');
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(2);
    });

    it('records an ambiguous create as incomplete and never retries it', async () => {
      const preview = await generate();
      world.provider.createPlaylist.mockRejectedValueOnce(
        new ProviderOutcomeUnknownError('createPlaylist'),
      );

      const first = await save(preview.previewId).expect(200);
      const second = await save(preview.previewId).expect(200);

      expect(bodyOf(first).destination).toEqual({
        status: 'publish_incomplete',
        spotifyUrl: null,
        reason: 'outcome_unknown',
      });
      expect(bodyOf(second).destination).toEqual(bodyOf(first).destination);
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();
    });

    it('reports an incomplete publication with its link after tracks fail', async () => {
      const preview = await generate();
      world.provider.addTracksToPlaylist.mockRejectedValueOnce(
        new ProviderOutcomeUnknownError('addTracksToPlaylist'),
      );

      const res = await save(preview.previewId).expect(200);

      expect(bodyOf(res).destination).toEqual({
        status: 'publish_incomplete',
        spotifyUrl: SPOTIFY.url,
        reason: 'tracks_incomplete',
      });
    });

    it('fails with 503 and calls nothing when the store is unavailable in production', async () => {
      const live = await generate();
      await app.close();
      world = createWorld({
        repository: memoryPreviewRepository('fail-closed'),
      });
      app = await createApp(world);

      const res = await save(live.previewId).expect(503);

      expect(bodyOf(res).code).toBe('SERVICE_UNAVAILABLE');
      expect(world.provider.createPlaylist).not.toHaveBeenCalled();
    });
  });

  describe('publish quota', () => {
    it('charges only new attempts: the 13th is limited while reads and reused outcomes stay free', async () => {
      const previews: SpotifyPreviewDto[] = [];
      for (let i = 0; i < 13; i += 1) {
        previews.push(await generate());
      }

      for (const preview of previews.slice(0, 12)) {
        await save(preview.previewId).expect(200);
      }
      for (let i = 0; i < 5; i += 1) {
        await save(previews[0].previewId).expect(200);
        await get(`/api/previews/${previews[0].previewId}`).expect(200);
      }
      const limited = await save(previews[12].previewId).expect(429);

      expect(limited.body).toMatchObject({ code: 'RATE_LIMITED' });
      expect(limited.headers['retry-after']).toBeDefined();
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(12);
      const state = await get(`/api/previews/${previews[12].previewId}`).expect(
        200,
      );
      expect(bodyOf(state).destination).toBeNull();
    });

    it('keys the quota per authenticated user', async () => {
      const mine: SpotifyPreviewDto[] = [];
      for (let i = 0; i < 13; i += 1) {
        mine.push(await generate());
      }
      for (const preview of mine.slice(0, 12)) {
        await save(preview.previewId).expect(200);
      }
      await save(mine[12].previewId).expect(429);

      const other = await generate('user-2');
      await save(other.previewId, 'user-2').expect(200);
    });
  });

  describe('legacy endpoints', () => {
    it('keep publishing on generate with their publication fields', async () => {
      const res = await post('/api/playlists/mix')
        .send({ ...MIX_BODY, persistToLibrary: true })
        .expect(201);

      expect(res.body).toMatchObject({
        spotifyId: SPOTIFY.id,
        spotifyUrl: SPOTIFY.url,
      });
      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(1);
      expect(world.playlists.save).toHaveBeenCalledTimes(1);
    });

    it('do not interfere with previews', async () => {
      await post('/api/playlists/mix').send(MIX_BODY).expect(201);
      const calls = world.provider.createPlaylist.mock.calls.length;

      await generate();

      expect(world.provider.createPlaylist).toHaveBeenCalledTimes(calls);
    });
  });
});
