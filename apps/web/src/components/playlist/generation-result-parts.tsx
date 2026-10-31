import { Plus, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/use-t'

export function FillStatusMessages({
  trackCount,
  requestedTrackCount,
  isNearCompleteFill,
  isShortFill,
}: Readonly<{
  trackCount: number
  requestedTrackCount: number
  isNearCompleteFill: boolean
  isShortFill: boolean
}>) {
  const t = useT()
  if (isNearCompleteFill) {
    return (
      <p className="mt-2 text-sm text-cream-300">
        {t('create.nearCompleteTracks', {
          count: trackCount,
          requested: requestedTrackCount,
        })}
      </p>
    )
  }
  if (isShortFill) {
    return (
      <p className="mt-2 text-sm text-warning">
        {t('create.partialTracks', {
          count: trackCount,
          requested: requestedTrackCount,
        })}
      </p>
    )
  }
  return null
}

export function NextStepActions({
  onAdjust,
  onCreateAnother,
}: Readonly<{
  onAdjust: () => void
  onCreateAnother: () => void
}>) {
  const t = useT()
  return (
    <div className="flex flex-wrap gap-2 border-t border-divider pt-4">
      <Button type="button" variant="secondary" size="sm" onClick={onCreateAnother}>
        <Plus aria-hidden className="size-3.5" />
        {t('create.createAnother')}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onAdjust}>
        <SlidersHorizontal aria-hidden className="size-3.5" />
        {t('create.adjustAndRecreate')}
      </Button>
    </div>
  )
}
