import { create } from 'zustand'
import {
  PLAYLIST_NAME_MAX_LENGTH,
  type PlaylistTransferDto,
  type SpotifyDestinationDto,
} from '@blendify/contracts'
import type {
  GenerateDiscoverRequest,
  GenerateMixRequest,
  GenerationProgress,
} from '@/lib/api'
import type { AppMode } from '@/lib/capabilities'
import type {
  GenerationOutcome,
  SpotifyGenerationOutcome,
} from '@/lib/playlist-generation'

export type PlaylistRunFeature = 'mix' | 'discover'

export type PlaylistRunSpec = {
  mode: AppMode
} & (
  | { feature: 'mix'; request: GenerateMixRequest }
  | { feature: 'discover'; request: GenerateDiscoverRequest }
)

export type SettledSpotifyDestination = Exclude<
  SpotifyDestinationDto,
  { status: 'publishing' }
>

export type SpotifySaveState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'reconciling'; exhausted: boolean }
  | { phase: 'failed'; error: unknown; retryAt: number | null }
  | { phase: 'settled'; destination: SettledSpotifyDestination }
  | { phase: 'expired'; mayHaveSaved: boolean; lostEarly?: true }

export type SpotifySession = {
  title: string
  coverOption: boolean
  coverRenderFailed: boolean
  hadSaveAttempt: boolean
  generationError: unknown
  save: SpotifySaveState
}

export type PreviousPreview = {
  spec: PlaylistRunSpec
  outcome: SpotifyGenerationOutcome
  spotify: SpotifySession
}

export type PlaylistRunStatus =
  | {
      phase: 'active'
      progress: GenerationProgress | null
      previous: PreviousPreview | null
    }
  | {
      phase: 'succeeded'
      outcome: GenerationOutcome
      transfer: PlaylistTransferDto | null
      spotify: SpotifySession | null
    }
  | { phase: 'failed'; error: unknown }

export type PlaylistRun = {
  id: number
  spec: PlaylistRunSpec
  status: PlaylistRunStatus
  seen: boolean
}

export type SaveStart = {
  previewId: string
  title: string
  coverOption: boolean
  signal: AbortSignal
}

type PlaylistRunState = {
  lastId: number
  run: PlaylistRun | null
  controller: AbortController | null
  saveController: AbortController | null
  restoreController: AbortController | null
  begin: (spec: PlaylistRunSpec) => { id: number; signal: AbortSignal } | null
  reportProgress: (id: number, progress: GenerationProgress) => void
  succeed: (id: number, outcome: GenerationOutcome) => boolean
  fail: (id: number, error: unknown) => boolean
  attachTransfer: (id: number, transfer: PlaylistTransferDto) => void
  restore: (
    spec: PlaylistRunSpec,
    outcome: GenerationOutcome,
    transfer: PlaylistTransferDto | null,
  ) => boolean
  beginRestore: () => AbortSignal
  abortRestore: () => void
  restoreSpotify: (
    spec: PlaylistRunSpec,
    outcome: SpotifyGenerationOutcome,
    session: SpotifySession,
  ) => boolean
  setTitle: (id: number, title: string) => void
  setCoverOption: (id: number, coverOption: boolean) => void
  markCoverRenderFailed: (id: number) => void
  beginSave: (id: number) => SaveStart | null
  beginReconcile: (id: number) => AbortSignal | null
  pauseReconcile: (id: number) => void
  settleSave: (id: number, destination: SettledSpotifyDestination) => boolean
  failSave: (id: number, error: unknown, retryAt: number | null) => boolean
  expireUnsaved: (id: number) => void
  markUnavailable: (id: number, mayHaveSaved: boolean) => void
  markSeen: (id: number) => void
  discard: () => void
}

export function isUnsavedSave(save: SpotifySaveState): boolean {
  return save.phase === 'idle' || save.phase === 'failed'
}

export function isSaveInFlight(save: SpotifySaveState): boolean {
  return save.phase === 'saving' || save.phase === 'reconciling'
}

export function spotifySessionOf(run: PlaylistRun | null): SpotifySession | null {
  return run?.status.phase === 'succeeded' ? run.status.spotify : null
}

export function isRunBusy(run: PlaylistRun | null): boolean {
  if (!run) {
    return false
  }
  if (run.status.phase === 'active') {
    return true
  }
  const session = spotifySessionOf(run)
  return session !== null && isSaveInFlight(session.save)
}

export function hasUnsavedPreview(run: PlaylistRun | null): boolean {
  const session = spotifySessionOf(run)
  return session !== null && isUnsavedSave(session.save)
}

