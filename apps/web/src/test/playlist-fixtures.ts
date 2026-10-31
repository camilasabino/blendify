import type {
  GeneratedPlaylistDto,
  LibrarySyncResult,
  PlaylistDetail,
  PlaylistLibraryPage,
  PlaylistSummary,
  SpotifyDestinationDto,
  SpotifyPreviewDto,
  SpotifyPreviewStateDto,
  TrackDto,
} from '@blendify/contracts'

export const jazzGeneration: PlaylistDetail['generation'] = {
  version: 1,
  kind: 'genre_mix',
  tracksPerSeed: 1,
  seeds: [{ id: 'jazz', name: 'Jazz' }],
  filters: { region: null, femaleVocals: false, releaseRange: null, excludeLive: false },
  popularity: 'balanced',
  orderMode: 'random',
}

export const jazzTrack: TrackDto = {
  id: 'track-1',
  name: 'So What',
  artistId: 'artist-1',
  artistName: 'Miles Davis',
  artists: [
    { id: 'artist-1', name: 'Miles Davis' },
    { id: 'artist-2', name: 'John Coltrane' },
  ],
  albumName: 'Kind of Blue',
  durationMs: 545_000,
  popularity: 0,
  uri: 'spotify:track:track-1',
  externalUrl: 'https://open.spotify.com/track/track-1',
}

export const guestJazzPlaylist: GeneratedPlaylistDto = {
  name: 'Blendify · Mix · Jazz',
  description: 'Jazz, blended.',
  generation: jazzGeneration,
  seeds: [{ type: 'genre', id: 'jazz', name: 'Jazz' }],
  tracks: [jazzTrack],
  transfer: null,
}

export const activePlaylist: PlaylistSummary = {
  id: 'playlist-1',
  name: 'Evening mix',
  description: '',
  kind: 'artist_mix',
  seeds: [{ type: 'artist', id: 'artist-1', name: 'Sade' }],
  seedCount: 1,
  trackCount: 10,
  totalDurationMs: 2_400_000,
  spotifyUrl: 'https://open.spotify.com/playlist/playlist-1',
  spotifyId: 'playlist-1',
  status: 'COMPLETED',
  imageUrl: null,
  createdAt: '2026-09-25T12:00:00.000Z',
  updatedAt: '2026-09-25T12:00:00.000Z',
}

export const emptyLibraryPage: PlaylistLibraryPage = {
  playlists: [],
  total: 0,
  limit: 10,
  offset: 0,
}

export const cleanSyncResult: LibrarySyncResult = {
  checkedCount: 1,
  removedCount: 0,
}

export const spotifyJazzPlaylist: PlaylistDetail = {
  id: 'playlist-1',
  name: 'Blendify · Mix · Jazz',
  description: '',
  kind: 'genre_mix',
  seeds: [{ type: 'genre', id: 'jazz', name: 'Jazz' }],
  seedCount: 1,
  trackCount: 1,
  totalDurationMs: 545_000,
  spotifyUrl: 'https://open.spotify.com/playlist/playlist-1',
  spotifyId: 'playlist-1',
  status: 'COMPLETED',
  imageUrl: null,
  createdAt: '2026-09-25T12:00:00.000Z',
  updatedAt: '2026-09-25T12:00:00.000Z',
  tracks: [jazzTrack],
  generation: jazzGeneration,
}

export const PREVIEW_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
export const PREVIEW_LIFETIME_MS = 30 * 60_000

export const jazzPreviewPlaylist: SpotifyPreviewDto['playlist'] = {
  name: guestJazzPlaylist.name,
  description: guestJazzPlaylist.description,
  generation: guestJazzPlaylist.generation,
  seeds: guestJazzPlaylist.seeds,
  tracks: guestJazzPlaylist.tracks,
}

export function jazzPreview(overrides: Partial<SpotifyPreviewDto> = {}): SpotifyPreviewDto {
  return {
    previewId: PREVIEW_ID,
    expiresAt: new Date(Date.now() + PREVIEW_LIFETIME_MS).toISOString(),
    playlist: jazzPreviewPlaylist,
    ...overrides,
  }
}

export function previewState(
  destination: SpotifyDestinationDto | null,
  overrides: Partial<SpotifyPreviewStateDto> = {},
): SpotifyPreviewStateDto {
  const { previewId, expiresAt, playlist } = jazzPreview()
  return { previewId, expiresAt, playlist, destination, ...overrides }
}

export const publishedDestination: Extract<SpotifyDestinationDto, { status: 'published' }> = {
  status: 'published',
  spotifyUrl: 'https://open.spotify.com/playlist/playlist-1',
  spotifyId: 'playlist-1',
  savedToLibrary: true,
}
