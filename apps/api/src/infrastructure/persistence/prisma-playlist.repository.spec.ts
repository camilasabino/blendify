import {
  PlaylistDetailSchema,
  PopularityMode,
  TrackOrderMode,
  emptySelectionFilters,
} from '@blendify/contracts';
import type { Playlist as PlaylistModel } from '@prisma/client';
import { toPlaylistDetail } from '@/application/dto/playlist-response.dto';
import { Playlist } from '@/domain/playlist/playlist.entity';
import { Track } from '@/domain/track/track.entity';
import { ArtistId } from '@/domain/value-objects/artist-id.vo';
import { TrackId } from '@/domain/value-objects/track-id.vo';
import { PrismaPlaylistRepository } from './prisma-playlist.repository';
import type { PrismaService } from './prisma.service';

const generation = {
  kind: 'artist_mix' as const,
  filters: emptySelectionFilters(),
  version: 1 as const,
  popularity: PopularityMode.BALANCED,
  orderMode: TrackOrderMode.ARTIST,
  tracksPerSeed: 10,
  seeds: [{ id: 'kid-id', name: 'The Kid LAROI' }],
};

function row(tracks: unknown[]): PlaylistModel {
  return {
    id: 'playlist-1',
    userId: 'user-1',
    name: 'Evening mix',
    description: '',
    spotifyId: null,
    spotifyUrl: null,
    kind: 'artist_mix',
    status: 'PENDING',
    totalDurationMs: 141_000,
    seedCount: 1,
    trackCount: tracks.length,
    tracksPerSeed: 10,
    seeds: [{ type: 'artist', id: 'kid-id', name: 'The Kid LAROI' }],
    tracks: tracks as PlaylistModel['tracks'],
    generation,
    syncedTrackCount: null,
    imageUrl: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function createRepository() {
  const prisma = {
    playlist: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn((args: { create: Omit<PlaylistModel, 'id'> }) =>
        Promise.resolve(row(args.create.tracks as unknown[])),
      ),
    },
  };
  return {
    prisma,
    repository: new PrismaPlaylistRepository(
      prisma as unknown as PrismaService,
    ),
  };
}

const baseTrack = {
  id: 'track-1',
  name: 'Stay',
  artistId: 'kid-id',
  artistName: 'The Kid LAROI',
  durationMs: 141_000,
  popularity: 0,
  uri: 'spotify:track:track-1',
  albumImageUrl: null,
  previewUrl: null,
  artists: [{ id: 'kid-id', name: 'The Kid LAROI' }],
};

describe('PrismaPlaylistRepository track metadata', () => {
  it('keeps a stored 73, a stored zero, and a stored null distinct', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findUnique.mockResolvedValue(
      row([
        { ...baseTrack, id: 'high', popularity: 73 },
        { ...baseTrack, id: 'zero', popularity: 0 },
        { ...baseTrack, id: 'unknown', popularity: null },
      ]),
    );

    const playlist = await repository.findById('playlist-1');

    expect(playlist?.tracks.map((track) => track.popularity)).toEqual([
      73,
      0,
      null,
    ]);
  });

  it('persists an unknown popularity as null', async () => {
    const { prisma, repository } = createRepository();
    const playlist = Playlist.create({
      id: 'playlist-1',
      userId: 'user-1',
      name: 'Evening mix',
      seeds: [{ type: 'artist', id: 'kid-id', name: 'The Kid LAROI' }],
      tracks: [
        Track.create({
          id: TrackId.create('track-1'),
          name: 'Stay',
          artistId: ArtistId.create('kid-id'),
          artistName: 'The Kid LAROI',
          durationMs: 141_000,
          popularity: null,
          uri: 'spotify:track:track-1',
        }),
      ],
      generation,
    });

    const saved = await repository.save(playlist);
    const [stored] = prisma.playlist.upsert.mock.calls[0][0].create
      .tracks as unknown as Array<Record<string, unknown>>;

    expect(stored.popularity).toBeNull();
    expect(saved.tracks[0].popularity).toBeNull();
  });

  it('persists and restores credited artists, isrc and external url', async () => {
    const { prisma, repository } = createRepository();
    const playlist = Playlist.create({
      id: 'playlist-1',
      userId: 'user-1',
      name: 'Evening mix',
      seeds: [{ type: 'artist', id: 'kid-id', name: 'The Kid LAROI' }],
      tracks: [
        Track.create({
          id: TrackId.create('track-1'),
          name: 'Stay',
          artistId: ArtistId.create('bieber-id'),
          artistName: 'Justin Bieber',
          durationMs: 141_000,
          popularity: 0,
          uri: 'spotify:track:track-1',
          artists: [
            { id: 'kid-id', name: 'The Kid LAROI' },
            { id: 'bieber-id', name: 'Justin Bieber' },
          ],
          isrc: 'USUM72105936',
          externalUrl: 'https://open.spotify.com/track/track-1',
        }),
      ],
      generation,
    });

    const saved = await repository.save(playlist);
    const [stored] = prisma.playlist.upsert.mock.calls[0][0].create
      .tracks as unknown as Array<Record<string, unknown>>;
    const [track] = saved.tracks;

    expect(stored).toMatchObject({
      artistId: 'bieber-id',
      artists: [
        { id: 'kid-id', name: 'The Kid LAROI' },
        { id: 'bieber-id', name: 'Justin Bieber' },
      ],
      isrc: 'USUM72105936',
      externalUrl: 'https://open.spotify.com/track/track-1',
    });
    expect(track.artistId.getValue()).toBe('bieber-id');
    expect(track.artists).toEqual([
      { id: 'kid-id', name: 'The Kid LAROI' },
      { id: 'bieber-id', name: 'Justin Bieber' },
    ]);
    expect(track.isrc).toBe('USUM72105936');
    expect(track.externalUrl).toBe('https://open.spotify.com/track/track-1');
  });
});

