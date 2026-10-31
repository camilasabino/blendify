import type { QueryClient } from '@tanstack/react-query'
import type {
  SaveToSpotifyRequest,
  SpotifyPreviewStateDto,
} from '@blendify/contracts'
import { api } from '@/lib/api'
import { ApiError, readRetryAfterSeconds } from '@/lib/api-error'
import { readPersistToLibraryPreference } from '@/lib/persist-to-library-preference'
import { renderPlaylistCoverBase64 } from '@/lib/playlist-cover'
import { classifySaveFailure, isPreviewNotFound } from '@/lib/spotify-save-failure'
import {
  newSpotifySession,
  spotifySessionOf,
  usePlaylistRunStore,
  type PlaylistRunSpec,
  type SettledSpotifyDestination,
  type SpotifySaveState,
} from '@/stores/playlist-run-store'
import type { SpotifyGenerationOutcome } from '@/lib/playlist-generation'
import type { StoredSpotifyPreview } from '@/lib/spotify-preview-storage'

const RECONCILE_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const
const RECONCILE_TIMEOUT_MS = 60_000

type SaveRun = {
  id: number
  previewId: string
}

function reconcileDelay(attempt: number): number {
  return RECONCILE_DELAYS_MS[Math.min(attempt, RECONCILE_DELAYS_MS.length - 1)]
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = window.setTimeout(finish, ms)
    signal.addEventListener('abort', finish)
  })
}

function invalidateLibraryQueries(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['usage-stats'] })
  void queryClient.invalidateQueries({ queryKey: ['playlists'] })
}

function settle(
  queryClient: QueryClient,
  id: number,
  destination: SettledSpotifyDestination,
): void {
  const changed = usePlaylistRunStore.getState().settleSave(id, destination)
  if (changed && destination.status === 'published') {
    invalidateLibraryQueries(queryClient)
  }
}

function retryAtOf(error: unknown): number | null {
  if (!(error instanceof ApiError)) {
    return null
  }
  const seconds = readRetryAfterSeconds(error.details)
  return seconds === null ? null : Date.now() + seconds * 1_000
}

function previewIsLive(expiresAt: string): boolean {
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry > Date.now()
}

function applyState(
  queryClient: QueryClient,
  id: number,
  state: SpotifyPreviewStateDto,
): boolean {
  const { destination } = state
  if (destination?.status === 'published' || destination?.status === 'publish_incomplete') {
    settle(queryClient, id, destination)
    return true
  }
  return false
}

type PollResult = 'settled' | 'publishing' | 'absent' | 'unavailable' | 'error'

async function pollOnce(
  queryClient: QueryClient,
  { id, previewId }: SaveRun,
  signal: AbortSignal,
): Promise<PollResult> {
  try {
    const state = await api.getSpotifyPreview(previewId, { signal })
    if (signal.aborted) {
      return 'error'
    }
    if (applyState(queryClient, id, state)) {
      return 'settled'
    }
    return state.destination?.status === 'publishing' ? 'publishing' : 'absent'
  } catch (error) {
    return isPreviewNotFound(error) ? 'unavailable' : 'error'
  }
}

type ReconcileOptions = {
  absentMeansUnsaved: boolean
  cause: unknown
}

async function reconcile(
  queryClient: QueryClient,
  run: SaveRun,
  { absentMeansUnsaved, cause }: ReconcileOptions,
): Promise<void> {
  const store = usePlaylistRunStore.getState()
  const signal = store.beginReconcile(run.id)
  if (!signal) {
    return
  }

  const deadline = Date.now() + RECONCILE_TIMEOUT_MS
  let attempt = 0
  while (!signal.aborted) {
    const wait = Math.min(reconcileDelay(attempt), Math.max(0, deadline - Date.now()))
    attempt += 1
    await sleep(wait, signal)
    if (signal.aborted) {
      return
    }

    const result = await pollOnce(queryClient, run, signal)
    if (signal.aborted || result === 'settled') {
      return
    }
    if (result === 'unavailable') {
      usePlaylistRunStore.getState().markUnavailable(run.id, true)
      return
    }
    if (result === 'absent' && absentMeansUnsaved) {
      usePlaylistRunStore.getState().failSave(run.id, cause, null)
      return
    }
    if (Date.now() >= deadline) {
      usePlaylistRunStore.getState().pauseReconcile(run.id)
      return
    }
  }
}

async function buildSaveInput(
  id: number,
  spec: PlaylistRunSpec,
  rawTitle: string,
  coverOption: boolean,
): Promise<SaveToSpotifyRequest> {
  const title = rawTitle.trim()
  let coverImageBase64: string | undefined
  if (coverOption) {
    try {
      coverImageBase64 = await renderPlaylistCoverBase64({
        title,
        kind: spec.feature === 'mix' ? 'mix' : 'discover',
      })
    } catch {
      usePlaylistRunStore.getState().markCoverRenderFailed(id)
    }
  }
  return {
    name: title,
    persistToLibrary: readPersistToLibraryPreference(),
    coverImageBase64,
  }
}

