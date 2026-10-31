import { canRetryGeneration } from '@/lib/generation-failure'
import {
  runDiscoverGeneration,
  runMixGeneration,
  type GenerationOutcome,
} from '@/lib/playlist-generation'
import {
  hasUnsavedPreview,
  isRunBusy,
  usePlaylistRunStore,
  type PlaylistRunSpec,
} from '@/stores/playlist-run-store'
import type { GenerationProgressHandler } from '@/lib/generation-stream'

export type StartResult = 'started' | 'blocked' | 'needs_confirmation'

function runGeneration(
  spec: PlaylistRunSpec,
  onProgress: GenerationProgressHandler,
  signal: AbortSignal,
): Promise<GenerationOutcome> {
  const { mode } = spec
  if (spec.feature === 'mix') {
    return runMixGeneration({ mode, request: spec.request, onProgress, signal })
  }
  return runDiscoverGeneration({ mode, request: spec.request, onProgress, signal })
}

async function executeRun(
  spec: PlaylistRunSpec,
  id: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    const outcome = await runGeneration(
      spec,
      (progress) => usePlaylistRunStore.getState().reportProgress(id, progress),
      signal,
    )
    usePlaylistRunStore.getState().succeed(id, outcome)
  } catch (error) {
    usePlaylistRunStore.getState().fail(id, error)
  }
}

export function replacesUnsavedPreview(spec: PlaylistRunSpec): boolean {
  const { run } = usePlaylistRunStore.getState()
  return (
    spec.mode === 'spotify' &&
    run !== null &&
    run.spec.feature !== spec.feature &&
    hasUnsavedPreview(run)
  )
}

export function startPlaylistRun(
  spec: PlaylistRunSpec,
  options: { confirmedReplacement?: boolean } = {},
): StartResult {
  if (isRunBusy(usePlaylistRunStore.getState().run)) {
    return 'blocked'
  }
  if (!options.confirmedReplacement && replacesUnsavedPreview(spec)) {
    return 'needs_confirmation'
  }
  const started = usePlaylistRunStore.getState().begin(spec)
  if (!started) {
    return 'blocked'
  }
  void executeRun(spec, started.id, started.signal)
  return 'started'
}

export function rerunPlaylistRun(): boolean {
  const { run } = usePlaylistRunStore.getState()
  if (!run || run.status.phase === 'active') {
    return false
  }
  if (run.status.phase === 'failed' && !canRetryGeneration(run.status.error)) {
    return false
  }
  if (run.status.phase === 'succeeded') {
    const session = run.status.spotify
    if (session && session.save.phase !== 'expired') {
      return false
    }
  }
  return startPlaylistRun(run.spec) === 'started'
}