describe('PrismaPlaylistRepository.deleteMany', () => {
  it('deletes only the given ids scoped to the given user in one statement', async () => {
    const prisma = {
      playlist: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const repository = new PrismaPlaylistRepository(
      prisma as unknown as PrismaService,
    );

    await repository.deleteMany('user-1', ['playlist-1', 'playlist-2']);

    expect(prisma.playlist.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { in: ['playlist-1', 'playlist-2'] } },
    });
  });

  it('does not call the database when there are no ids to delete', async () => {
    const prisma = {
      playlist: {
        deleteMany: jest.fn(),
      },
    };
    const repository = new PrismaPlaylistRepository(
      prisma as unknown as PrismaService,
    );

    await repository.deleteMany('user-1', []);

    expect(prisma.playlist.deleteMany).not.toHaveBeenCalled();
  });
});

describe('PrismaPlaylistRepository Genre Mix region', () => {
  const genreMixRow = (): PlaylistModel => ({
    ...row([baseTrack]),
    kind: 'genre_mix',
    seeds: [{ type: 'genre', id: 'rock', name: 'Rock' }],
    generation: {
      kind: 'genre_mix',
      version: 1,
      popularity: PopularityMode.BALANCED,
      orderMode: TrackOrderMode.RANDOM,
      tracksPerSeed: 10,
      seeds: [{ id: 'rock', name: 'Rock' }],
      filters: {
        region: 'argentina',
        femaleVocals: false,
        releaseRange: null,
        excludeLive: false,
      },
    },
  });

  it('reads the region as filters.region', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findUnique.mockResolvedValue(genreMixRow());

    const playlist = await repository.findById('playlist-1');

    expect(playlist?.generation).toMatchObject({
      kind: 'genre_mix',
      filters: { region: 'argentina' },
    });
    expect(playlist?.generation).not.toHaveProperty('region');
  });

  it('keeps the region in the playlist detail summary', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findUnique.mockResolvedValue(genreMixRow());

    const playlist = await repository.findById('playlist-1');
    const detail = PlaylistDetailSchema.parse(toPlaylistDetail(playlist!));

    expect(detail.generation).toMatchObject({
      filters: { region: 'argentina' },
    });
    expect(detail.generation).not.toHaveProperty('region');
  });

  it('re-serializes the recipe with only filters.region', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findUnique.mockResolvedValue(genreMixRow());
    prisma.playlist.upsert.mockImplementation(
      (args: { create: Omit<PlaylistModel, 'id'> }) =>
        Promise.resolve({ ...args.create, id: 'playlist-1' }),
    );

    const playlist = await repository.findById('playlist-1');
    playlist!.rename('Renamed mix');
    const saved = await repository.save(playlist!);
    const stored = prisma.playlist.upsert.mock.calls[0][0].create
      .generation as Record<string, unknown>;

    expect(stored).toMatchObject({ filters: { region: 'argentina' } });
    expect(stored).not.toHaveProperty('region');
    expect(saved.generation).toMatchObject({
      filters: { region: 'argentina' },
    });
  });
});

describe('PrismaPlaylistRepository unreadable records', () => {
  const unreadable = (): PlaylistModel => ({
    ...row([baseTrack]),
    id: 'unreadable',
    generation: { kind: 'artist_mix', version: 1 },
  });

  it('treats an unreadable record as missing', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findUnique.mockResolvedValue(unreadable());

    await expect(repository.findById('unreadable')).resolves.toBeNull();
  });

  it('skips an unreadable record without hiding the readable ones', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findMany.mockResolvedValue([
      unreadable(),
      row([baseTrack]),
    ]);

    const playlists = await repository.listLibrary('user-1', {});

    expect(playlists.map((playlist) => playlist.id)).toEqual(['playlist-1']);
  });

  it('paginates over readable records only', async () => {
    const { prisma, repository } = createRepository();
    const readableRow = (id: string) => ({ ...row([baseTrack]), id });
    prisma.playlist.findMany
      .mockResolvedValueOnce([
        { id: 'a', seeds: row([]).seeds, generation },
        { id: 'unreadable', seeds: row([]).seeds, generation: { kind: 'x' } },
        { id: 'b', seeds: row([]).seeds, generation },
        { id: 'c', seeds: row([]).seeds, generation },
      ])
      .mockResolvedValueOnce([readableRow('c'), readableRow('b')]);

    const page = await repository.listLibraryPage('user-1', {
      limit: 2,
      offset: 1,
    });

    expect(page.total).toBe(3);
    expect(page.items.map((playlist) => playlist.id)).toEqual(['b', 'c']);
    expect(prisma.playlist.findMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ['b', 'c'] } },
    });
  });

  it('returns an empty page past the last readable record', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findMany.mockResolvedValueOnce([
      { id: 'a', seeds: row([]).seeds, generation },
    ]);

    const page = await repository.listLibraryPage('user-1', {
      limit: 5,
      offset: 5,
    });

    expect(page).toEqual({ total: 1, items: [] });
    expect(prisma.playlist.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not hide database errors', async () => {
    const { prisma, repository } = createRepository();
    prisma.playlist.findMany.mockRejectedValue(new Error('connection lost'));

    await expect(
      repository.listLibraryPage('user-1', { limit: 5, offset: 0 }),
    ).rejects.toThrow('connection lost');
  });
});
