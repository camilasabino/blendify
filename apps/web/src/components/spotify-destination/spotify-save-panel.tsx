import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import { SpotifyLimitExplanation } from '@/components/brand/spotify-limit-explanation'
import { Button } from '@/components/ui/button'
import { useConnectSpotify } from '@/hooks/use-connect-spotify'
import { useT } from '@/i18n/use-t'
import { ApiError, getApiErrorMessage, isSpotifyRateLimited } from '@/lib/api'

export const destinationCardClassName =
  'space-y-3 rounded-card border border-divider bg-card p-4'

export type SpotifySaveFailure = Readonly<{ error: unknown }>

type SpotifySavePanelProps = Readonly<{
  isBusy: boolean
  failure: SpotifySaveFailure | null
  persistToLibrary: boolean
  disabledReason?: string | null
  retryAt?: number | null
  onSave: () => void
  children?: ReactNode
}>

function needsSpotifyReconnect(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 'SPOTIFY_REAUTH_REQUIRED' || error.status === 401)
  )
}

function useIsWaiting(retryAt: number | null | undefined): boolean {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!retryAt) {
      return
    }
    const remaining = retryAt - Date.now()
    if (remaining <= 0) {
      setNow(Date.now())
      return
    }
    const timer = window.setTimeout(() => setNow(Date.now()), remaining)
    return () => window.clearTimeout(timer)
  }, [retryAt])

  return retryAt != null && now < retryAt
}

export function SpotifySavePanel({
  isBusy,
  failure,
  persistToLibrary,
  disabledReason = null,
  retryAt = null,
  onSave,
  children,
}: SpotifySavePanelProps) {
  const t = useT()
  const connectSpotify = useConnectSpotify()
  const headingId = useId()
  const hintId = useId()
  const reasonId = useId()
  const reconnectRef = useRef<HTMLButtonElement>(null)
  const isWaiting = useIsWaiting(retryAt)
  const error = failure?.error
  const needsReconnect = failure !== null && needsSpotifyReconnect(error)
  const showsReconnect = needsReconnect && !isBusy
  const showsReason = Boolean(disabledReason) && !isBusy

  useEffect(() => {
    if (showsReconnect) {
      reconnectRef.current?.focus()
    }
  }, [showsReconnect])

  return (
    <section aria-labelledby={headingId} className={destinationCardClassName}>
      <h3 id={headingId} className="font-display text-sm font-semibold text-cream-50">
        {t('ai.destination.spotifyTitle')}
      </h3>
      <p id={hintId} className="text-sm leading-relaxed text-cream-300">
        {persistToLibrary
          ? t('ai.destination.spotifyHintLibrary')
          : t('ai.destination.spotifyHint')}
      </p>
      {children}
      {failure && !isBusy ? (
        <p role="alert" className="text-sm leading-relaxed text-danger">
          {needsReconnect
            ? t('ai.destination.reconnect')
            : getApiErrorMessage(error, t, 'ai.destination.failed')}
        </p>
      ) : null}
      {failure && !isBusy && isSpotifyRateLimited(error) ? <SpotifyLimitExplanation /> : null}
      {showsReconnect ? (
        <Button ref={reconnectRef} type="button" className="w-full sm:w-auto" onClick={connectSpotify}>
          {t('nav.connectSpotify')}
        </Button>
      ) : (
        <Button
          type="button"
          className="w-full sm:w-auto"
          loading={isBusy}
          disabled={Boolean(disabledReason) || isWaiting}
          aria-describedby={showsReason ? `${hintId} ${reasonId}` : hintId}
          onClick={onSave}
        >
          {isBusy ? null : <Upload aria-hidden className="size-4" />}
          {isBusy ? t('ai.destination.saving') : t('ai.destination.save')}
        </Button>
      )}
      {showsReason ? (
        <p id={reasonId} className="text-sm text-cream-400">
          {disabledReason}
        </p>
      ) : null}
    </section>
  )
}
