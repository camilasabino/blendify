import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createSpotifyPreview,
  destinationRecordFor,
  type SpotifyPreview,
} from '@/domain/preview/spotify-preview';
import { PUBLICATION_OUTCOME_RETENTION_MS } from '@/domain/preview/spotify-preview.policy';
import {
  completePublication,
  startPublication,
} from '@/domain/publication/spotify-destination';
import { RedisCacheService } from '@/infrastructure/cache/redis-cache.service';
import { RedisConnection } from '@/infrastructure/cache/redis-connection';
import { previewPlaylist } from '@/application/use-cases/spotify-preview-world.testing';
import { RedisSpotifyPreviewRepository } from './redis-spotify-preview.repository';

const redisUrl = process.env.REDIS_TEST_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

function newPreview(): SpotifyPreview {
  return createSpotifyPreview(
    { ownerUserId: 'user-1', playlist: previewPlaylist() },
    new Date(),
  );
}

function recordFor(preview: SpotifyPreview, attemptId: string) {
  return destinationRecordFor(
    preview,
    startPublication(attemptId, new Date()),
    new Date(),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeWithRedis('RedisSpotifyPreviewRepository against real Redis', () => {
  let connection: RedisConnection;
  let repository: RedisSpotifyPreviewRepository;
  let unavailable: RedisSpotifyPreviewRepository;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    connection = new RedisConnection({
      get: () => redisUrl,
    } as unknown as ConfigService);
    await connection.onModuleInit();
    repository = new RedisSpotifyPreviewRepository(
      new RedisCacheService(connection, 'fail-closed'),
    );
    unavailable = new RedisSpotifyPreviewRepository(
      new RedisCacheService(
        new RedisConnection({
          get: () => 'redis://127.0.0.1:1',
        } as unknown as ConfigService),
        'fail-closed',
      ),
    );
  });

  afterAll(async () => {
    await connection.onModuleDestroy();
  });

  it('round-trips a preview and fixes its TTL regardless of reads', async () => {
    const preview = newPreview();
    await repository.create(preview, 2_000);

    await expect(repository.find(preview.id)).resolves.toEqual(preview);
    const client = connection.readyClient()!;
    const key = `blendify:preview:spotify:v1:${preview.id}`;
    const before = await client.pttl(key);
    await sleep(300);
    await repository.find(preview.id);
    await repository.find(preview.id);
    const after = await client.pttl(key);

    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThanOrEqual(2_000);
    expect(after).toBeLessThan(before);
    await sleep(2_100);
    await expect(repository.find(preview.id)).resolves.toBeNull();
  });

  it('keeps the destination alive after the preview has expired', async () => {
    const preview = newPreview();
    await repository.create(preview, 1_000);
    await repository.createDestinationIfAbsent(
      recordFor(preview, 'attempt-a'),
      PUBLICATION_OUTCOME_RETENTION_MS,
    );

    await sleep(1_200);

    await expect(repository.find(preview.id)).resolves.toBeNull();
    await expect(repository.findDestination(preview.id)).resolves.toMatchObject(
      {
        ownerUserId: 'user-1',
        destination: { status: 'publishing' },
      },
    );
    const ttl = await connection
      .readyClient()!
      .pttl(`blendify:preview:spotify:v1:${preview.id}:destination`);
    expect(ttl).toBeGreaterThan(PUBLICATION_OUTCOME_RETENTION_MS - 5_000);
  });

  it('lets exactly one of many concurrent starters create the destination', async () => {
    const preview = newPreview();

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        repository.createDestinationIfAbsent(
          recordFor(preview, `attempt-${index}`),
          PUBLICATION_OUTCOME_RETENTION_MS,
        ),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('grants the save claim to exactly one concurrent requester', async () => {
    const id = randomUUID();

    const claims = await Promise.all(
      Array.from({ length: 25 }, () => repository.acquireSaveClaim(id, 5_000)),
    );

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
  });

  it('lets a newer holder take over an expired claim without the stale one interfering', async () => {
    const id = randomUUID();
    const stale = await repository.acquireSaveClaim(id, 50);
    await sleep(120);
    await expect(repository.hasSaveClaim(id)).resolves.toBe(false);

    const fresh = await repository.acquireSaveClaim(id, 5_000);
    await expect(
      repository.renewSaveClaim(id, stale ?? '', 5_000),
    ).resolves.toBe(false);
    await repository.releaseSaveClaim(id, stale ?? '');

    expect(fresh).not.toBeNull();
    await expect(repository.hasSaveClaim(id)).resolves.toBe(true);
    await expect(
      repository.renewSaveClaim(id, fresh ?? '', 5_000),
    ).resolves.toBe(true);
    await repository.releaseSaveClaim(id, fresh ?? '');
  });

  it('applies outcome writes only to the publishing attempt and never to a settled record', async () => {
    const preview = newPreview();
    await repository.createDestinationIfAbsent(
      recordFor(preview, 'attempt-a'),
      PUBLICATION_OUTCOME_RETENTION_MS,
    );
    const published = {
      ...recordFor(preview, 'attempt-a'),
      destination: completePublication(
        {
          spotifyPlaylist: { spotifyId: 'p1', spotifyUrl: null },
          savedToLibrary: true,
          coverUploadFailed: false,
        },
        new Date(),
      ),
    };
    const interrupted = {
      ...published,
      destination: {
        status: 'publish_incomplete' as const,
        failedAt: new Date().toISOString(),
        spotifyPlaylist: null,
        reason: 'interrupted' as const,
      },
    };

    await expect(
      repository.saveDestinationOutcome(
        published,
        'attempt-b',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(false);
    const racing = await Promise.all([
      repository.saveDestinationOutcome(
        published,
        'attempt-a',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
      repository.saveDestinationOutcome(
        interrupted,
        'attempt-a',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ]);

    expect(racing.filter(Boolean)).toHaveLength(1);
    await expect(
      repository.saveDestinationOutcome(
        interrupted,
        'attempt-a',
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(false);
  });

  it('deletes the destination only for the matching publishing attempt', async () => {
    const preview = newPreview();
    await repository.createDestinationIfAbsent(
      recordFor(preview, 'attempt-a'),
      PUBLICATION_OUTCOME_RETENTION_MS,
    );

    await expect(
      repository.deleteDestinationIfAttempt(preview.id, 'attempt-b'),
    ).resolves.toBe(false);
    await expect(
      repository.deleteDestinationIfAttempt(randomUUID(), 'attempt-a'),
    ).resolves.toBe(false);
    await expect(
      repository.deleteDestinationIfAttempt(preview.id, 'attempt-a'),
    ).resolves.toBe(true);
    await expect(repository.findDestination(preview.id)).resolves.toBeNull();
    await expect(
      repository.createDestinationIfAbsent(
        recordFor(preview, 'attempt-c'),
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).resolves.toBe(true);
  });

  it('fails closed when Redis cannot be reached', async () => {
    const preview = newPreview();

    await expect(unavailable.create(preview, 1_000)).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    await expect(
      unavailable.acquireSaveClaim(preview.id, 1_000),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    await expect(
      unavailable.createDestinationIfAbsent(
        recordFor(preview, 'a'),
        PUBLICATION_OUTCOME_RETENTION_MS,
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});
