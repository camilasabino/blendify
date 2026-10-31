export const SPOTIFY_PREVIEW_TTL_MS = 30 * 60_000;
export const PUBLICATION_OUTCOME_RETENTION_MS = 24 * 60 * 60_000;
export const SPOTIFY_PREVIEW_MAX_BYTES = 128 * 1024;

export function assertOutcomeOutlivesPreview(
  previewTtlMs: number = SPOTIFY_PREVIEW_TTL_MS,
  retentionMs: number = PUBLICATION_OUTCOME_RETENTION_MS,
): void {
  if (retentionMs <= previewTtlMs) {
    throw new Error(
      'Publication outcome retention must outlive the preview lifetime.',
    );
  }
}
