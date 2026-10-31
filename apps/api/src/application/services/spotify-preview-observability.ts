import { Logger } from '@nestjs/common';
import type { PlaylistKind } from '@blendify/contracts';
import { PreviewError } from '@/domain/errors/preview.error';
import { isConfirmedRejection } from '@/domain/publication/spotify-destination';
import type { PublicationOutcomeEvent } from './spotify-publication.runner';
import { currentRequestId } from './request-correlation';

export const PREVIEW_CREATED_EVENT = 'preview.created';
export const PREVIEW_SAVE_EVENT = 'preview.save';

export type PreviewSaveOutcome =
  | 'published'
  | 'reused'
  | 'superseded'
  | 'interrupted'
  | `publish_incomplete:${string}`
  | 'in_progress'
  | 'not_found'
  | 'quota_rejected'
  | 'confirmed_rejection'
  | 'failed';

const logger = new Logger('SpotifyPreview');

export function logPreviewCreated(fields: {
  kind: PlaylistKind;
  trackCount: number;
}): void {
  logger.log(
    JSON.stringify({
      event: PREVIEW_CREATED_EVENT,
      requestId: currentRequestId(),
      ...fields,
    }),
  );
}

export function logPreviewSave(
  outcome: PreviewSaveOutcome,
  fields: { kind?: PlaylistKind; trackCount?: number } = {},
): void {
  logger.log(
    JSON.stringify({
      event: PREVIEW_SAVE_EVENT,
      requestId: currentRequestId(),
      outcome,
      ...fields,
    }),
  );
}

export function logPreviewDiagnostic(event: string): void {
  logger.warn(
    JSON.stringify({
      event: 'preview.diagnostic',
      requestId: currentRequestId(),
      diagnostic: event,
    }),
  );
}

export function saveOutcomeOf(
  event: PublicationOutcomeEvent,
): PreviewSaveOutcome {
  if (event.outcome === 'publish_incomplete') {
    return `publish_incomplete:${event.reason ?? 'unknown'}`;
  }
  return event.outcome;
}

export function saveFailureOutcome(error: unknown): PreviewSaveOutcome {
  if (error instanceof PreviewError) {
    return error.code === 'PREVIEW_NOT_FOUND' ? 'not_found' : 'in_progress';
  }
  if (isRateLimited(error)) {
    return 'quota_rejected';
  }
  return isConfirmedRejection(error) ? 'confirmed_rejection' : 'failed';
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: unknown }).code === 'RATE_LIMITED'
  );
}
