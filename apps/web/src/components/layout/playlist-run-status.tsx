import { useId } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { X } from 'lucide-react'
import { GenerationProgressBar } from '@/components/playlist/generation-result-panel'
import { phaseMessageKey } from '@/components/playlist/generation-result-helpers'
import { generationFormCopy } from '@/components/playlist/generation-options'
import { PLAYLIST_RUN_COPY } from '@/components/playlist/playlist-run-copy'
import { buttonVariants } from '@/components/ui/button'
import { useT } from '@/i18n/use-t'
import type { MessageKey } from '@/i18n/messages'
import { outcomePlaylist } from '@/lib/playlist-generation'
import { cn, focusRing } from '@/lib/utils'
import {
  isRunBusy,
  usePlaylistRunStore,
  type PlaylistRun,
  type PlaylistRunFeature,
  type SpotifySession,
} from '@/stores/playlist-run-store'

type RunPresentation = {
  title: MessageKey
  action: MessageKey
  detail: string | null
  progress: boolean
  isFailure: boolean
}

function describeSpotifyRun(
  session: SpotifySession,
  copy: (typeof PLAYLIST_RUN_COPY)[PlaylistRunFeature],
  detail: string | null,
): RunPresentation {
  const { save } = session
  switch (save.phase) {
    case 'saving':
      return { title: copy.saving, action: 'runStatus.viewProgress', detail, progress: true, isFailure: false }
    case 'reconciling':
      return { title: copy.confirming, action: 'runStatus.viewProgress', detail, progress: true, isFailure: false }
    case 'settled':
      return save.destination.status === 'published'
        ? { title: copy.saved, action: 'runStatus.viewPlaylist', detail, progress: false, isFailure: false }
        : { title: copy.incomplete, action: 'runStatus.viewDetails', detail, progress: false, isFailure: true }
    case 'expired':
      return { title: copy.expired, action: 'runStatus.viewDetails', detail: null, progress: false, isFailure: true }
    case 'idle':
    case 'failed':
      return { title: copy.preview, action: 'runStatus.viewPreview', detail, progress: false, isFailure: false }
  }
}

function describeRun(
  run: PlaylistRun,
  t: ReturnType<typeof useT>,
): RunPresentation {
  const copy = PLAYLIST_RUN_COPY[run.spec.feature]
  const { status } = run
  if (status.phase === 'active') {
    const { progress } = status
    const hint = generationFormCopy(run.spec.mode, run.spec.feature).workingHint
    return {
      title: copy.active,
      action: 'runStatus.viewProgress',
      detail: progress
        ? `${t(phaseMessageKey(progress.phase))} · ${progress.percent}%`
        : t(hint),
      progress: true,
      isFailure: false,
    }
  }
  if (status.phase === 'succeeded') {
    const detail =
      status.spotify?.title.trim() || outcomePlaylist(status.outcome)?.name || null
    if (status.spotify) {
      return describeSpotifyRun(status.spotify, copy, detail)
    }
    return {
      title: copy.succeeded,
      action: 'runStatus.viewPlaylist',
      detail,
      progress: false,
      isFailure: false,
    }
  }
  return {
    title: copy.failed,
    action: 'runStatus.viewDetails',
    detail: null,
    progress: false,
    isFailure: true,
  }
}

function RunStatusCard({ run }: Readonly<{ run: PlaylistRun }>) {
  const t = useT()
  const titleId = useId()
  const { title, action, detail, progress } = describeRun(run, t)
  const isBusy = isRunBusy(run)
  const activeProgress = run.status.phase === 'active' ? run.status.progress : null

  return (
    <section
      aria-label={t('runStatus.label')}
      className="animate-fade-up fixed inset-x-4 bottom-4 z-40 space-y-3 rounded-panel border border-accent-line/50 bg-panel p-4 shadow-[0_24px_60px_-24px_rgb(0_0_0_/_0.95)] sm:inset-x-auto sm:right-6 sm:w-96"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p id={titleId} className="text-sm font-medium text-cream-50">
            {t(title)}
          </p>
          {detail ? (
            <p className="break-words text-xs text-cream-300">{detail}</p>
          ) : null}
        </div>
        {isBusy ? null : (
          <button
            type="button"
            aria-label={t('runStatus.dismiss')}
            onClick={() => usePlaylistRunStore.getState().markSeen(run.id)}
            className={cn(
              'shrink-0 rounded-control p-1.5 text-cream-300 transition-colors hover:bg-hover hover:text-cream-50',
              focusRing,
            )}
          >
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {progress ? (
        <GenerationProgressBar
          progress={activeProgress}
          progressLabel={t(title)}
        />
      ) : null}
      <Link
        to={PLAYLIST_RUN_COPY[run.spec.feature].originPath}
        aria-describedby={titleId}
        className={buttonVariants({ variant: 'secondary', size: 'sm' })}
      >
        {t(action)}
      </Link>
    </section>
  )
}

function terminalAnnouncement(
  run: PlaylistRun,
  t: ReturnType<typeof useT>,
): { message: string; isFailure: boolean } | null {
  if (isRunBusy(run)) {
    return null
  }
  const { title, detail, isFailure } = describeRun(run, t)
  return {
    message: [t(title), detail].filter(Boolean).join('. '),
    isFailure,
  }
}

export function PlaylistRunStatus() {
  const t = useT()
  const { pathname } = useLocation()
  const run = usePlaylistRunStore((state) => state.run)
  const isOriginRoute =
    run !== null && pathname === PLAYLIST_RUN_COPY[run.spec.feature].originPath
  const visibleRun =
    run !== null &&
    !isOriginRoute &&
    (isRunBusy(run) || !run.seen)
      ? run
      : null
  const announcement = visibleRun ? terminalAnnouncement(visibleRun, t) : null

  return (
    <>
      <output className="sr-only">
        {announcement && !announcement.isFailure ? announcement.message : ''}
      </output>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement?.isFailure ? announcement.message : ''}
      </div>
      {visibleRun ? <RunStatusCard run={visibleRun} /> : null}
    </>
  )
}
