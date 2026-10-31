import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { PreviewError } from '@/domain/errors/preview.error';
import { currentRequestId } from '@/application/services/request-correlation';
import { toApiErrorResponse } from './api-error-response';
import { stripTrailingSlashes } from './strip-trailing-slashes';

export const LEGACY_PUBLISH_REJECTED_EVENT = 'legacy_publish_endpoint.rejected';

const LEGACY_PUBLISH_ENDPOINTS = new Map([
  ['/api/playlists/mix', 'mix'],
  ['/api/playlists/discover', 'discover'],
]);

const logger = new Logger('LegacyPublishEndpoint');

export function rejectLegacyPublishEndpoints(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const endpoint =
    req.method === 'POST'
      ? LEGACY_PUBLISH_ENDPOINTS.get(
          stripTrailingSlashes(req.path).toLowerCase(),
        )
      : undefined;
  if (!endpoint) {
    next();
    return;
  }

  logger.warn(
    JSON.stringify({
      event: LEGACY_PUBLISH_REJECTED_EVENT,
      requestId: currentRequestId(),
      endpoint,
    }),
  );
  const body = toApiErrorResponse(PreviewError.clientOutdated());
  res.status(body.statusCode).json(body);
}
