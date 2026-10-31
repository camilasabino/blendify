import {
  SPOTIFY_PREVIEW_RECORD_VERSION,
  createSpotifyPreview,
  destinationRecordFor,
  generatePreviewId,
  isPreviewLive,
  isReadableBy,
  withDestination,
} from './spotify-preview';
import {
  PUBLICATION_OUTCOME_RETENTION_MS,
  SPOTIFY_PREVIEW_TTL_MS,
  assertOutcomeOutlivesPreview,
} from './spotify-preview.policy';
import { SpotifyPreviewIdSchema } from '@blendify/contracts';
import { startPublication } from '@/domain/publication/spotify-destination';
import { previewPlaylist } from '@/application/use-cases/spotify-preview-world.testing';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function preview() {
  return createSpotifyPreview(
    { ownerUserId: 'user-1', playlist: previewPlaylist() },
    NOW,
  );
}

describe('SpotifyPreview', () => {
  it('fixes the lifetime at 30 minutes from creation', () => {
    expect(SPOTIFY_PREVIEW_TTL_MS).toBe(30 * 60_000);
    expect(preview()).toMatchObject({
      version: SPOTIFY_PREVIEW_RECORD_VERSION,
      ownerUserId: 'user-1',
      createdAt: '2026-10-30T12:00:00.000Z',
      expiresAt: '2026-10-30T12:30:00.000Z',
    });
  });

  it('stays live until its expiry instant', () => {
    const created = preview();

    expect(isPreviewLive(created, new Date('2026-10-30T12:29:59.999Z'))).toBe(
      true,
    );
    expect(isPreviewLive(created, new Date('2026-10-30T12:30:00.000Z'))).toBe(
      false,
    );
  });

  it('is readable only by its owner', () => {
    const created = preview();

    expect(isReadableBy(created, 'user-1')).toBe(true);
    expect(isReadableBy(created, 'user-2')).toBe(false);
  });

  it('issues unguessable ids that satisfy the public contract', () => {
    const ids = new Set(Array.from({ length: 200 }, generatePreviewId));

    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(SpotifyPreviewIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('carries the owner and preview expiry on the destination record', () => {
    const created = preview();
    const record = destinationRecordFor(
      created,
      startPublication('attempt-1', NOW),
      NOW,
    );

    expect(record).toMatchObject({
      version: SPOTIFY_PREVIEW_RECORD_VERSION,
      previewId: created.id,
      ownerUserId: 'user-1',
      previewExpiresAt: created.expiresAt,
      destination: { status: 'publishing', attemptId: 'attempt-1' },
    });
    expect(Object.keys(record).sort()).toEqual([
      'destination',
      'ownerUserId',
      'previewExpiresAt',
      'previewId',
      'updatedAt',
      'version',
    ]);
  });

  it('replaces only the destination when it changes', () => {
    const created = preview();
    const record = destinationRecordFor(
      created,
      startPublication('attempt-1', NOW),
      NOW,
    );
    const later = new Date(NOW.getTime() + 1_000);

    const next = withDestination(
      record,
      startPublication('attempt-2', later),
      later,
    );

    expect(next).toEqual({
      ...record,
      destination: expect.objectContaining({ attemptId: 'attempt-2' }),
      updatedAt: later.toISOString(),
    });
  });

  it('requires the outcome retention to outlive the preview', () => {
    expect(PUBLICATION_OUTCOME_RETENTION_MS).toBeGreaterThan(
      SPOTIFY_PREVIEW_TTL_MS,
    );
    expect(() => assertOutcomeOutlivesPreview()).not.toThrow();
    expect(() => assertOutcomeOutlivesPreview(1_000, 1_000)).toThrow();
    expect(() => assertOutcomeOutlivesPreview(2_000, 1_000)).toThrow();
  });
});
