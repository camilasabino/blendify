import { PreviewError } from '@/domain/errors/preview.error';
import {
  isPreviewLive,
  isReadableBy,
  type SpotifyPreview,
  type SpotifyPreviewDestinationRecord,
} from '@/domain/preview/spotify-preview';

export function readableDestination(
  record: SpotifyPreviewDestinationRecord | null,
  userId: string,
): SpotifyPreviewDestinationRecord | null {
  if (record && !isReadableBy(record, userId)) {
    throw PreviewError.notFound();
  }
  return record;
}

export function readableLivePreview(
  preview: SpotifyPreview | null,
  userId: string,
  now: Date,
): SpotifyPreview | null {
  if (!preview || !isPreviewLive(preview, now)) {
    return null;
  }
  if (!isReadableBy(preview, userId)) {
    throw PreviewError.notFound();
  }
  return preview;
}
