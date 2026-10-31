import type { MessageKey } from '@/i18n/messages'
import type { PlaylistRunFeature } from '@/stores/playlist-run-store'

type PlaylistRunCopy = {
  originPath: string
  active: MessageKey
  succeeded: MessageKey
  failed: MessageKey
  preview: MessageKey
  saving: MessageKey
  confirming: MessageKey
  saved: MessageKey
  incomplete: MessageKey
  expired: MessageKey
  busy: MessageKey
}

export const PLAYLIST_RUN_COPY: Record<PlaylistRunFeature, PlaylistRunCopy> = {
  mix: {
    originPath: '/app/mix',
    active: 'runStatus.active.mix',
    succeeded: 'runStatus.succeeded.mix',
    failed: 'runStatus.failed.mix',
    preview: 'runStatus.preview.mix',
    saving: 'runStatus.saving.mix',
    confirming: 'runStatus.confirming.mix',
    saved: 'runStatus.saved.mix',
    incomplete: 'runStatus.incomplete.mix',
    expired: 'runStatus.expired.mix',
    busy: 'runStatus.busy.mix',
  },
  discover: {
    originPath: '/app/discover',
    active: 'runStatus.active.discover',
    succeeded: 'runStatus.succeeded.discover',
    failed: 'runStatus.failed.discover',
    preview: 'runStatus.preview.discover',
    saving: 'runStatus.saving.discover',
    confirming: 'runStatus.confirming.discover',
    saved: 'runStatus.saved.discover',
    incomplete: 'runStatus.incomplete.discover',
    expired: 'runStatus.expired.discover',
    busy: 'runStatus.busy.discover',
  },
}
