import { useId } from 'react'
import { Blend, CircleCheck, Clock, RotateCcw } from 'lucide-react'
import type {
  GeneratedPlaylistDto,
  GenerationProgress,
  PlaylistTransferDto,
} from '@blendify/contracts'
import { LastFmAttribution } from '@/components/brand/lastfm-attribution'
import { SpotifyLimitExplanation } from '@/components/brand/spotify-limit-explanation'
import { SpotifyLogo } from '@/components/brand/spotify-mark'
import { GeneratedTrackList } from '@/components/playlist/generated-track-list'
import {
  guestArtwork,
  phaseMessageKey,
  type GuestArtwork,
  type RunFailureRecovery,
  type RunFailureView,
} from '@/components/playlist/generation-result-helpers'
import {
  FillStatusMessages,
  NextStepActions,
} from '@/components/playlist/generation-result-parts'
import { resultMeta } from '@/components/playlist/generation-result-helpers'
import {
  SpotifyPreviewResult,
  type SpotifyPreviewResultProps,
} from '@/components/playlist/spotify-preview-result'
import { TransferAction } from '@/components/playlist/transfer-action'
import { Button } from '@/components/ui/button'
import { useConnectSpotify } from '@/hooks/use-connect-spotify'
import { useGenerationFill } from '@/hooks/use-generation-feedback'
import { useT } from '@/i18n/use-t'
import type { MessageKey } from '@/i18n/messages'
import type { AppMode } from '@/lib/capabilities'
import type { GenerationOutcome } from '@/lib/playlist-generation'
import { cn, focusRing } from '@/lib/utils'

function songProgressLabel(
  progress: GenerationProgress,
  t: ReturnType<typeof useT>,
): string | null {
  if (progress.phase !== 'matching_tracks') {
    return null
  }
  return t('create.progressCount', {
    current: progress.current,
    total: progress.total,
  })
}

function progressAnnouncement(
  progress: GenerationProgress | null,
  workingHintKey: MessageKey,
  t: ReturnType<typeof useT>,
): string {
  if (!progress) {
    return t(workingHintKey)
  }
  const label = t(phaseMessageKey(progress.phase))
  const count = songProgressLabel(progress, t)
  return count ? `${label}, ${count}` : label
}

export function GenerationProgressBar({
  progress,
  progressLabel,
}: Readonly<{
  progress: GenerationProgress | null
  progressLabel: string
}>) {
  const percent = progress?.percent ?? 0
  return (
    <progress
      className={cn(
        'generation-progress h-1.5 w-full overflow-hidden rounded-full',
        !progress && 'generation-progress--indeterminate',
      )}
      max={100}
      value={progress ? percent : undefined}
      aria-label={progressLabel}
    />
  )
}

function readyKey(mode: AppMode): MessageKey {
  return mode === 'guest' ? 'create.readyGuest' : 'create.ready'
}

function failedTitleKey(mode: AppMode): MessageKey {
  return mode === 'guest' ? 'create.failedTitleGuest' : 'create.failedTitle'
}

function leaveNoteKey(mode: AppMode): MessageKey {
  return mode === 'guest' ? 'create.leaveNoteGuest' : 'spotifyPreview.leaveNote'
}

function GeneratingState({
  mode,
  progress,
  workingHintKey,
  requestStarted,
}: Readonly<{
  mode: AppMode
  progress: GenerationProgress | null
  workingHintKey: MessageKey
  requestStarted: boolean
}>) {
  const t = useT()
  const percent = progress?.percent ?? 0
  const progressLabel = progress
    ? t(phaseMessageKey(progress.phase))
    : t(workingHintKey)
  const progressCount = progress ? songProgressLabel(progress, t) : null
  const metaLine = progressCount ?? ''

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm font-medium text-cream-200">{progressLabel}</p>
        {progress ? (
          <span className="shrink-0 text-xs font-medium tabular-nums text-accent-fg">
            {percent}%
          </span>
        ) : null}
      </div>
      <GenerationProgressBar
        progress={progress}
        progressLabel={progressLabel}
      />
      {metaLine ? (
        <p className="text-xs text-cream-400">{metaLine}</p>
      ) : null}
      {requestStarted ? (
        <p className="text-xs leading-relaxed text-cream-400">
          {t(leaveNoteKey(mode))}
        </p>
      ) : null}
    </div>
  )
}

function ReconnectAction() {
  const t = useT()
  const connectSpotify = useConnectSpotify()
  return (
    <Button type="button" variant="secondary" onClick={connectSpotify}>
      {t('nav.connectSpotify')}
    </Button>
  )
}

