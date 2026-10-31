import { useEffect, useId, useRef, type ReactNode } from 'react'
import { CircleCheck, ExternalLink } from 'lucide-react'
import type { SpotifyDestinationDto } from '@blendify/contracts'
import { destinationCardClassName } from '@/components/spotify-destination/spotify-save-panel'
import { buttonVariants } from '@/components/ui/button'
import { FieldError } from '@/components/ui/feedback'
import { useT } from '@/i18n/use-t'
import type { MessageKey } from '@/i18n/messages'
import { cn, toSafeHttpsUrl } from '@/lib/utils'

type IncompleteDestination = Extract<SpotifyDestinationDto, { status: 'publish_incomplete' }>

const INCOMPLETE_REASON_KEYS = {
  outcome_unknown: 'spotifySave.reason.outcomeUnknown',
  tracks_incomplete: 'spotifySave.reason.tracksIncomplete',
  library_not_saved: 'spotifySave.reason.libraryNotSaved',
  interrupted: 'spotifySave.reason.interrupted',
} as const satisfies Record<IncompleteDestination['reason'], MessageKey>

export function SpotifyDestinationOutcome({
  destination,
  focusOnSettle,
  children,
}: Readonly<{
  destination: SpotifyDestinationDto
  focusOnSettle: boolean
  children?: ReactNode
}>) {
  const t = useT()
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const isSettled = destination.status !== 'publishing'
  const spotifyUrl =
    destination.status === 'publishing' ? null : toSafeHttpsUrl(destination.spotifyUrl)

  useEffect(() => {
    if (focusOnSettle && isSettled) {
      headingRef.current?.focus()
    }
  }, [focusOnSettle, isSettled])

  if (destination.status === 'publishing') {
    return (
      <section aria-labelledby={headingId} className={destinationCardClassName}>
        <h3 id={headingId} className="font-display text-sm font-semibold text-cream-50">
          {t('ai.destination.spotifyTitle')}
        </h3>
        <output className="block text-sm text-cream-300">{t('ai.destination.saving')}</output>
      </section>
    )
  }

  const isPublished = destination.status === 'published'
  let message: string
  if (destination.status === 'published') {
    message = destination.savedToLibrary
      ? t('ai.destination.savedHintLibrary')
      : t('ai.destination.savedHint')
  } else {
    message = t(INCOMPLETE_REASON_KEYS[destination.reason])
  }

  return (
    <section aria-labelledby={headingId} className={destinationCardClassName}>
      <h3
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-1.5 font-display text-sm font-semibold text-cream-50 outline-none"
      >
        {isPublished ? <CircleCheck aria-hidden className="size-4 text-accent-fg" /> : null}
        {isPublished ? t('ai.destination.saved') : t('ai.destination.incompleteTitle')}
      </h3>
      <p
        role={isPublished ? undefined : 'alert'}
        className={cn('text-sm leading-relaxed', isPublished ? 'text-cream-300' : 'text-danger')}
      >
        {message}
      </p>
      {isPublished && destination.coverUploadFailed ? (
        <FieldError>{t('create.coverFailed')}</FieldError>
      ) : null}
      {spotifyUrl ? (
        <div className="flex flex-wrap gap-2">
          <a
            href={spotifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants(), 'w-full sm:w-auto')}
          >
            <ExternalLink aria-hidden className="size-4" />
            {t('create.openSpotify')} <span className="sr-only">{t('common.opensNewTab')}</span>
          </a>
          {children}
        </div>
      ) : null}
    </section>
  )
}
