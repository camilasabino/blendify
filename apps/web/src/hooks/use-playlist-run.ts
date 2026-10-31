import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { PlaylistTransferDto } from '@blendify/contracts'
import type { GenerationProgress } from '@/lib/api'
import type { GenerationOutcome } from '@/lib/playlist-generation'
import {
  rerunPlaylistRun,
  startPlaylistRun,
} from '@/lib/playlist-run-coordinator'
import {
  checkPlaylistPreviewStatus,
  savePlaylistPreview,
} from '@/lib/spotify-preview-save'
import {
  isRunBusy,
  isSaveInFlight,
  spotifySessionOf,
  usePlaylistRunStore,
  type PlaylistRun,
  type PlaylistRunFeature,
  type PlaylistRunSpec,
  type SpotifySession,
} from '@/stores/playlist-run-store'

export type PlaylistRunFailure = { error: unknown }

export type SpotifyPreviewActions = {
  setTitle: (title: string) => void
  setCoverOption: (coverOption: boolean) => void
  save: () => void
  checkStatus: () => void
}

export type PlaylistRunView = {
  run: PlaylistRun | null
  isActive: boolean
  isSaving: boolean
  busyFeature: PlaylistRunFeature | null
  result: GenerationOutcome | null
  progress: GenerationProgress | null
  failure: PlaylistRunFailure | null
  preparedTransfer: PlaylistTransferDto | null
  spotifySession: SpotifySession | null
  spotifyActions: SpotifyPreviewActions
  pendingReplacement: PlaylistRunFeature | null
  start: (spec: PlaylistRunSpec) => boolean
  confirmReplacement: () => void
  cancelReplacement: () => void
  rerun: () => boolean
  dismiss: () => void
  attachTransfer: (transfer: PlaylistTransferDto) => void
}

export function usePlaylistRun(feature: PlaylistRunFeature): PlaylistRunView {
  const queryClient = useQueryClient()
  const current = usePlaylistRunStore((state) => state.run)
  const [pendingSpec, setPendingSpec] = useState<PlaylistRunSpec | null>(null)
  const run = current?.spec.feature === feature ? current : null
  const busyRun = isRunBusy(current) ? current : null
  const blockingFeature =
    busyRun !== null && busyRun.spec.feature !== feature ? busyRun.spec.feature : null
  const status = run?.status
  const session = spotifySessionOf(run)
  const isSaving = session !== null && isSaveInFlight(session.save)

  useEffect(() => {
    if (run && run.status.phase !== 'active' && !run.seen) {
      usePlaylistRunStore.getState().markSeen(run.id)
    }
  }, [run])

  useEffect(
    () => () => {
      const { run: latest, discard: discardRun } = usePlaylistRunStore.getState()
      if (
        latest?.spec.feature === feature &&
        latest.spec.mode === 'guest' &&
        latest.status.phase !== 'succeeded'
      ) {
        discardRun()
      }
    },
    [feature],
  )

  function actOnRun(act: (id: number) => void) {
    if (run) {
      act(run.id)
    }
  }

  return {
    run,
    isActive: status?.phase === 'active',
    isSaving,
    busyFeature: blockingFeature ?? (isSaving ? feature : null),
    result: status?.phase === 'succeeded' ? status.outcome : null,
    progress: status?.phase === 'active' ? status.progress : null,
    failure: status?.phase === 'failed' ? { error: status.error } : null,
    preparedTransfer: status?.phase === 'succeeded' ? status.transfer : null,
    spotifySession: session,
    spotifyActions: {
      setTitle: (title) =>
        actOnRun((id) => usePlaylistRunStore.getState().setTitle(id, title)),
      setCoverOption: (coverOption) =>
        actOnRun((id) => usePlaylistRunStore.getState().setCoverOption(id, coverOption)),
      save: () => void savePlaylistPreview(queryClient),
      checkStatus: () => void checkPlaylistPreviewStatus(queryClient),
    },
    pendingReplacement: pendingSpec ? (current?.spec.feature ?? null) : null,
    start: (spec) => {
      const result = startPlaylistRun(spec)
      if (result === 'needs_confirmation') {
        setPendingSpec(spec)
      }
      return result === 'started'
    },
    confirmReplacement: () => {
      if (pendingSpec) {
        startPlaylistRun(pendingSpec, { confirmedReplacement: true })
      }
      setPendingSpec(null)
    },
    cancelReplacement: () => setPendingSpec(null),
    rerun: () => rerunPlaylistRun(),
    dismiss: () => {
      const { run: latest, discard } = usePlaylistRunStore.getState()
      if (latest?.spec.feature === feature && !isRunBusy(latest)) {
        discard()
      }
    },
    attachTransfer: (transfer) => {
      if (run) {
        usePlaylistRunStore.getState().attachTransfer(run.id, transfer)
      }
    },
  }
}
