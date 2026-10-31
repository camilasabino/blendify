import type {
  SpotifyPreview,
  SpotifyPreviewDestinationRecord,
} from '@/domain/preview/spotify-preview';

export const SPOTIFY_PREVIEW_REPOSITORY = 'SPOTIFY_PREVIEW_REPOSITORY' as const;

export interface SpotifyPreviewRepositoryPort {
  create(preview: SpotifyPreview, ttlMs: number): Promise<void>;
  find(previewId: string): Promise<SpotifyPreview | null>;
  findDestination(
    previewId: string,
  ): Promise<SpotifyPreviewDestinationRecord | null>;
  createDestinationIfAbsent(
    record: SpotifyPreviewDestinationRecord,
    ttlMs: number,
  ): Promise<boolean>;
  saveDestinationOutcome(
    record: SpotifyPreviewDestinationRecord,
    attemptId: string,
    ttlMs: number,
  ): Promise<boolean>;
  deleteDestinationIfAttempt(
    previewId: string,
    attemptId: string,
  ): Promise<boolean>;
  acquireSaveClaim(previewId: string, ttlMs: number): Promise<string | null>;
  renewSaveClaim(
    previewId: string,
    claimId: string,
    ttlMs: number,
  ): Promise<boolean>;
  releaseSaveClaim(previewId: string, claimId: string): Promise<void>;
  hasSaveClaim(previewId: string): Promise<boolean>;
}
