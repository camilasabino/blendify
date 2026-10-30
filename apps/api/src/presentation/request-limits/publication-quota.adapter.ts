import { Injectable } from '@nestjs/common';
import type { PublicationQuotaPort } from '@/domain/repositories/publication-quota.port';
import { userIdentity } from './client-identity';
import { RequestLimiter } from './request-limiter';

@Injectable()
export class PublicationQuotaAdapter implements PublicationQuotaPort {
  constructor(private readonly limiter: RequestLimiter) {}

  consume(userId: string): Promise<void> {
    return this.limiter.consume('publish', userIdentity(userId));
  }
}
