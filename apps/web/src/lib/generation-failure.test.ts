import { ApiError } from '@/lib/api-error'
import { canRetryGeneration, classifyGenerationFailure } from '@/lib/generation-failure'

function apiError(code: string, statusCode: number) {
  return new ApiError(code, statusCode, { statusCode, code, message: code })
}

describe('classifyGenerationFailure', () => {
  it('does not treat every authorization problem as a reconnect', () => {
    expect(classifyGenerationFailure(apiError('SPOTIFY_REAUTH_REQUIRED', 401)).kind).toBe(
      'reauth',
    )
    expect(classifyGenerationFailure(apiError('SPOTIFY_PERMISSION_DENIED', 403)).kind).toBe(
      'blocked',
    )
  })

  it.each([
    ['SPOTIFY_UNAVAILABLE', 503],
    ['SPOTIFY_RATE_LIMITED', 429],
    ['CATALOG_UNAVAILABLE', 503],
    ['TRACK_RESOLVE_FAILED', 422],
    ['GENERATION_STREAM_INTERRUPTED', 502],
  ])('lets %s run again from the same request', (code, status) => {
    expect(canRetryGeneration(apiError(code, status))).toBe(true)
  })

  it('lets a dropped connection run again because generation writes nothing', () => {
    expect(canRetryGeneration(new TypeError('network error'))).toBe(true)
  })

  it.each([
    ['SPOTIFY_REAUTH_REQUIRED', 401],
    ['SPOTIFY_PERMISSION_DENIED', 403],
  ])('does not offer to run %s again', (code, status) => {
    expect(canRetryGeneration(apiError(code, status))).toBe(false)
  })
})
