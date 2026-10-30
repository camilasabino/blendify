import { useEffect, useState } from 'react'
import { useCapabilities } from '@/hooks/use-capabilities'
import {
  clearStoredGuestResult,
  readStoredGuestResult,
  writeStoredGuestResult,
  type StoredGuestResult,
} from '@/lib/guest-result-storage'
import {
  usePlaylistRunStore,
  type PlaylistRun,
  type PlaylistRunSpec,
} from '@/stores/playlist-run-store'

function storedResultOf(run: PlaylistRun | null): StoredGuestResult | null {
  if (run?.spec.mode !== 'guest' || run.status.phase !== 'succeeded') {
    return null
  }
  const { spec, status } = run
  if (status.outcome.mode !== 'guest') {
    return null
  }
  const saved = { playlist: status.outcome.playlist, transfer: status.transfer }
  return spec.feature === 'mix'
    ? { ...saved, feature: 'mix', request: spec.request }
    : { ...saved, feature: 'discover', request: spec.request }
}

function specOf(stored: StoredGuestResult): PlaylistRunSpec {
  const base = {
    mode: 'guest',
    publication: { persistToLibrary: false },
    coverFailed: false,
  } as const
  return stored.feature === 'mix'
    ? { ...base, feature: 'mix', request: stored.request }
    : { ...base, feature: 'discover', request: stored.request }
}

function persist(run: PlaylistRun | null): boolean {
  const stored = storedResultOf(run)
  if (!stored) {
    clearStoredGuestResult()
    return true
  }
  return writeStoredGuestResult(stored)
}

export function useGuestResultPersistence(): { isResultUnsaved: boolean } {
  const { isResolved, mode } = useCapabilities()
  const [isResultUnsaved, setIsResultUnsaved] = useState(false)

  useEffect(
    () =>
      usePlaylistRunStore.subscribe((state, previous) => {
        if (
          state.run?.id === previous.run?.id &&
          state.run?.status === previous.run?.status
        ) {
          return
        }
        setIsResultUnsaved(!persist(state.run))
      }),
    [],
  )

  useEffect(() => {
    if (!isResolved) {
      return
    }
    const runs = usePlaylistRunStore.getState()
    if (mode !== 'guest') {
      clearStoredGuestResult()
      if (runs.run?.spec.mode === 'guest') {
        runs.discard()
      }
      return
    }
    const stored = readStoredGuestResult()
    if (stored) {
      runs.restore(
        specOf(stored),
        { mode: 'guest', playlist: stored.playlist },
        stored.transfer,
      )
    }
  }, [isResolved, mode])

  return { isResultUnsaved }
}
