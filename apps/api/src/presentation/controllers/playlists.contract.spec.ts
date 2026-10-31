import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { BulkLibraryUseCase } from '@/application/use-cases/bulk-library.use-case';
import { RemovePlaylistFromLibraryUseCase } from '@/application/use-cases/remove-playlist-from-library.use-case';
import { GetPlaylistDetailUseCase } from '@/application/use-cases/get-playlist-detail.use-case';
import { ListLibraryPlaylistsUseCase } from '@/application/use-cases/list-library-playlists.use-case';
import { SyncLibraryUseCase } from '@/application/use-cases/sync-library.use-case';
import { RenamePlaylistUseCase } from '@/application/use-cases/rename-playlist.use-case';
import { JwtAuthGuard } from '@/infrastructure/auth/jwt-auth.guard';
import { GlobalExceptionFilter } from '@/presentation/filters/global-exception.filter';
import { PlaylistsController } from './playlists.controller';
import { inMemoryRequestLimitProviders } from '@/presentation/request-limits/request-limits.testing';
import { listenOnLoopback } from '@/presentation/http/loopback.testing';

describe('PlaylistsController contracts', () => {
  let app: INestApplication;
  const library = { execute: jest.fn() };
  const sync = { execute: jest.fn() };
  const detail = { execute: jest.fn() };
  const rename = { execute: jest.fn() };
  const remove = { execute: jest.fn() };
  const bulk = { execute: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlaylistsController],
      providers: [
        { provide: ListLibraryPlaylistsUseCase, useValue: library },
        { provide: SyncLibraryUseCase, useValue: sync },
        { provide: GetPlaylistDetailUseCase, useValue: detail },
        { provide: RenamePlaylistUseCase, useValue: rename },
        { provide: RemovePlaylistFromLibraryUseCase, useValue: remove },
        { provide: BulkLibraryUseCase, useValue: bulk },
        ...inMemoryRequestLimitProviders(),
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: {
          switchToHttp(): { getRequest(): { user?: { id: string } } };
        }) {
          context.switchToHttp().getRequest().user = { id: 'user-1' };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function httpServer(): Server {
    return app.getHttpServer() as Server;
  }

  it('serves a summary page and delegates pagination', async () => {
    const page = { playlists: [], total: 0, active: 0, deleted: 0 };
    library.execute.mockResolvedValue(page);

    await request(httpServer())
      .get('/api/playlists?limit=10&offset=20')
      .expect(200, page);

    expect(library.execute).toHaveBeenCalledWith('user-1', {
      limit: 10,
      offset: 20,
      q: undefined,
    });
  });

  it('delegates a global Library sync to the sync use case', async () => {
    const result = { checkedCount: 12, removedCount: 2 };
    sync.execute.mockResolvedValue(result);

    await request(httpServer()).post('/api/playlists/sync').expect(201, result);

    expect(sync.execute).toHaveBeenCalledWith('user-1');
  });

  it('serves playlist detail separately from library summaries', async () => {
    const playlist = { id: 'playlist-1', tracks: [] };
    detail.execute.mockResolvedValue(playlist);

    await request(httpServer())
      .get('/api/playlists/playlist-1')
      .expect(200, playlist);

    expect(detail.execute).toHaveBeenCalledWith('user-1', 'playlist-1');
  });

  it('returns the normalized validation error envelope', async () => {
    const response = await request(httpServer())
      .post('/api/playlists/bulk')
      .send({ action: 'unknown' })
      .expect(400);

    expect(response.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });
});
