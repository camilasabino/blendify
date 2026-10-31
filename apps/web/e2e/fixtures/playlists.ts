import {
  emptySelectionFilters,
  type GeneratedPlaylistDto,
  type GenerationProgress,
  type PlaylistDetail,
  type SpotifyDestinationDto,
  type SpotifyPreviewDto,
  type SpotifyPreviewStateDto,
} from '@blendify/contracts'

const jazzGeneration: GeneratedPlaylistDto['generation'] = {
  version: 1,
  kind: 'genre_mix',
  tracksPerSeed: 1,
  seeds: [{ id: 'jazz', name: 'Jazz' }],
  popularity: 'balanced',
  orderMode: 'random',
  filters: emptySelectionFilters(),
}

const jazzTrack: GeneratedPlaylistDto['tracks'][number] = {
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

export const generationProgress: GenerationProgress = {
  phase: 'matching_tracks',
  current: 1,
  total: 1,
  percent: 90,
}

export const guestJazzPlaylist: GeneratedPlaylistDto = {
  name: 'Blendify · Mix · Jazz',
  description: 'Jazz, blended.',
  generation: jazzGeneration,
  seeds: [{ type: 'genre', id: 'jazz', name: 'Jazz' }],
  tracks: [jazzTrack],
  transfer: null,
}

export const guestJazzPlaylistWithTransfer: GeneratedPlaylistDto = {
  ...guestJazzPlaylist,
  transfer: {
    token: 'e2e-transfer-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  },
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
export const SECOND_PREVIEW_ID = 'BBBBBBBBBBBBBBBBBBBBBB'

export function jazzPreview(
  overrides: Partial<SpotifyPreviewDto> = {},
): SpotifyPreviewDto {
  return {
    previewId: PREVIEW_ID,
    expiresAt: '2099-01-01T00:30:00.000Z',
    playlist: {
      name: guestJazzPlaylist.name,
      description: guestJazzPlaylist.description,
      generation: guestJazzPlaylist.generation,
      seeds: guestJazzPlaylist.seeds,
      tracks: guestJazzPlaylist.tracks,
    },
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

export const publishedDestination: SpotifyDestinationDto = {
  status: 'published',
  spotifyUrl: 'https://open.spotify.com/playlist/playlist-1',
  spotifyId: 'playlist-1',
  savedToLibrary: true,
  coverUploadFailed: false,
}
