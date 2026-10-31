import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  SPOTIFY_PREVIEW_RECORD_VERSION,
  type SpotifyPreview,
  type SpotifyPreviewDestinationRecord,
} from '@/domain/preview/spotify-preview';
import { assertOutcomeOutlivesPreview } from '@/domain/preview/spotify-preview.policy';
import type { SpotifyPreviewRepositoryPort } from '@/domain/repositories/spotify-preview.repository.port';
import {
  RedisCacheService,
  type CacheWriteOptions,
} from '@/infrastructure/cache/redis-cache.service';

const PREVIEW_KEY_PREFIX = 'blendify:preview:spotify:v1';
const DESTINATION_KEY_SUFFIX = 'destination';
const CLAIM_KEY_SUFFIX = 'claim';
const COORDINATED: CacheWriteOptions = { coordination: true };

@Injectable()
export class RedisSpotifyPreviewRepository implements SpotifyPreviewRepositoryPort {
  constructor(private readonly cache: RedisCacheService) {
    assertOutcomeOutlivesPreview();
  }

  create(preview: SpotifyPreview, ttlMs: number): Promise<void> {
    return this.cache.setJson(
      previewKey(preview.id),
      preview,
      ttlMs,
      COORDINATED,
    );
  }

  async find(previewId: string): Promise<SpotifyPreview | null> {
    const preview = await this.cache.getJson<SpotifyPreview>(
      previewKey(previewId),
      COORDINATED,
    );
    return preview?.version === SPOTIFY_PREVIEW_RECORD_VERSION ? preview : null;
  }

  async findDestination(
    previewId: string,
  ): Promise<SpotifyPreviewDestinationRecord | null> {
    const record = await this.cache.getJson<SpotifyPreviewDestinationRecord>(
      destinationKey(previewId),
      COORDINATED,
    );
    return record?.version === SPOTIFY_PREVIEW_RECORD_VERSION ? record : null;
  }

  createDestinationIfAbsent(
    record: SpotifyPreviewDestinationRecord,
    ttlMs: number,
  ): Promise<boolean> {
    return this.cache.setIfAbsent(
      destinationKey(record.previewId),
      JSON.stringify(record),
      ttlMs,
      COORDINATED,
    );
  }

  saveDestinationOutcome(
    record: SpotifyPreviewDestinationRecord,
    attemptId: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.cache.setJsonIfFields(
      destinationKey(record.previewId),
      record,
      ttlMs,
      publishingAttempt(attemptId),
      COORDINATED,
    );
  }

  deleteDestinationIfAttempt(
    previewId: string,
    attemptId: string,
  ): Promise<boolean> {
    return this.cache.deleteIfFields(
      destinationKey(previewId),
      publishingAttempt(attemptId),
      COORDINATED,
    );
  }

  async acquireSaveClaim(
    previewId: string,
    ttlMs: number,
  ): Promise<string | null> {
    const claimId = randomUUID();
    const acquired = await this.cache.setIfAbsent(
      claimKey(previewId),
      claimId,
      ttlMs,
      COORDINATED,
    );
    return acquired ? claimId : null;
  }

  renewSaveClaim(
    previewId: string,
    claimId: string,
    ttlMs: number,
  ): Promise<boolean> {
    return this.cache.renewIfValue(
      claimKey(previewId),
      claimId,
      ttlMs,
      COORDINATED,
    );
  }

  releaseSaveClaim(previewId: string, claimId: string): Promise<void> {
    return this.cache.deleteIfValue(claimKey(previewId), claimId);
  }

  hasSaveClaim(previewId: string): Promise<boolean> {
    return this.cache.exists(claimKey(previewId), COORDINATED);
  }
}

function publishingAttempt(attemptId: string): Record<string, string> {
  return {
    'destination.status': 'publishing',
    'destination.attemptId': attemptId,
  };
}

function previewKey(previewId: string): string {
  return `${PREVIEW_KEY_PREFIX}:${previewId}`;
}

function destinationKey(previewId: string): string {
  return `${previewKey(previewId)}:${DESTINATION_KEY_SUFFIX}`;
}

function claimKey(previewId: string): string {
  return `${previewKey(previewId)}:${CLAIM_KEY_SUFFIX}`;
}
