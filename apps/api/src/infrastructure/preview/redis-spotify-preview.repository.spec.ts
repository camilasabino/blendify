import { Logger } from '@nestjs/common';
import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import {
  createSpotifyPreview,
  destinationRecordFor,
  type SpotifyPreview,
} from '@/domain/preview/spotify-preview';
import {
  PUBLICATION_OUTCOME_RETENTION_MS,
  SPOTIFY_PREVIEW_TTL_MS,
} from '@/domain/preview/spotify-preview.policy';
import {
  completePublication,
  startPublication,
} from '@/domain/publication/spotify-destination';
import {
  RedisCacheService,
  type CoordinationFallback,
} from '@/infrastructure/cache/redis-cache.service';
import type { RedisConnection } from '@/infrastructure/cache/redis-connection';
import {
  memoryPreviewRepository,
  previewPlaylist,
  unavailableConnection,
} from '@/application/use-cases/spotify-preview-world.testing';
import { RedisSpotifyPreviewRepository } from './redis-spotify-preview.repository';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function preview(): SpotifyPreview {
  return createSpotifyPreview(
    { ownerUserId: 'user-1', playlist: previewPlaylist() },
    NOW,
  );
}

function recordFor(created: SpotifyPreview, attemptId: string) {
  return destinationRecordFor(created, startPublication(attemptId, NOW), NOW);
}