function handleSaveFailure(
  queryClient: QueryClient,
  run: SaveRun,
  error: unknown,
): void {
  const failureClass = classifySaveFailure(error)
  if (failureClass === 'not_found') {
    usePlaylistRunStore.getState().markUnavailable(run.id, true)
    return
  }
  if (failureClass === 'definite') {
    usePlaylistRunStore.getState().failSave(run.id, error, retryAtOf(error))
    return
  }
  void reconcile(queryClient, run, {
    absentMeansUnsaved: failureClass === 'unknown',
    cause: error,
  })
}

export async function savePlaylistPreview(queryClient: QueryClient): Promise<void> {
  const store = usePlaylistRunStore.getState()
  const { run } = store
  if (!run || run.status.phase !== 'succeeded' || run.status.outcome.mode !== 'spotify') {
    return
  }
  const started = store.beginSave(run.id)
  if (!started) {
    return
  }

  const saveRun = { id: run.id, previewId: started.previewId }
  const input = await buildSaveInput(run.id, run.spec, started.title, started.coverOption)
  if (started.signal.aborted) {
    return
  }

  try {
    const state = await api.saveSpotifyPreview(started.previewId, input)
    if (!applyState(queryClient, run.id, state)) {
      void reconcile(queryClient, saveRun, { absentMeansUnsaved: false, cause: null })
    }
  } catch (error) {
    handleSaveFailure(queryClient, saveRun, error)
  }
}

export async function checkPlaylistPreviewStatus(queryClient: QueryClient): Promise<void> {
  const { run } = usePlaylistRunStore.getState()
  const session = spotifySessionOf(run)
  if (
    !run ||
    run.status.phase !== 'succeeded' ||
    run.status.outcome.mode !== 'spotify' ||
    session?.save.phase !== 'reconciling' ||
    !session.save.exhausted
  ) {
    return
  }
  const saveRun = { id: run.id, previewId: run.status.outcome.preview.previewId }
  const signal = usePlaylistRunStore.getState().beginReconcile(run.id)
  if (!signal) {
    return
  }

  const result = await pollOnce(queryClient, saveRun, signal)
  if (signal.aborted || result === 'settled') {
    return
  }
  if (result === 'unavailable') {
    usePlaylistRunStore.getState().markUnavailable(run.id, true)
    return
  }
  if (result === 'absent') {
    usePlaylistRunStore.getState().failSave(run.id, null, null)
    return
  }
  usePlaylistRunStore.getState().pauseReconcile(run.id)
}

function unavailableSave(stored: StoredSpotifyPreview): SpotifySaveState {
  if (stored.saveAttempted) {
    return { phase: 'expired', mayHaveSaved: true }
  }
  return previewIsLive(stored.expiresAt)
    ? { phase: 'expired', mayHaveSaved: false, lostEarly: true }
    : { phase: 'expired', mayHaveSaved: false }
}

export async function restoreSpotifyPreview(
  stored: StoredSpotifyPreview,
  queryClient: QueryClient,
): Promise<void> {
  const spec: PlaylistRunSpec =
    stored.feature === 'mix'
      ? { mode: 'spotify', feature: 'mix', request: stored.request }
      : { mode: 'spotify', feature: 'discover', request: stored.request }
  const session = { ...newSpotifySession(stored.title), coverOption: stored.coverOption }

  const signal = usePlaylistRunStore.getState().beginRestore()
  let state: SpotifyPreviewStateDto
  try {
    state = await api.getSpotifyPreview(stored.previewId, { signal })
  } catch (error) {
    if (!signal.aborted && isPreviewNotFound(error)) {
      usePlaylistRunStore.getState().restoreSpotify(
        spec,
        { mode: 'spotify', preview: { previewId: stored.previewId, expiresAt: stored.expiresAt, playlist: null } },
        { ...session, hadSaveAttempt: stored.saveAttempted, save: unavailableSave(stored) },
      )
    }
    return
  }
  if (signal.aborted) {
    return
  }

  const outcome: SpotifyGenerationOutcome = {
    mode: 'spotify',
    preview: {
      previewId: state.previewId,
      expiresAt: state.expiresAt,
      playlist: state.playlist,
    },
  }
  const { destination } = state
  if (destination?.status === 'published' || destination?.status === 'publish_incomplete') {
    usePlaylistRunStore.getState().restoreSpotify(spec, outcome, {
      ...session,
      hadSaveAttempt: true,
      save: { phase: 'settled', destination },
    })
    return
  }

  const isPublishing = destination?.status === 'publishing'
  const restored = usePlaylistRunStore.getState().restoreSpotify(spec, outcome, {
    ...session,
    hadSaveAttempt: stored.saveAttempted || isPublishing,
    save: isPublishing ? { phase: 'reconciling', exhausted: false } : { phase: 'idle' },
  })
  if (restored && isPublishing) {
    const run = usePlaylistRunStore.getState().run
    if (run) {
      void reconcile(
        queryClient,
        { id: run.id, previewId: state.previewId },
        { absentMeansUnsaved: true, cause: null },
      )
    }
  }
}
