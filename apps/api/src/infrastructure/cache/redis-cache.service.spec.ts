import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import {
  DELETE_IF_FIELDS_SCRIPT,
  DELETE_IF_VALUE_SCRIPT,
  RENEW_IF_VALUE_SCRIPT,
  RedisCacheService,
  SET_JSON_IF_FIELDS_SCRIPT,
  sanitizeRedisUrl,
} from './redis-cache.service';
import { RedisConnection } from './redis-connection';
import { ConfigService } from '@nestjs/config';

describe('RedisCacheService memory fallback', () => {
  it('stores and reads JSON without a Redis connection', async () => {
    const config = {
      get: () => 'redis://127.0.0.1:1',
    } as unknown as ConfigService;
    const cache = new RedisCacheService(new RedisConnection(config));

    await cache.setJson('blendify:test:key', { ok: true }, 60_000);
    await expect(
      cache.getJson<{ ok: boolean }>('blendify:test:key'),
    ).resolves.toEqual({ ok: true });
  });

  it('grants a key only once until its owner deletes it', async () => {
    const config = {
      get: () => 'redis://127.0.0.1:1',
    } as unknown as ConfigService;
    const cache = new RedisCacheService(new RedisConnection(config));

    await expect(
      cache.setIfAbsent('blendify:test:lock', 'owner-a', 60_000),
    ).resolves.toBe(true);
    await expect(
      cache.setIfAbsent('blendify:test:lock', 'owner-b', 60_000),
    ).resolves.toBe(false);
    await expect(cache.exists('blendify:test:lock')).resolves.toBe(true);

    await cache.deleteIfValue('blendify:test:lock', 'owner-b');
    await expect(cache.exists('blendify:test:lock')).resolves.toBe(true);

    await cache.deleteIfValue('blendify:test:lock', 'owner-a');
    await expect(cache.exists('blendify:test:lock')).resolves.toBe(false);
    await expect(
      cache.setIfAbsent('blendify:test:lock', 'owner-b', 60_000),
    ).resolves.toBe(true);
  });

  it('renews an owned key only for its owner', async () => {
    jest.useFakeTimers();
    try {
      const config = {
        get: () => 'redis://127.0.0.1:1',
      } as unknown as ConfigService;
      const cache = new RedisCacheService(new RedisConnection(config));
      await cache.setIfAbsent('blendify:test:lease', 'owner-a', 1_000);

      await expect(
        cache.renewIfValue('blendify:test:lease', 'owner-b', 5_000),
      ).resolves.toBe(false);
      await expect(
        cache.renewIfValue('blendify:test:lease', 'owner-a', 5_000),
      ).resolves.toBe(true);
      jest.advanceTimersByTime(2_000);

      await expect(cache.exists('blendify:test:lease')).resolves.toBe(true);
      jest.advanceTimersByTime(4_000);
      await expect(cache.exists('blendify:test:lease')).resolves.toBe(false);
      await expect(
        cache.renewIfValue('blendify:test:lease', 'owner-a', 5_000),
      ).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('replaces JSON only while the expected fields still match', async () => {
    const config = {
      get: () => 'redis://127.0.0.1:1',
    } as unknown as ConfigService;
    const cache = new RedisCacheService(new RedisConnection(config));
    const expected = {
      'execution.status': 'generating',
      'execution.attemptId': 'attempt-a',
    };
    await cache.setJson(
      'blendify:test:session',
      { execution: { status: 'generating', attemptId: 'attempt-b' } },
      60_000,
    );

    await expect(
      cache.setJsonIfFields(
        'blendify:test:session',
        { execution: { status: 'generated' } },
        60_000,
        expected,
      ),
    ).resolves.toBe(false);
    await expect(cache.getJson('blendify:test:session')).resolves.toEqual({
      execution: { status: 'generating', attemptId: 'attempt-b' },
    });

    await cache.setJson(
      'blendify:test:session',
      { execution: { status: 'generating', attemptId: 'attempt-a' } },
      60_000,
    );
    await expect(
      cache.setJsonIfFields(
        'blendify:test:session',
        { execution: { status: 'generated' } },
        60_000,
        expected,
      ),
    ).resolves.toBe(true);
    await expect(cache.getJson('blendify:test:session')).resolves.toEqual({
      execution: { status: 'generated' },
    });
    await expect(
      cache.setJsonIfFields('blendify:test:missing', {}, 60_000, expected),
    ).resolves.toBe(false);
  });

  it('deletes JSON only while the expected fields still match', async () => {
    const config = {
      get: () => 'redis://127.0.0.1:1',
    } as unknown as ConfigService;
    const cache = new RedisCacheService(new RedisConnection(config));
    const expected = {
      'destination.status': 'publishing',
      'destination.attemptId': 'attempt-a',
    };
    await cache.setJson(
      'blendify:test:destination',
      { destination: { status: 'publishing', attemptId: 'attempt-b' } },
      60_000,
    );

    await expect(
      cache.deleteIfFields('blendify:test:destination', expected),
    ).resolves.toBe(false);
    await expect(
      cache.getJson('blendify:test:destination'),
    ).resolves.not.toBeNull();

    await cache.setJson(
      'blendify:test:destination',
      { destination: { status: 'publishing', attemptId: 'attempt-a' } },
      60_000,
    );
    await expect(
      cache.deleteIfFields('blendify:test:destination', expected),
    ).resolves.toBe(true);
    await expect(
      cache.getJson('blendify:test:destination'),
    ).resolves.toBeNull();
    await expect(
      cache.deleteIfFields('blendify:test:destination', expected),
    ).resolves.toBe(false);
  });

  it('does not delete an expired entry', async () => {
    jest.useFakeTimers();
    try {
      const config = {
        get: () => 'redis://127.0.0.1:1',
      } as unknown as ConfigService;
      const cache = new RedisCacheService(new RedisConnection(config));
      await cache.setJson('blendify:test:expiring', { status: 'x' }, 1_000);
      jest.advanceTimersByTime(1_001);

      await expect(
        cache.deleteIfFields('blendify:test:expiring', { status: 'x' }),
      ).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('redacts passwords in Redis URLs', () => {
    expect(sanitizeRedisUrl('redis://:s3cret@localhost:6379/0')).toContain(
      '***',
    );
    expect(sanitizeRedisUrl('redis://localhost:6379')).toContain('localhost');
    expect(sanitizeRedisUrl('not-a-url')).toBe('redis://***');
  });
});

describe('RedisCacheService with Redis', () => {
  function withClient(client: Record<string, jest.Mock>) {
    const connection = {
      readyClient: () => client,
    } as unknown as RedisConnection;
    return new RedisCacheService(connection);
  }

  it('acquires with the owner value, NX and a millisecond TTL', async () => {
    const set = jest
      .fn()
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null);
    const cache = withClient({ set });

    await expect(cache.setIfAbsent('lock', 'owner-a', 5_000)).resolves.toBe(
      true,
    );
    await expect(cache.setIfAbsent('lock', 'owner-b', 5_000)).resolves.toBe(
      false,
    );
    expect(set).toHaveBeenCalledWith('lock', 'owner-a', 'PX', 5_000, 'NX');
  });

  it('renews through one atomic compare-and-expire script', async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const cache = withClient({ eval: evalMock });

    await expect(cache.renewIfValue('lock', 'owner-a', 5_000)).resolves.toBe(
      true,
    );
    await expect(cache.renewIfValue('lock', 'owner-b', 5_000)).resolves.toBe(
      false,
    );
    expect(evalMock).toHaveBeenCalledWith(
      RENEW_IF_VALUE_SCRIPT,
      1,
      'lock',
      'owner-a',
      5_000,
    );
    expect(RENEW_IF_VALUE_SCRIPT).toContain("redis.call('PEXPIRE'");
  });

  it('propagates a Redis failure on renewal instead of reporting a lost lease', async () => {
    const cache = withClient({
      eval: jest.fn().mockRejectedValue(new Error('Command timed out')),
    });

    await expect(cache.renewIfValue('lock', 'owner-a', 5_000)).rejects.toThrow(
      'Command timed out',
    );
  });

  it('replaces JSON through one atomic conditional script', async () => {
    const evalMock = jest.fn().mockResolvedValue(1);
    const cache = withClient({ eval: evalMock });

    await expect(
      cache.setJsonIfFields('session', { ok: true }, 60_000, {
        'execution.attemptId': 'attempt-a',
      }),
    ).resolves.toBe(true);
    expect(evalMock).toHaveBeenCalledWith(
      SET_JSON_IF_FIELDS_SCRIPT,
      1,
      'session',
      '{"ok":true}',
      60_000,
      'execution.attemptId',
      'attempt-a',
    );
  });

  it('deletes through one atomic conditional script', async () => {
    const evalMock = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const cache = withClient({ eval: evalMock });

    await expect(
      cache.deleteIfFields('destination', {
        'destination.status': 'publishing',
        'destination.attemptId': 'attempt-a',
      }),
    ).resolves.toBe(true);
    await expect(
      cache.deleteIfFields('destination', { 'destination.attemptId': 'b' }),
    ).resolves.toBe(false);
    expect(evalMock).toHaveBeenCalledWith(
      DELETE_IF_FIELDS_SCRIPT,
      1,
      'destination',
      'destination.status',
      'publishing',
      'destination.attemptId',
      'attempt-a',
    );
    expect(DELETE_IF_FIELDS_SCRIPT).toContain("redis.call('DEL', KEYS[1])");
    expect(DELETE_IF_FIELDS_SCRIPT).toContain('for i = 1, #ARGV, 2 do');
    expect(SET_JSON_IF_FIELDS_SCRIPT).toContain('for i = 3, #ARGV, 2 do');
  });

  it('releases through one atomic compare-and-delete script', async () => {
    const evalMock = jest.fn().mockResolvedValue(0);
    const cache = withClient({ eval: evalMock });

    await cache.deleteIfValue('lock', 'stale-owner');

    expect(evalMock).toHaveBeenCalledWith(
      DELETE_IF_VALUE_SCRIPT,
      1,
      'lock',
      'stale-owner',
    );
    expect(DELETE_IF_VALUE_SCRIPT).toContain(
      "redis.call('GET', KEYS[1]) == ARGV[1]",
    );
  });
});

describe('RedisCacheService coordination writes', () => {
  const COORDINATION = { coordination: true };

  function unavailable(fallback: 'memory' | 'fail-closed') {
    const connection = {
      readyClient: () => null,
    } as unknown as RedisConnection;
    return new RedisCacheService(connection, fallback);
  }

  function failing(fallback: 'memory' | 'fail-closed') {
    const failure = new Error('Command timed out');
    const client = {
      set: jest.fn().mockRejectedValue(failure),
      eval: jest.fn().mockRejectedValue(failure),
    };
    const connection = {
      readyClient: () => client,
    } as unknown as RedisConnection;
    return new RedisCacheService(connection, fallback);
  }

  function coordinatedWrites(cache: RedisCacheService) {
    return [
      () => cache.setIfAbsent('claim', 'owner-a', 30_000, COORDINATION),
      () => cache.renewIfValue('claim', 'owner-a', 30_000, COORDINATION),
      () =>
        cache.setJsonIfFields(
          'record',
          { ok: true },
          60_000,
          { status: 'publishing' },
          COORDINATION,
        ),
      () =>
        cache.deleteIfFields('record', { status: 'publishing' }, COORDINATION),
    ];
  }

  it('fails closed instead of coordinating in process memory while Redis is unavailable', async () => {
    const cache = unavailable('fail-closed');

    for (const write of coordinatedWrites(cache)) {
      await expect(write()).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
    }
    await expect(cache.setIfAbsent('claim', 'owner-b', 30_000)).resolves.toBe(
      true,
    );
  });

  it('fails closed when Redis errors or times out on a coordination write', async () => {
    const cache = failing('fail-closed');

    for (const write of coordinatedWrites(cache)) {
      await expect(write()).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
    }
  });

  it('fails closed on a coordinated existence check instead of reporting the key absent', async () => {
    await expect(
      unavailable('fail-closed').exists('claim', COORDINATION),
    ).rejects.toBeInstanceOf(CoordinationUnavailableError);

    const client = { exists: jest.fn().mockRejectedValue(new Error('boom')) };
    const connection = {
      readyClient: () => client,
    } as unknown as RedisConnection;
    await expect(
      new RedisCacheService(connection, 'fail-closed').exists(
        'claim',
        COORDINATION,
      ),
    ).rejects.toBeInstanceOf(CoordinationUnavailableError);
  });

  it('keeps the best-effort existence check on its memory fallback by default', async () => {
    const client = { exists: jest.fn().mockRejectedValue(new Error('boom')) };
    const connection = {
      readyClient: () => client,
    } as unknown as RedisConnection;

    await expect(
      new RedisCacheService(connection, 'fail-closed').exists('claim'),
    ).resolves.toBe(false);
    await expect(unavailable('fail-closed').exists('claim')).resolves.toBe(
      false,
    );
  });

  it('never grants a claim from memory after Redis became unavailable', async () => {
    let ready = true;
    const client = { set: jest.fn().mockResolvedValue('OK') };
    const connection = {
      readyClient: () => (ready ? client : null),
    } as unknown as RedisConnection;
    const cache = new RedisCacheService(connection, 'fail-closed');

    await expect(
      cache.setIfAbsent('claim', 'owner-a', 30_000, COORDINATION),
    ).resolves.toBe(true);
    ready = false;

    await expect(
      cache.setIfAbsent('claim', 'owner-b', 30_000, COORDINATION),
    ).rejects.toBeInstanceOf(CoordinationUnavailableError);
  });

  it('keeps best-effort caching on its memory fallback under the fail-closed policy', async () => {
    const cache = unavailable('fail-closed');

    await cache.setJson('blendify:test:catalog', { ok: true }, 60_000);
    await expect(cache.getJson('blendify:test:catalog')).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps coordinating in process memory for Redis-less local development', async () => {
    const cache = unavailable('memory');

    await expect(
      cache.setIfAbsent('claim', 'owner-a', 30_000, COORDINATION),
    ).resolves.toBe(true);
    await expect(
      cache.setIfAbsent('claim', 'owner-b', 30_000, COORDINATION),
    ).resolves.toBe(false);
    await expect(
      cache.renewIfValue('claim', 'owner-a', 30_000, COORDINATION),
    ).resolves.toBe(true);
  });

  it('fails closed on coordinated JSON reads and writes while Redis is unavailable', async () => {
    const cache = unavailable('fail-closed');

    await expect(cache.getJson('record', COORDINATION)).rejects.toBeInstanceOf(
      CoordinationUnavailableError,
    );
    await expect(
      cache.setJson('record', { ok: true }, 60_000, COORDINATION),
    ).rejects.toBeInstanceOf(CoordinationUnavailableError);
  });

  it('fails closed when Redis errors on a coordinated JSON read or write', async () => {
    const failure = new Error('Command timed out');
    const client = {
      get: jest.fn().mockRejectedValue(failure),
      set: jest.fn().mockRejectedValue(failure),
    };
    const cache = new RedisCacheService(
      { readyClient: () => client } as unknown as RedisConnection,
      'fail-closed',
    );

    await expect(cache.getJson('record', COORDINATION)).rejects.toBeInstanceOf(
      CoordinationUnavailableError,
    );
    await expect(
      cache.setJson('record', { ok: true }, 60_000, COORDINATION),
    ).rejects.toBeInstanceOf(CoordinationUnavailableError);
    await expect(cache.getJson('record')).resolves.toBeNull();
  });

  it('keeps coordinated JSON in process memory for Redis-less local development', async () => {
    const cache = unavailable('memory');

    await cache.setJson('record', { ok: true }, 60_000, COORDINATION);

    await expect(cache.getJson('record', COORDINATION)).resolves.toEqual({
      ok: true,
    });
  });

  it('keeps the raw Redis error for coordination writes outside the fail-closed policy', async () => {
    const cache = failing('memory');

    await expect(
      cache.renewIfValue('claim', 'owner-a', 30_000, COORDINATION),
    ).rejects.toThrow('Command timed out');
  });
});