function GenerationErrorActions({
  recovery,
  onRetry,
}: Readonly<{
  recovery: RunFailureRecovery
  onRetry: () => void
}>) {
  const t = useT()
  switch (recovery) {
    case 'retry':
      return (
        <Button type="button" variant="secondary" onClick={onRetry}>
          <RotateCcw aria-hidden className="size-4" />
          {t('common.retry')}
        </Button>
      )
    case 'reconnect':
      return <ReconnectAction />
    case 'none':
      return null
  }
}

function GenerationErrorState({
  failure,
  onRetry,
}: Readonly<{
  failure: RunFailureView
  onRetry: () => void
}>) {
  return (
    <div className="space-y-4">
      <p role="alert" className="text-sm leading-relaxed text-danger">
        {failure.message}
      </p>
      {failure.explainsSpotifyLimit ? <SpotifyLimitExplanation /> : null}
      <GenerationErrorActions recovery={failure.recovery} onRetry={onRetry} />
    </div>
  )
}

export function GuestCover({ artwork }: Readonly<{ artwork: GuestArtwork | null }>) {
  const t = useT()
  if (artwork) {
    return (
      <a
        href={artwork.spotifyUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={t('guestResult.openArtworkInSpotify')}
        title={t('guestResult.openArtworkInSpotify')}
        className={cn('shrink-0 rounded-control', focusRing)}
      >
        <img
          src={artwork.imageUrl}
          alt=""
          className="size-20 rounded-control object-cover ring-1 ring-divider sm:size-24"
        />
      </a>
    )
  }
  return (
    <span className="flex size-20 shrink-0 items-center justify-center rounded-card bg-linear-to-br from-amber-400 to-amber-700 text-on-accent sm:size-24">
      <Blend aria-hidden className="size-7" />
    </span>
  )
}

function GuestReadyResult({
  outcome,
  playlist,
  requestedTrackCount,
  preparedTransfer,
  onTransferPrepared,
  onRegenerate,
  onAdjust,
  onCreateAnother,
}: Readonly<{
  outcome: GenerationOutcome
  playlist: GeneratedPlaylistDto
  requestedTrackCount: number
  preparedTransfer: PlaylistTransferDto | null
  onTransferPrepared?: (transfer: PlaylistTransferDto) => void
  onRegenerate: () => void
  onAdjust: () => void
  onCreateAnother: () => void
}>) {
  const t = useT()
  const trackCount = playlist.tracks.length
  const { isNearCompleteFill, isShortFill } = useGenerationFill(
    trackCount,
    requestedTrackCount,
  )
  const artwork = guestArtwork(playlist.coverArtwork)

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <GuestCover artwork={artwork} />
          <div className="min-w-0 space-y-2">
            {playlist.description ? (
              <p className="break-words text-sm text-cream-200">
                {playlist.description}
              </p>
            ) : null}
            <p className="text-sm text-cream-300">{resultMeta(outcome, t)}</p>
            <FillStatusMessages
              trackCount={trackCount}
              requestedTrackCount={requestedTrackCount}
              isNearCompleteFill={isNearCompleteFill}
              isShortFill={isShortFill}
            />
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-cream-400">
              <span>
                {artwork
                  ? t('guestResult.attributionWithArtwork')
                  : t('guestResult.attribution')}
              </span>
              <SpotifyLogo />
            </p>
          </div>
        </div>
        <p className="flex items-start gap-2 text-sm leading-relaxed text-cream-300">
          <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-cream-400" />
          {t('guestResult.temporary')}
        </p>
        {playlist.transfer ? (
          <TransferAction
            key={playlist.transfer.token}
            offer={playlist.transfer}
            preparedTransfer={preparedTransfer}
            onPrepared={onTransferPrepared}
            onRegenerate={onRegenerate}
          />
        ) : null}
        <NextStepActions
          onAdjust={onAdjust}
          onCreateAnother={onCreateAnother}
        />
        <LastFmAttribution />
      </div>
      <GeneratedTrackList tracks={playlist.tracks} />
    </div>
  )
}

export type SpotifyPanelBinding = Readonly<
  Pick<SpotifyPreviewResultProps, 'session' | 'actions' | 'focusOnArrival'>
>

