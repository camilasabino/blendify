import type { GeneratedPlaylistDto, GenerationProgress } from '@blendify/contracts'
import type { MessageKey } from '@/i18n/messages'
import type { useT } from '@/i18n/use-t'
import type { PlaylistRunFailure } from '@/hooks/use-playlist-run'
import { getApiErrorMessage, isSpotifyRateLimited, type EmptyResultFamily } from '@/lib/api'
import { classifyGenerationFailure } from '@/lib/generation-failure'
import {
  outcomeDurationMs,
  outcomeTrackCount,
  type GenerationOutcome,
} from '@/lib/playlist-generation'
import { formatSongCount } from '@/lib/song-count'
import { formatListeningTime, toSafeHttpsUrl, toSpotifyUrl } from '@/lib/utils'

export const GUEST_TRANSFER_MUTATION_KEY = ['guest-transfer'] as const

export function phaseMessageKey(phase: GenerationProgress['phase']): MessageKey {
  switch (phase) {
    case 'resolving_seeds':
      return 'create.progressResolving'
    case 'matching_tracks':
      return 'create.progressMatching'
  }
}

export type GuestArtwork = Readonly<{ imageUrl: string; spotifyUrl: string }>

export function guestArtwork(
  artwork: GeneratedPlaylistDto['coverArtwork'],
): GuestArtwork | null {
  const imageUrl = toSafeHttpsUrl(artwork?.imageUrl)
  const spotifyUrl = toSpotifyUrl(artwork?.spotifyUrl)
  return imageUrl && spotifyUrl ? { imageUrl, spotifyUrl } : null
}

export type RunFailureRecovery = 'retry' | 'reconnect' | 'none'

export type RunFailureView = Readonly<{
  message: string
  recovery: RunFailureRecovery
  explainsSpotifyLimit: boolean
}>

const RECOVERY_BY_KIND = {
  reauth: 'reconnect',
  blocked: 'none',
  retryable: 'retry',
} as const satisfies Record<string, RunFailureRecovery>

export function runFailureView(
  failure: PlaylistRunFailure | null,
  t: ReturnType<typeof useT>,
  fallbackKey: MessageKey,
  emptyResult: EmptyResultFamily = 'mix',
): RunFailureView | null {
  if (!failure) {
    return null
  }
  const { kind } = classifyGenerationFailure(failure.error)
  return {
    message: getApiErrorMessage(failure.error, t, fallbackKey, emptyResult),
    recovery: RECOVERY_BY_KIND[kind],
    explainsSpotifyLimit: kind === 'retryable' && isSpotifyRateLimited(failure.error),
  }
}

export function resultMeta(
  result: GenerationOutcome,
  t: ReturnType<typeof useT>,
): string {
  const durationMs = outcomeDurationMs(result)
  return [
    formatSongCount(outcomeTrackCount(result), t),
    durationMs > 0 ? formatListeningTime(durationMs) : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
