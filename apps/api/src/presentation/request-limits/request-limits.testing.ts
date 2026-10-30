import type { Provider } from '@nestjs/common';
import { PUBLICATION_QUOTA } from '@/domain/repositories/publication-quota.port';
import { MemoryRequestLimitStore } from '@/infrastructure/request-limits/memory-request-limit.store';
import { GenerationConcurrencyInterceptor } from './generation-concurrency.interceptor';
import { PublicationQuotaAdapter } from './publication-quota.adapter';
import { RateLimitGuard } from './rate-limit.guard';
import { RequestLimiter } from './request-limiter';
import {
  DEFAULT_GENERATION_CONCURRENCY,
  DEFAULT_RATE_LIMITS,
  type RequestLimitsConfig,
} from './request-limits.config';

export function inMemoryRequestLimitProviders(
  config: Partial<RequestLimitsConfig> = {},
): Provider[] {
  return [
    {
      provide: RequestLimiter,
      useFactory: () =>
        new RequestLimiter(null, new MemoryRequestLimitStore(), {
          production: false,
          clientIpSource: 'express',
          rateLimits: DEFAULT_RATE_LIMITS,
          concurrency: DEFAULT_GENERATION_CONCURRENCY,
          ...config,
        }),
    },
    RateLimitGuard,
    GenerationConcurrencyInterceptor,
    PublicationQuotaAdapter,
    { provide: PUBLICATION_QUOTA, useExisting: PublicationQuotaAdapter },
  ];
}