function GuestResultBody({
  outcome,
  requestedTrackCount,
  preparedTransfer,
  onTransferPrepared,
  onRetry,
  onAdjust,
  onCreateAnother,
}: Readonly<{
  outcome: GenerationOutcome & { mode: 'guest' }
  requestedTrackCount: number
  preparedTransfer: PlaylistTransferDto | null
  onTransferPrepared?: (transfer: PlaylistTransferDto) => void
  onRetry: () => void
  onAdjust: () => void
  onCreateAnother: () => void
}>) {
  return (
    <GuestReadyResult
      outcome={outcome}
      playlist={outcome.playlist}
      requestedTrackCount={requestedTrackCount}
      preparedTransfer={preparedTransfer}
      onTransferPrepared={onTransferPrepared}
      onRegenerate={onRetry}
      onAdjust={onAdjust}
      onCreateAnother={onCreateAnother}
    />
  )
}

export function GenerationResultPanel({
  mode,
  isGenerating,
  result,
  progress,
  failure,
  requestedTrackCount,
  workingTitleKey,
  workingHintKey,
  requestStarted = false,
  preparedTransfer = null,
  onTransferPrepared,
  spotify = null,
  copied,
  onCopy,
  onRetry,
  onAdjust,
  onCreateAnother,
}: Readonly<{
  mode: AppMode
  isGenerating: boolean
  result: GenerationOutcome | null
  progress: GenerationProgress | null
  failure: RunFailureView | null
  requestedTrackCount: number
  workingTitleKey: MessageKey
  workingHintKey: MessageKey
  requestStarted?: boolean
  preparedTransfer?: PlaylistTransferDto | null
  onTransferPrepared?: (transfer: PlaylistTransferDto) => void
  spotify?: SpotifyPanelBinding | null
  copied: boolean
  onCopy: (url: string) => void
  onRetry: () => void
  onAdjust: () => void
  onCreateAnother: () => void
}>) {
  const t = useT()
  const titleId = useId()

  if (!isGenerating && !result && !failure) {
    return null
  }

  const showError = !isGenerating && failure != null
  const showResult = !isGenerating && !showError && result != null
  const spotifyResult =
    showResult && result.mode === 'spotify' && spotify !== null ? result : null
  const guestResult = showResult && result.mode === 'guest' ? result : null
  const readyLabel = t(readyKey(result?.mode ?? mode))
  let title = readyLabel
  if (guestResult) {
    title = guestResult.playlist.name
  }
  if (isGenerating) {
    title = t(workingTitleKey)
  } else if (showError) {
    title = t(failedTitleKey(mode))
  }

  let announcement = ''
  if (isGenerating) {
    announcement = progressAnnouncement(progress, workingHintKey, t)
  } else if (guestResult) {
    announcement = `${readyLabel}: ${guestResult.playlist.name}. ${resultMeta(guestResult, t)}`
  }

  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'animate-fade-up space-y-4 rounded-panel border bg-panel bg-linear-to-br to-transparent to-60% p-5 shadow-[0_24px_60px_-36px_rgb(0_0_0_/_0.95)] sm:p-6',
        showError
          ? 'border-danger-line from-danger-soft'
          : 'border-accent-line/50 from-amber-500/[0.12]',
      )}
    >
      {spotifyResult && spotify ? (
        <SpotifyPreviewResult
          titleId={titleId}
          outcome={spotifyResult}
          session={spotify.session}
          actions={spotify.actions}
          requestedTrackCount={requestedTrackCount}
          focusOnArrival={spotify.focusOnArrival}
          copied={copied}
          onCopy={onCopy}
          onGenerateAgain={onRetry}
          onAdjust={onAdjust}
          onCreateAnother={onCreateAnother}
        />
      ) : (
        <>
          <div className="space-y-1">
            {guestResult ? (
              <p className="flex items-center gap-1.5 text-eyebrow text-accent-fg">
                <CircleCheck aria-hidden className="size-3.5" />
                {readyLabel}
              </p>
            ) : null}
            <h2
              id={titleId}
              className={cn(
                'font-display font-semibold text-cream-50',
                guestResult ? 'break-words text-xl sm:text-2xl' : 'text-lg',
              )}
            >
              {title}
            </h2>
          </div>
          <output className="sr-only">{announcement}</output>
        </>
      )}
      {isGenerating ? (
        <GeneratingState
          mode={mode}
          progress={progress}
          workingHintKey={workingHintKey}
          requestStarted={requestStarted}
        />
      ) : null}
      {showError ? <GenerationErrorState failure={failure} onRetry={onRetry} /> : null}
      {guestResult ? (
        <GuestResultBody
          outcome={guestResult}
          requestedTrackCount={requestedTrackCount}
          preparedTransfer={preparedTransfer}
          onTransferPrepared={onTransferPrepared}
          onRetry={onRetry}
          onAdjust={onAdjust}
          onCreateAnother={onCreateAnother}
        />
      ) : null}
    </section>
  )
}
