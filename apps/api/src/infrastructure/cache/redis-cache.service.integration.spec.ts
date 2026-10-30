import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import { RedisCacheService } from './redis-cache.service';
import { RedisConnection } from './redis-connection';

const redisUrl = process.env.REDIS_TEST_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

describeWithRedis('RedisCacheService owned keys against real Redis', () => {
  let connection: RedisConnection;
  let cache: RedisCacheService;

  beforeAll(async () => {
    connection = new RedisConnection({
      get: () => redisUrl,
    } as unknown as ConfigService);
    await connection.onModuleInit();
    cache = new RedisCacheService(connection);
  });

  afterAll(async () => {
    await connection.onModuleDestroy();
  });

  it('deletes a key only for the owner that set it', async () => {
    const key = `blendify:test:${randomUUID()}`;

    await expect(cache.setIfAbsent(key, 'owner-a', 5_000)).resolves.toBe(true);
    await expect(cache.setIfAbsent(key, 'owner-b', 5_000)).resolves.toBe(false);

    await cache.deleteIfValue(key, 'owner-b');
    await expect(cache.exists(key)).resolves.toBe(true);

    await cache.deleteIfValue(key, 'owner-a');
    await expect(cache.exists(key)).resolves.toBe(false);
  });

  it('lets a new owner acquire after the lease expires, safe from the old owner', async () => {
    const key = `blendify:test:${randomUUID()}`;

    await cache.setIfAbsent(key, 'owner-a', 50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(cache.setIfAbsent(key, 'owner-b', 5_000)).resolves.toBe(true);

    await cache.deleteIfValue(key, 'owner-a');
    await expect(cache.exists(key)).resolves.toBe(true);
    await cache.deleteIfValue(key, 'owner-b');
  });

  it('renews a key only for its owner', async () => {
    const key = `blendify:test:${randomUUID()}`;

    await cache.setIfAbsent(key, 'owner-a', 200);
    await expect(cache.renewIfValue(key, 'owner-b', 5_000)).resolves.toBe(
      false,
    );
    await expect(cache.renewIfValue(key, 'owner-a', 5_000)).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(cache.exists(key)).resolves.toBe(true);
    await cache.deleteIfValue(key, 'owner-a');
    await expect(cache.renewIfValue(key, 'owner-a', 5_000)).resolves.toBe(
      false,
    );
  });

  it('replaces a JSON document only while nested fields match', async () => {
    const key = `blendify:test:${randomUUID()}`;
    const expected = {
      'execution.status': 'generating',
      'execution.attemptId': 'attempt-a',
    };

    await cache.setJson(
      key,
      { execution: { status: 'generating', attemptId: 'attempt-b' } },
      5_000,
    );
    await expect(
      cache.setJsonIfFields(key, { execution: null }, 5_000, expected),
    ).resolves.toBe(false);

    await cache.setJson(
      key,
      { execution: { status: 'generating', attemptId: 'attempt-a' } },
      5_000,
    );
    await expect(
      cache.setJsonIfFields(
        key,
        { execution: { status: 'generated' } },
        5_000,
        expected,
      ),
    ).resolves.toBe(true);
    await expect(cache.getJson(key)).resolves.toEqual({
      execution: { status: 'generated' },
    });
    await expect(
      cache.setJsonIfFields(key, { execution: null }, 5_000, expected),
    ).resolves.toBe(false);
    await expect(
      cache.setJsonIfFields(`${key}:missing`, {}, 5_000, expected),
    ).resolves.toBe(false);
  });

  it('deletes a JSON document only while nested fields match', async () => {
    const key = `blendify:test:${randomUUID()}`;
    const expected = {
      'destination.status': 'publishing',
      'destination.attemptId': 'attempt-a',
    };

    await cache.setJson(
      key,
      { destination: { status: 'publishing', attemptId: 'attempt-b' } },
      5_000,
    );
    await expect(cache.deleteIfFields(key, expected)).resolves.toBe(false);
    await expect(cache.getJson(key)).resolves.not.toBeNull();

    await cache.setJson(
      key,
      { destination: { status: 'publishing', attemptId: 'attempt-a' } },
      5_000,
    );
    await expect(cache.deleteIfFields(key, expected)).resolves.toBe(true);
    await expect(cache.getJson(key)).resolves.toBeNull();
    await expect(cache.deleteIfFields(key, expected)).resolves.toBe(false);

    await connection.readyClient()?.set(key, 'not-json', 'PX', 5_000);
    await expect(cache.deleteIfFields(key, expected)).resolves.toBe(false);
  });

  it('lets exactly one of many concurrent coordinated claims win', async () => {
    const strict = new RedisCacheService(connection, 'fail-closed');
    const key = `blendify:test:${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        strict.setIfAbsent(key, `owner-${index}`, 5_000, {
          coordination: true,
        }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describeWithRedis(
  'RedisCacheService coordination after Redis disconnects',
  () => {
    it('fails closed instead of granting a claim from process memory', async () => {
      const connection = new RedisConnection({
        get: () => redisUrl,
      } as unknown as ConfigService);
      await connection.onModuleInit();
      const strict = new RedisCacheService(connection, 'fail-closed');
      const key = `blendify:test:${randomUUID()}`;
      await expect(
        strict.setIfAbsent(key, 'owner-a', 5_000, { coordination: true }),
      ).resolves.toBe(true);

      await connection.onModuleDestroy();

      await expect(
        strict.setIfAbsent(key, 'owner-b', 5_000, { coordination: true }),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);
      await expect(
        strict.setJsonIfFields(
          key,
          {},
          5_000,
          { status: 'publishing' },
          { coordination: true },
        ),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);
    });
  },
);
