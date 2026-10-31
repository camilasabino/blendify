import { useIsMutating } from '@tanstack/react-query'
import { useBlocker } from 'react-router-dom'
import { GUEST_TRANSFER_MUTATION_KEY } from '@/components/playlist/generation-result-helpers'
import { ConfirmDialog } from '@/components/ui/dialog'
import { useGuestResultPersistence } from '@/hooks/use-guest-result-persistence'
import { useSpotifyPreviewLifecycle } from '@/hooks/use-spotify-preview-lifecycle'
import { useUnloadWarning } from '@/hooks/use-unload-warning'
import { useT } from '@/i18n/use-t'
import { isRunBusy, usePlaylistRunStore } from '@/stores/playlist-run-store'

export function PlaylistRunSafeguards() {
  const t = useT()
  const run = usePlaylistRunStore((state) => state.run)
  const { isResultUnsaved } = useGuestResultPersistence()
  useSpotifyPreviewLifecycle()
  const isPreparingTransfer =
    useIsMutating({ mutationKey: GUEST_TRANSFER_MUTATION_KEY }) > 0
  const isRunActive = run?.status.phase === 'active'
  const isGuestRunActive = isRunActive && run.spec.mode === 'guest'

  useUnloadWarning(isRunBusy(run) || isResultUnsaved || isPreparingTransfer)

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isGuestRunActive && currentLocation.pathname !== nextLocation.pathname,
  )

  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      title={t('leaveGuard.title')}
      description={t('leaveGuard.body')}
      confirmLabel={t('leaveGuard.leave')}
      cancelLabel={t('leaveGuard.stay')}
      danger
      onConfirm={() => blocker.proceed?.()}
      onCancel={() => blocker.reset?.()}
    />
  )
}
