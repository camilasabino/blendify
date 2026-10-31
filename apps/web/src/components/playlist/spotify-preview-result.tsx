import { useEffect, useId, useRef, useState } from 'react'
import { Check, Clock, Copy } from 'lucide-react'
import type { SpotifyPreviewPlaylistDto } from '@blendify/contracts'
import { LastFmAttribution } from '@/components/brand/lastfm-attribution'
import { GeneratedTrackList } from '@/components/playlist/generated-track-list'
import {
  FillStatusMessages,
  NextStepActions,
} from '@/components/playlist/generation-result-parts'
import { resultMeta } from '@/components/playlist/generation-result-helpers'
import { CoverToggle } from '@/components/playlist/generation-form-shared'
import { PlaylistPreview } from '@/components/playlist/playlist-preview'
import { PlaylistTitleField } from '@/components/spotify-destination/playlist-title-field'
import { SpotifyDestinationOutcome } from '@/components/spotify-destination/spotify-destination-outcome'
import {
  destinationCardClassName,
  SpotifySavePanel,
} from '@/components/spotify-destination/spotify-save-panel'
import { Button } from '@/components/ui/button'
import type { SpotifyPreviewActions } from '@/hooks/use-playlist-run'
import { useGenerationFill } from '@/hooks/use-generation-feedback'
import { useT } from '@/i18n/use-t'
import type { MessageKey } from '@/i18n/messages'
import { readPersistToLibraryPreference } from '@/lib/persist-to-library-preference'
import type { SpotifyGenerationOutcome } from '@/lib/playlist-generation'
import {
  isSaveInFlight,
  isUnsavedSave,
  isValidTitle,
  type SettledSpotifyDestination,
  type SpotifySession,
} from '@/stores/playlist-run-store'
import { toSafeHttpsUrl } from '@/lib/utils'

const COVER_HINT_KEYS = {
  artist_mix: 'create.coverHintArtists',
  genre_mix: 'create.coverHintGenres',
  discover_artist: 'discover.coverHintArtist',
  discover_track: 'discover.coverHintTrack',
} as const satisfies Record<
  SpotifyPreviewPlaylistDto['generation']['kind'],
  MessageKey
>

export type SpotifyPreviewResultProps = Readonly<{
  titleId: string
  outcome: SpotifyGenerationOutcome
  session: SpotifySession
  actions: SpotifyPreviewActions
  requestedTrackCount: number
  focusOnArrival: boolean
  copied: boolean
  onCopy: (url: string) => void
  onGenerateAgain: () => void
  onAdjust: () => void
  onCreateAnother: () => void
}>

function expiredMessage(
  save: Extract<SpotifySession['save'], { phase: 'expired' }>,
  t: ReturnType<typeof useT>,
): string {
  if (save.mayHaveSaved) {
    return t('spotifyPreview.unavailableMaybeSaved')
  }
  return save.lostEarly ? t('spotifyPreview.lost') : t('spotifyPreview.expired')
}

function sessionAnnouncement(
  session: SpotifySession,
  playlist: SpotifyPreviewPlaylistDto | null,
  meta: string,
  t: ReturnType<typeof useT>,
): string {
  const { save } = session
  switch (save.phase) {
    case 'idle':
    case 'failed':
      return `${t('spotifyPreview.readyAnnouncement')}: ${session.title || (playlist?.name ?? '')}. ${meta}`
    case 'saving':
      return t('ai.destination.saving')
    case 'reconciling':
      return save.exhausted
        ? t('spotifyPreview.confirmingPaused')
        : t('spotifyPreview.confirming')
    case 'expired':
      return expiredMessage(save, t)
    case 'settled':
      return save.destination.status === 'published'
        ? t('ai.destination.saved')
        : t('ai.destination.incompleteTitle')
  }
}

function CopyLinkButton({
  url,
  copied,
  onCopy,
}: Readonly<{ url: string; copied: boolean; onCopy: (url: string) => void }>) {
  const t = useT()
  return (
    <Button type="button" variant="secondary" onClick={() => onCopy(url)}>
      {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
      {copied ? t('create.copied') : t('create.copyLink')}
    </Button>
  )
}

function ConfirmingStatus({
  exhausted,
  onCheckStatus,
}: Readonly<{ exhausted: boolean; onCheckStatus: () => void }>) {
  const t = useT()
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={destinationCardClassName}>
      <h3 id={headingId} className="font-display text-sm font-semibold text-cream-50">
        {t('ai.destination.spotifyTitle')}
      </h3>
      <p className="text-sm leading-relaxed text-cream-300">
        {exhausted ? t('spotifyPreview.confirmingPaused') : t('spotifyPreview.confirming')}
      </p>
      {exhausted ? (
        <Button type="button" variant="secondary" onClick={onCheckStatus}>
          {t('spotifyPreview.checkStatus')}
        </Button>
      ) : (
        <Button type="button" loading disabled>
          {t('spotifyPreview.confirmingShort')}
        </Button>
      )}
    </section>
  )
}

function SettledTracks({
  playlist,
  destination,
}: Readonly<{
  playlist: SpotifyPreviewPlaylistDto | null
  destination: SettledSpotifyDestination
}>) {
  if (!playlist) {
    return null
  }
  if (destination.status === 'published') {
    return (
      <PlaylistPreview
        mode="full"
        tracks={playlist.tracks}
        spotifyId={destination.spotifyId}
        spotifyUrl={destination.spotifyUrl}
      />
    )
  }
  return <GeneratedTrackList tracks={playlist.tracks} />
}

