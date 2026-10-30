import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PUBLICATION_QUOTA } from '@/domain/repositories/publication-quota.port';
import { RedisConnection } from '@/infrastructure/cache/redis-connection';
import { MemoryRequestLimitStore } from '@/infrastructure/request-limits/memory-request-limit.store';
import { RedisRequestLimitStore } from '@/infrastructure/request-limits/redis-request-limit.store';
import { GenerationConcurrencyInterceptor } from '@/presentation/request-limits/generation-concurrency.interceptor';
import { PublicationQuotaAdapter } from '@/presentation/request-limits/publication-quota.adapter';
import { RateLimitGuard } from '@/presentation/request-limits/rate-limit.guard';
import { RequestLimiter } from '@/presentation/request-limits/request-limiter';
import { loadRequestLimitsConfig } from '@/presentation/request-limits/request-limits.config';

@Global()
@Module({
  providers: [
    {
      provide: RequestLimiter,
      inject: [ConfigService, RedisConnection],
      useFactory: (config: ConfigService, connection: RedisConnection) =>
        new RequestLimiter(
          new RedisRequestLimitStore(connection),
          new MemoryRequestLimitStore(),
          loadRequestLimitsConfig((name) => config.get<string>(name)),
        ),
    },
    RateLimitGuard,
    GenerationConcurrencyInterceptor,
    PublicationQuotaAdapter,
    { provide: PUBLICATION_QUOTA, useExisting: PublicationQuotaAdapter },
  ],
  exports: [
    RequestLimiter,
    RateLimitGuard,
    GenerationConcurrencyInterceptor,
    PUBLICATION_QUOTA,
  ],
})
export class RequestLimitsModule {}
