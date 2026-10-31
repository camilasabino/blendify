import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useCapabilities } from '@/hooks/use-capabilities'
import type { SpotifyGenerationOutcome } from '@/lib/playlist-generation'
import { restoreSpotifyPreview } from '@/lib/spotify-preview-save'
import {
  clearStoredSpotifyPreview,
  readStoredSpotifyPreview,
  writeStoredSpotifyPreview,
  type StoredSpotifyPreview,
} from '@/lib/spotify-preview-storage'
import {
  isUnsavedSave,
  usePlaylistRunStore,
  type PlaylistRun,
  type PlaylistRunSpec,
  type SpotifySession,
} from '@/stores/playlist-run-store'

function referenceOf(
  spec: PlaylistRunSpec,
  outcome: SpotifyGenerationOutcome,
  session: SpotifySession,
): StoredSpotifyPreview | null {
  if (spec.mode !== 'spotify' || session.save.phase === 'expired') {
    return null
  }
  const shared = {
    previewId: outcome.preview.previewId,
    expiresAt: outcome.preview.expiresAt,
    title: session.title,
    coverOption: session.coverOption,
    saveAttempted: session.hadSaveAttempt,
  }
  return spec.feature === 'mix'
    ? { ...shared, feature: 'mix', request: spec.request }
    : { ...shared, feature: 'discover', request: spec.request }
}

function storedReferenceOf(run: PlaylistRun | null): StoredSpotifyPreview | null {
  if (!run) {
    return null
  }
  const { status } = run
  if (status.phase === 'active' && status.previous) {
    const { spec, outcome, spotify } = status.previous
    return referenceOf(spec, outcome, spotify)
  }
  if (
    status.phase === 'succeeded' &&
    status.outcome.mode === 'spotify' &&
    status.spotify
  ) {
    return referenceOf(run.spec, status.outcome, status.spotify)
  }
  return null
}

function persist(run: PlaylistRun | null): void {
  const stored = storedReferenceOf(run)
  if (stored) {
    writeStoredSpotifyPreview(stored)
    return
  }
  clearStoredSpotifyPreview()
}

const EXPIRY_KEY_SEPARATOR = '|'
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

function unsavedExpiryKey(run: PlaylistRun | null): string | null {
  if (
    run?.status.phase !== 'succeeded' ||
    run.status.outcome.mode !== 'spotify' ||
    !run.status.spotify ||
    !isUnsavedSave(run.status.spotify.save)
  ) {
    return null
  }
  return [run.id, run.status.outcome.preview.expiresAt].join(EXPIRY_KEY_SEPARATOR)
}

export function useSpotifyPreviewLifecycle(): void {
  const queryClient = useQueryClient()
  const { isResolved, mode } = useCapabilities()
  const restoreStarted = useRef(false)

  useEffect(
    () =>
      usePlaylistRunStore.subscribe((state, previous) => {
        if (
          state.run?.id === previous.run?.id &&
          state.run?.status === previous.run?.status
        ) {
          return
        }
        persist(state.run)
      }),
    [],
  )

  useEffect(() => {
    if (!isResolved) {
      return
    }
    const runs = usePlaylistRunStore.getState()
    if (mode !== 'spotify') {
      restoreStarted.current = false
      runs.abortRestore()
      clearStoredSpotifyPreview()
      if (runs.run?.spec.mode === 'spotify') {
        runs.discard()
      }
      return
    }
    if (restoreStarted.current || runs.run) {
      return
    }
    restoreStarted.current = true
    const stored = readStoredSpotifyPreview()
    if (stored) {
      void restoreSpotifyPreview(stored, queryClient)
    }
  }, [isResolved, mode, queryClient])

  const expiryKey = usePlaylistRunStore((state) => unsavedExpiryKey(state.run))

  useEffect(() => {
    if (expiryKey === null) {
      return
    }
    const [id, expiresAt] = expiryKey.split(EXPIRY_KEY_SEPARATOR)
    const remaining = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    )
    const timer = window.setTimeout(
      () => usePlaylistRunStore.getState().expireUnsaved(Number(id)),
      remaining,
    )
    return () => window.clearTimeout(timer)
  }, [expiryKey])
}
