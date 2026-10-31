import {
  ApiError,
  CLIENT_OUTDATED,
  PREVIEW_NOT_FOUND,
  PREVIEW_SAVE_IN_PROGRESS,
} from '@/lib/api-error'

export type SaveFailureClass = 'definite' | 'in_progress' | 'not_found' | 'unknown'

const DEFINITE_FAILURE_CODES = new Set([
  'UNAUTHORIZED',
  'USER_NOT_FOUND',
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'CONCURRENCY_LIMITED',
  'CAPACITY_EXCEEDED',
  'SERVICE_UNAVAILABLE',
  'SPOTIFY_REQUEST_REJECTED',
  'SPOTIFY_PERMISSION_DENIED',
  'SPOTIFY_REAUTH_REQUIRED',
  'SPOTIFY_RATE_LIMITED',
  'SPOTIFY_QUOTA_EXCEEDED',
  CLIENT_OUTDATED,
])

export function classifySaveFailure(error: unknown): SaveFailureClass {
  if (!(error instanceof ApiError) || !error.code) {
    return 'unknown'
  }
  if (error.code === PREVIEW_NOT_FOUND) {
    return 'not_found'
  }
  if (error.code === PREVIEW_SAVE_IN_PROGRESS) {
    return 'in_progress'
  }
  return DEFINITE_FAILURE_CODES.has(error.code) ? 'definite' : 'unknown'
}

export function isPreviewNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === PREVIEW_NOT_FOUND
}