export function SpotifyPreviewResult({
  titleId,
  outcome,
  session,
  actions,
  requestedTrackCount,
  focusOnArrival,
  copied,
  onCopy,
  onGenerateAgain,
  onAdjust,
  onCreateAnother,
}: SpotifyPreviewResultProps) {
  const t = useT()
  const coverToggleId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const arrivalFocus = useRef(focusOnArrival)
  const [saveRequested, setSaveRequested] = useState(false)
  const { playlist } = outcome.preview
  const { save } = session
  const trackCount = playlist?.tracks.length ?? 0
  const { isNearCompleteFill, isShortFill } = useGenerationFill(trackCount, requestedTrackCount)
  const inFlight = isSaveInFlight(save)
  const isUnsaved = isUnsavedSave(save)
  const meta = resultMeta(outcome, t)
  const settledUrl =
    save.phase === 'settled' ? toSafeHttpsUrl(save.destination.spotifyUrl) : null

  useEffect(() => {
    if (arrivalFocus.current && isUnsaved) {
      arrivalFocus.current = false
      headingRef.current?.focus()
    }
  }, [isUnsaved])

  function requestSave(): void {
    setSaveRequested(true)
    actions.save()
  }

  function requestStatusCheck(): void {
    setSaveRequested(true)
    actions.checkStatus()
  }

  const announcement = sessionAnnouncement(session, playlist, meta, t)

  if (save.phase === 'expired') {
    return (
      <div className="space-y-4">
        <output className="sr-only">{announcement}</output>
        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-lg font-semibold text-cream-50 outline-none"
        >
          {save.mayHaveSaved || save.lostEarly
            ? t('spotifyPreview.unavailableTitle')
            : t('spotifyPreview.expiredTitle')}
        </h2>
        <p role="status" className="text-sm leading-relaxed text-cream-300">
          {expiredMessage(save, t)}
        </p>
        <Button type="button" onClick={onGenerateAgain}>
          {t('spotifyPreview.generateAgain')}
        </Button>
        <NextStepActions onAdjust={onAdjust} onCreateAnother={onCreateAnother} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <output className="sr-only">{announcement}</output>
      <div className="space-y-4">
        {isUnsaved ? (
          <p className="flex items-center gap-1.5 text-eyebrow text-accent-fg">
            <Clock aria-hidden className="size-3.5" />
            {t('spotifyPreview.eyebrow')}
          </p>
        ) : null}
        <PlaylistTitleField
          titleId={titleId}
          title={session.title}
          suggestedTitle={playlist?.name ?? ''}
          onTitleChange={(next) => actions.setTitle(next ?? playlist?.name ?? '')}
          isLocked={!isUnsaved}
          headingRef={headingRef}
        >
          <div>
            <p className="text-sm text-cream-300">{meta}</p>
            {isUnsaved ? (
              <FillStatusMessages
                trackCount={trackCount}
                requestedTrackCount={requestedTrackCount}
                isNearCompleteFill={isNearCompleteFill}
                isShortFill={isShortFill}
              />
            ) : null}
          </div>
        </PlaylistTitleField>

        {session.generationError ? (
          <p role="alert" className="text-sm leading-relaxed text-danger">
            {t('spotifyPreview.regenerationFailed')}
          </p>
        ) : null}

        {isUnsaved ? (
          <p className="text-sm leading-relaxed text-cream-300">
            {t('spotifyPreview.temporary')}
          </p>
        ) : null}

        {isUnsaved || save.phase === 'saving' ? (
          <SpotifySavePanel
            isBusy={save.phase === 'saving'}
            failure={save.phase === 'failed' ? { error: save.error } : null}
            persistToLibrary={readPersistToLibraryPreference()}
            retryAt={save.phase === 'failed' ? save.retryAt : null}
            disabledReason={
              isValidTitle(session.title) ? null : t('spotifyPreview.titleRequired')
            }
            onSave={requestSave}
          >
            {playlist ? (
              <CoverToggle
                id={coverToggleId}
                checked={session.coverOption}
                onCheckedChange={actions.setCoverOption}
                hint={t(COVER_HINT_KEYS[playlist.generation.kind])}
                disabled={save.phase === 'saving'}
              />
            ) : null}
          </SpotifySavePanel>
        ) : null}

        {save.phase === 'reconciling' ? (
          <ConfirmingStatus exhausted={save.exhausted} onCheckStatus={requestStatusCheck} />
        ) : null}

        {save.phase === 'settled' ? (
          <SpotifyDestinationOutcome
            destination={save.destination}
            focusOnSettle={saveRequested}
          >
            {settledUrl ? (
              <CopyLinkButton url={settledUrl} copied={copied} onCopy={onCopy} />
            ) : null}
          </SpotifyDestinationOutcome>
        ) : null}

        {save.phase === 'settled' && session.coverRenderFailed ? (
          <p role="status" className="text-sm text-danger">
            {t('create.coverFailed')}
          </p>
        ) : null}

        {inFlight ? null : (
          <NextStepActions onAdjust={onAdjust} onCreateAnother={onCreateAnother} />
        )}
        <LastFmAttribution />
      </div>

      {save.phase === 'settled' ? (
        <SettledTracks playlist={playlist} destination={save.destination} />
      ) : null}
      {save.phase !== 'settled' && playlist ? (
        <GeneratedTrackList tracks={playlist.tracks} />
      ) : null}
    </div>
  )
}