describe('RedisSpotifyPreviewRepository', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores and returns an immutable preview', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();

    await repository.create(created, SPOTIFY_PREVIEW_TTL_MS);

    await expect(repository.find(created.id)).resolves.toEqual(created);
    await expect(repository.find('unknown-id')).resolves.toBeNull();
  });

  it('ignores records written under another record version', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();
    await repository.create(
      { ...created, version: 1 } as unknown as SpotifyPreview,
      SPOTIFY_PREVIEW_TTL_MS,
    );

    await expect(repository.find(created.id)).resolves.toBeNull();
  });

  it('expires the preview at its fixed lifetime regardless of reads', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();
    await repository.create(created, SPOTIFY_PREVIEW_TTL_MS);

    jest.setSystemTime(NOW.getTime() + SPOTIFY_PREVIEW_TTL_MS - 1);
    await expect(repository.find(created.id)).resolves.not.toBeNull();
    jest.setSystemTime(NOW.getTime() + SPOTIFY_PREVIEW_TTL_MS + 1);

    await expect(repository.find(created.id)).resolves.toBeNull();
  });

  it('creates a destination only when none exists', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();

    await expect(
      repository.createDestinationIfAbsent(
        recordFor(created, 'attempt-a'),
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(true);
    await expect(
      repository.createDestinationIfAbsent(
        recordFor(created, 'attempt-b'),
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(false);

    await expect(repository.findDestination(created.id)).resolves.toMatchObject(
      { destination: { attemptId: 'attempt-a' } },
    );
  });

  it('writes an outcome only for the publishing attempt that owns it', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();
    await repository.createDestinationIfAbsent(
      recordFor(created, 'attempt-a'),
      PUBLICATION_OUTCOME_RETENTION_MS,
    );
    const published = {
      ...recordFor(created, 'attempt-a'),
      destination: completePublication(
        {
          spotifyPlaylist: { spotifyId: 'p1', spotifyUrl: null },
          savedToLibrary: true,
          coverUploadFailed: false,
        },
        NOW,
      ),
    };

    await expect(
      repository.saveDestinationOutcome(
        published,
        'attempt-b',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(false);
    await expect(
      repository.saveDestinationOutcome(
        published,
        'attempt-a',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(true);
    await expect(
      repository.saveDestinationOutcome(
        { ...published, updatedAt: 'later' },
        'attempt-a',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(false);

    await expect(repository.findDestination(created.id)).resolves.toEqual(
      published,
    );
  });

  it('rolls back only the matching publishing attempt', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();
    await repository.createDestinationIfAbsent(
      recordFor(created, 'attempt-a'),
      PUBLICATION_OUTCOME_RETENTION_MS,
    );

    await expect(
      repository.deleteDestinationIfAttempt(created.id, 'attempt-b'),
    ).resolves.toBe(false);
    await expect(
      repository.findDestination(created.id),
    ).resolves.not.toBeNull();
    await expect(
      repository.deleteDestinationIfAttempt(created.id, 'attempt-a'),
    ).resolves.toBe(true);
    await expect(repository.findDestination(created.id)).resolves.toBeNull();
  });

  it('keeps the destination after the preview has expired', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();
    await repository.create(created, SPOTIFY_PREVIEW_TTL_MS);
    await repository.createDestinationIfAbsent(
      recordFor(created, 'attempt-a'),
      PUBLICATION_OUTCOME_RETENTION_MS,
    );

    jest.setSystemTime(NOW.getTime() + SPOTIFY_PREVIEW_TTL_MS + 1);
    await expect(repository.find(created.id)).resolves.toBeNull();
    await expect(
      repository.findDestination(created.id),
    ).resolves.not.toBeNull();

    jest.setSystemTime(NOW.getTime() + PUBLICATION_OUTCOME_RETENTION_MS + 1);
    await expect(repository.findDestination(created.id)).resolves.toBeNull();
  });

  it('grants the save claim to one holder, renews it only for that holder and releases it safely', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();

    const first = await repository.acquireSaveClaim(created.id, 30_000);
    const second = await repository.acquireSaveClaim(created.id, 30_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await expect(
      repository.renewSaveClaim(created.id, 'someone-else', 30_000),
    ).resolves.toBe(false);
    await expect(
      repository.renewSaveClaim(created.id, first ?? '', 30_000),
    ).resolves.toBe(true);
    await repository.releaseSaveClaim(created.id, 'someone-else');
    await expect(repository.hasSaveClaim(created.id)).resolves.toBe(true);
    await repository.releaseSaveClaim(created.id, first ?? '');
    await expect(repository.hasSaveClaim(created.id)).resolves.toBe(false);
  });

  it('lets a new holder take an expired claim without the stale holder releasing it', async () => {
    const repository = memoryPreviewRepository();
    const created = preview();
    const stale = await repository.acquireSaveClaim(created.id, 1_000);

    jest.setSystemTime(NOW.getTime() + 2_000);
    const fresh = await repository.acquireSaveClaim(created.id, 30_000);
    await repository.releaseSaveClaim(created.id, stale ?? '');

    expect(fresh).not.toBeNull();
    await expect(repository.hasSaveClaim(created.id)).resolves.toBe(true);
    await expect(
      repository.renewSaveClaim(created.id, stale ?? '', 30_000),
    ).resolves.toBe(false);
  });

  describe('when Redis is unavailable in production', () => {
    const repository = memoryPreviewRepository('fail-closed');
    const created = preview();

    it.each([
      ['create', () => repository.create(created, SPOTIFY_PREVIEW_TTL_MS)],
      ['find', () => repository.find(created.id)],
      ['findDestination', () => repository.findDestination(created.id)],
      [
        'createDestinationIfAbsent',
        () =>
          repository.createDestinationIfAbsent(
            recordFor(created, 'a'),
            PUBLICATION_OUTCOME_RETENTION_MS,
          ),
      ],
      [
        'saveDestinationOutcome',
        () =>
          repository.saveDestinationOutcome(
            recordFor(created, 'a'),
            'a',
            PUBLICATION_OUTCOME_RETENTION_MS,
          ),
      ],
      [
        'deleteDestinationIfAttempt',
        () => repository.deleteDestinationIfAttempt(created.id, 'a'),
      ],
      [
        'acquireSaveClaim',
        () => repository.acquireSaveClaim(created.id, 1_000),
      ],
      [
        'renewSaveClaim',
        () => repository.renewSaveClaim(created.id, 'claim', 1_000),
      ],
      ['hasSaveClaim', () => repository.hasSaveClaim(created.id)],
    ])('fails closed on %s', async (_name, operation) => {
      await expect(operation()).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
    });
  });

  describe('when a Redis command fails in production', () => {
    function failingRepository(fallback: CoordinationFallback) {
      const client = {
        get: jest.fn(() => Promise.reject(new Error('boom'))),
        set: jest.fn(() => Promise.reject(new Error('boom'))),
        eval: jest.fn(() => Promise.reject(new Error('boom'))),
        exists: jest.fn(() => Promise.reject(new Error('boom'))),
      };
      const connection = {
        readyClient: () => client,
      } as unknown as RedisConnection;
      return new RedisSpotifyPreviewRepository(
        new RedisCacheService(connection, fallback),
      );
    }

    it('surfaces a partial write failure instead of reading from memory', async () => {
      const repository = failingRepository('fail-closed');
      const created = preview();

      await expect(
        repository.create(created, SPOTIFY_PREVIEW_TTL_MS),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);
      await expect(repository.find(created.id)).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
      await expect(
        repository.saveDestinationOutcome(
          recordFor(created, 'a'),
          'a',
          PUBLICATION_OUTCOME_RETENTION_MS,
        ),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);
      await expect(
        repository.renewSaveClaim(created.id, 'claim', 1_000),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);
      await expect(repository.hasSaveClaim(created.id)).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
    });
  });

  it('reuses no process memory when Redis is ready', () => {
    expect(unavailableConnection().readyClient()).toBeNull();
  });
});