export function newSpotifySession(title: string): SpotifySession {
  return {
    title,
    coverOption: true,
    coverRenderFailed: false,
    hadSaveAttempt: false,
    generationError: null,
    save: { phase: 'idle' },
  }
}

export function isValidTitle(title: string): boolean {
  const trimmed = title.trim()
  return trimmed.length > 0 && trimmed.length <= PLAYLIST_NAME_MAX_LENGTH
}

function isActiveRun(run: PlaylistRun | null, id: number): run is PlaylistRun {
  return run?.id === id && run.status.phase === 'active'
}

function isLive(expiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry > now
}

function capturePrevious(
  run: PlaylistRun | null,
  next: PlaylistRunSpec,
): PreviousPreview | null {
  if (
    run?.status.phase !== 'succeeded' ||
    run.spec.mode !== 'spotify' ||
    run.spec.feature !== next.feature ||
    run.status.outcome.mode !== 'spotify' ||
    !run.status.spotify ||
    !isUnsavedSave(run.status.spotify.save) ||
    !run.status.outcome.preview.playlist ||
    !isLive(run.status.outcome.preview.expiresAt)
  ) {
    return null
  }
  return {
    spec: run.spec,
    outcome: run.status.outcome,
    spotify: run.status.spotify,
  }
}

type SpotifyRun = PlaylistRun & {
  status: Extract<PlaylistRunStatus, { phase: 'succeeded' }> & {
    spotify: SpotifySession
  }
}

function asSpotifyRun(run: PlaylistRun | null, id: number): SpotifyRun | null {
  if (run?.id !== id || run.status.phase !== 'succeeded' || !run.status.spotify) {
    return null
  }
  return run as SpotifyRun
}

function withSession(run: SpotifyRun, patch: Partial<SpotifySession>, seen = run.seen): PlaylistRun {
  return {
    ...run,
    seen,
    status: { ...run.status, spotify: { ...run.status.spotify, ...patch } },
  }
}

