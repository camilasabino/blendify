import { ApiError } from '@/lib/api-error'

export type GenerationFailure =
  | { kind: 'retryable' }
  | { kind: 'reauth' }
  | { kind: 'blocked' }

export function classifyGenerationFailure(error: unknown): GenerationFailure {
  if (error instanceof ApiError) {
    if (error.code === 'SPOTIFY_REAUTH_REQUIRED') {
      return { kind: 'reauth' }
    }
    if (error.code === 'SPOTIFY_PERMISSION_DENIED') {
      return { kind: 'blocked' }
    }
  }
  return { kind: 'retryable' }
}

export function canRetryGeneration(error: unknown): boolean {
  return classifyGenerationFailure(error).kind === 'retryable'
}
