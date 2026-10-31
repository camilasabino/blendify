import {
  api,
  type GenerateDiscoverRequest,
  type GenerateMixRequest,
  type GeneratedPlaylistDto,
} from '@/lib/api'
import type { SpotifyPreviewPlaylistDto } from '@blendify/contracts'
import type { AppMode } from '@/lib/capabilities'
import type { GenerationProgressHandler } from '@/lib/generation-stream'

export type SpotifyPreviewResult = {
  previewId: string
  expiresAt: string
  playlist: SpotifyPreviewPlaylistDto | null
}

export type SpotifyGenerationOutcome = {
  mode: 'spotify'
  preview: SpotifyPreviewResult
}

export type GuestGenerationOutcome = {
  mode: 'guest'
  playlist: GeneratedPlaylistDto
}

export type GenerationOutcome = SpotifyGenerationOutcome | GuestGenerationOutcome

export type GenerationRun<TRequest> = {
  mode: AppMode
  request: TRequest
  onProgress?: GenerationProgressHandler
  signal?: AbortSignal
}

export async function runMixGeneration({
  mode,
  request,
  onProgress,
  signal,
}: GenerationRun<GenerateMixRequest>): Promise<GenerationOutcome> {
  if (mode === 'spotify') {
    const preview = await api.createMixPreview(request, { onProgress, signal })
    return { mode, preview }
  }
  const playlist = await api.generateMix(request, { onProgress, signal })
  return { mode, playlist }
}

export async function runDiscoverGeneration({
  mode,
  request,
  onProgress,
  signal,
}: GenerationRun<GenerateDiscoverRequest>): Promise<GenerationOutcome> {
  if (mode === 'spotify') {
    const preview = await api.createDiscoverPreview(request, { onProgress, signal })
    return { mode, preview }
  }
  const playlist = await api.generateDiscover(request, { onProgress, signal })
  return { mode, playlist }
}

export function outcomePlaylist(
  outcome: GenerationOutcome,
): GeneratedPlaylistDto | SpotifyPreviewPlaylistDto | null {
  return outcome.mode === 'spotify' ? outcome.preview.playlist : outcome.playlist
}

export function outcomeTrackCount(outcome: GenerationOutcome): number {
  return outcomePlaylist(outcome)?.tracks.length ?? 0
}

export function outcomeDurationMs(outcome: GenerationOutcome): number {
  const playlist = outcomePlaylist(outcome)
  if (!playlist) {
    return 0
  }
  return playlist.tracks.reduce((total, track) => total + track.durationMs, 0)
}

export function outcomeRequestedTrackCount(outcome: GenerationOutcome): number {
  const generation = outcomePlaylist(outcome)?.generation
  if (!generation) {
    return 0
  }
  if (generation.kind === 'artist_mix' || generation.kind === 'genre_mix') {
    return generation.tracksPerSeed * generation.seeds.length
  }
  return generation.targetTrackCount
}