export const usePlaylistRunStore = create<PlaylistRunState>((set, get) => {
  function updateSession(
    id: number,
    allowed: (save: SpotifySaveState) => boolean,
    patch: (session: SpotifySession) => Partial<SpotifySession>,
    notify: boolean,
  ): boolean {
    const run = asSpotifyRun(get().run, id)
    if (!run || !allowed(run.status.spotify.save)) {
      return false
    }
    set({ run: withSession(run, patch(run.status.spotify), notify ? false : run.seen) })
    return true
  }

  function settleController(): void {
    get().saveController?.abort()
    set({ saveController: null })
  }

  return {
    lastId: 0,
    run: null,
    controller: null,
    saveController: null,
    restoreController: null,
    begin: (spec) => {
      const { run, lastId } = get()
      if (isRunBusy(run)) {
        return null
      }
      const controller = new AbortController()
      const id = lastId + 1
      set({
        lastId: id,
        controller,
        run: {
          id,
          spec,
          status: {
            phase: 'active',
            progress: null,
            previous: capturePrevious(run, spec),
          },
          seen: false,
        },
      })
      return { id, signal: controller.signal }
    },
    reportProgress: (id, progress) => {
      const { run } = get()
      if (!isActiveRun(run, id) || run.status.phase !== 'active') {
        return
      }
      set({
        run: {
          ...run,
          status: { phase: 'active', progress, previous: run.status.previous },
        },
      })
    },
    succeed: (id, outcome) => {
      const { run } = get()
      if (!isActiveRun(run, id)) {
        return false
      }
      const playlistName =
        outcome.mode === 'spotify' ? (outcome.preview.playlist?.name ?? '') : ''
      set({
        controller: null,
        run: {
          ...run,
          seen: false,
          status: {
            phase: 'succeeded',
            outcome,
            transfer: null,
            spotify:
              outcome.mode === 'spotify' ? newSpotifySession(playlistName) : null,
          },
        },
      })
      return true
    },
    fail: (id, error) => {
      const { run } = get()
      if (!isActiveRun(run, id) || run.status.phase !== 'active') {
        return false
      }
      const { previous } = run.status
      if (previous && isLive(previous.outcome.preview.expiresAt)) {
        set({
          controller: null,
          run: {
            id: run.id,
            spec: previous.spec,
            seen: false,
            status: {
              phase: 'succeeded',
              outcome: previous.outcome,
              transfer: null,
              spotify: { ...previous.spotify, generationError: error },
            },
          },
        })
        return true
      }
      set({
        controller: null,
        run: { ...run, seen: false, status: { phase: 'failed', error } },
      })
      return true
    },
    attachTransfer: (id, transfer) => {
      const { run } = get()
      if (run?.id !== id || run.status.phase !== 'succeeded') {
        return
      }
      set({ run: { ...run, status: { ...run.status, transfer } } })
    },
    restore: (spec, outcome, transfer) => {
      const { run, lastId } = get()
      if (run) {
        return false
      }
      const id = lastId + 1
      set({
        lastId: id,
        run: {
          id,
          spec,
          status: { phase: 'succeeded', outcome, transfer, spotify: null },
          seen: true,
        },
      })
      return true
    },
    beginRestore: () => {
      get().restoreController?.abort()
      const controller = new AbortController()
      set({ restoreController: controller })
      return controller.signal
    },
    abortRestore: () => {
      get().restoreController?.abort()
      set({ restoreController: null })
    },
    restoreSpotify: (spec, outcome, session) => {
      const { run, lastId } = get()
      if (run) {
        return false
      }
      const id = lastId + 1
      set({
        lastId: id,
        run: {
          id,
          spec,
          status: { phase: 'succeeded', outcome, transfer: null, spotify: session },
          seen: true,
        },
      })
      return true
    },
    setTitle: (id, title) => {
      updateSession(id, isUnsavedSave, () => ({ title }), false)
    },
    setCoverOption: (id, coverOption) => {
      updateSession(id, isUnsavedSave, () => ({ coverOption }), false)
    },
    markCoverRenderFailed: (id) => {
      updateSession(id, isSaveInFlight, () => ({ coverRenderFailed: true }), false)
    },
    beginSave: (id) => {
      const run = asSpotifyRun(get().run, id)
      if (
        !run ||
        run.status.outcome.mode !== 'spotify' ||
        !isUnsavedSave(run.status.spotify.save) ||
        !run.status.outcome.preview.playlist ||
        !isValidTitle(run.status.spotify.title)
      ) {
        return null
      }
      const { spotify, outcome } = run.status
      const controller = new AbortController()
      set({
        saveController: controller,
        run: withSession(run, {
          save: { phase: 'saving' },
          hadSaveAttempt: true,
          coverRenderFailed: false,
          generationError: null,
        }),
      })
      return {
        previewId: outcome.preview.previewId,
        title: spotify.title,
        coverOption: spotify.coverOption,
        signal: controller.signal,
      }
    },
    beginReconcile: (id) => {
      const run = asSpotifyRun(get().run, id)
      if (!run) {
        return null
      }
      if (!isSaveInFlight(run.status.spotify.save)) {
        return null
      }
      get().saveController?.abort()
      const controller = new AbortController()
      set({
        saveController: controller,
        run: withSession(run, {
          save: { phase: 'reconciling', exhausted: false },
          hadSaveAttempt: true,
        }),
      })
      return controller.signal
    },
    pauseReconcile: (id) => {
      updateSession(
        id,
        (save) => save.phase === 'reconciling',
        () => ({ save: { phase: 'reconciling', exhausted: true } }),
        false,
      )
    },
    settleSave: (id, destination) => {
      const changed = updateSession(
        id,
        isSaveInFlight,
        () => ({ save: { phase: 'settled', destination } }),
        true,
      )
      if (changed) {
        settleController()
      }
      return changed
    },
    failSave: (id, error, retryAt) => {
      const changed = updateSession(
        id,
        isSaveInFlight,
        () => ({ save: { phase: 'failed', error, retryAt } }),
        true,
      )
      if (changed) {
        settleController()
      }
      return changed
    },
    expireUnsaved: (id) => {
      updateSession(
        id,
        isUnsavedSave,
        () => ({ save: { phase: 'expired', mayHaveSaved: false } }),
        true,
      )
    },
    markUnavailable: (id, mayHaveSaved) => {
      const changed = updateSession(
        id,
        (save) => save.phase !== 'settled',
        () => ({ save: { phase: 'expired', mayHaveSaved } }),
        true,
      )
      if (changed) {
        settleController()
      }
    },
    markSeen: (id) => {
      const { run } = get()
      if (run?.id === id && !run.seen) {
        set({ run: { ...run, seen: true } })
      }
    },
    discard: () => {
      get().controller?.abort()
      get().saveController?.abort()
      get().restoreController?.abort()
      set({ run: null, controller: null, saveController: null, restoreController: null })
    },
  }
})
