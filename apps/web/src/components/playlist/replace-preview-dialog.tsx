import { ConfirmDialog } from '@/components/ui/dialog'
import { useT } from '@/i18n/use-t'
import type { PlaylistRunFeature } from '@/stores/playlist-run-store'

export function ReplacePreviewDialog({
  replaced,
  onConfirm,
  onCancel,
}: Readonly<{
  replaced: PlaylistRunFeature | null
  onConfirm: () => void
  onCancel: () => void
}>) {
  const t = useT()
  return (
    <ConfirmDialog
      open={replaced !== null}
      title={t('spotifyPreview.replaceTitle')}
      description={t(
        replaced === 'discover'
          ? 'spotifyPreview.replaceBody.discover'
          : 'spotifyPreview.replaceBody.mix',
      )}
      confirmLabel={t('spotifyPreview.replaceConfirm')}
      cancelLabel={t('spotifyPreview.replaceCancel')}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
