import { Logger } from '@nestjs/common';
import { MemoryRequestLimitStore } from '@/infrastructure/request-limits/memory-request-limit.store';
import {
  RequestLimitStoreUnavailableError,
  type RequestLimitStore,
} from '@/infrastructure/request-limits/request-limit.store';
import { RequestLimitError } from '@/presentation/http/request-limit.error';
import { PublicationQuotaAdapter } from './publication-quota.adapter';
import { RequestLimiter } from './request-limiter';
import {
  DEFAULT_GENERATION_CONCURRENCY,
  DEFAULT_RATE_LIMITS,
  resolveRateLimits,
  type RequestLimitsConfig,
} from './request-limits.config';

function config(
  overrides: Partial<RequestLimitsConfig> = {},
): RequestLimitsConfig {
  return {
    production: false,
    clientIpSource: 'express',
    rateLimits: DEFAULT_RATE_LIMITS,
    concurrency: DEFAULT_GENERATION_CONCURRENCY,
    ...overrides,
  };
}

function quotaWith(
  redis: RequestLimitStore | null,
  overrides: Partial<RequestLimitsConfig> = {},
) {
  const memory = new MemoryRequestLimitStore();
  const hit = jest.spyOn(memory, 'hit');
  const quota = new PublicationQuotaAdapter(
    new RequestLimiter(redis, memory, config(overrides)),
  );
  return { quota, hit };
}

describe('PublicationQuotaAdapter', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('allows 12 new attempts per user in 10 minutes and rejects the 13th with a wait', async () => {
    const { quota, hit } = quotaWith(null);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await quota.consume('user-1');
    }
    const rejected: unknown = await quota
      .consume('user-1')
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(RequestLimitError);
    expect(rejected).toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
    expect((rejected as RequestLimitError).retryAfterSeconds).toBeGreaterThan(
      0,
    );
    expect(hit).toHaveBeenLastCalledWith(
      'blendify:rl:publish:u:user-1',
      600_000,
    );
    await expect(quota.consume('user-2')).resolves.toBeUndefined();
  });

  it('honors RATE_LIMIT_OVERRIDES for the publish bucket', async () => {
    const { quota } = quotaWith(null, {
      rateLimits: resolveRateLimits('publish=1/60'),
    });

    await quota.consume('user-1');

    await expect(quota.consume('user-1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('fails closed in production when the limit store is unavailable', async () => {
    const unavailable: RequestLimitStore = {
      isAvailable: () => false,
      hit: () => Promise.reject(new RequestLimitStoreUnavailableError()),
      acquire: () => Promise.reject(new RequestLimitStoreUnavailableError()),
      renew: () => Promise.reject(new RequestLimitStoreUnavailableError()),
      release: () => Promise.reject(new RequestLimitStoreUnavailableError()),
    };
    const { quota, hit } = quotaWith(unavailable, { production: true });

    await expect(quota.consume('user-1')).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    });
    expect(hit).not.toHaveBeenCalled();
  });
});
