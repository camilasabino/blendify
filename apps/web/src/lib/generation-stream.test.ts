import { describe, expect, it } from 'vitest'
import {
  parseGenerationStreamLine,
  readGenerationStream,
} from '@/lib/generation-stream'
import { ApiError } from '@/lib/api-error'
import { canRetryGeneration } from '@/lib/generation-failure'
import {
  GeneratedPlaylistStreamEventSchema,
  SpotifyPreviewStreamEventSchema,
  type GeneratedPlaylistDto,
  type SpotifyPreviewDto,
} from '@blendify/contracts'

const generation = {
  version: 1,
  kind: 'artist_mix',
  filters: { region: null, femaleVocals: false, releaseRange: null, excludeLive: false },
  tracksPerSeed: 1,
  seeds: [{ id: 'a1', name: 'Sade' }],
  popularity: 'balanced',
  orderMode: 'random',
} satisfies GeneratedPlaylistDto['generation']

const spotifyPreview = {
  previewId: 'AAAAAAAAAAAAAAAAAAAAAA',
  expiresAt: '2026-01-01T00:30:00.000Z',
  playlist: {
    name: 'Mix',
    description: '',
    generation,
    seeds: [{ type: 'artist', id: 'a1', name: 'Sade' }],
    tracks: [],
  },
} satisfies SpotifyPreviewDto

describe('parseGenerationStreamLine', () => {
  it('parses progress events', () => {
    expect(
      parseGenerationStreamLine(
        JSON.stringify({
          type: 'progress',
          phase: 'matching_tracks',
          current: 2,
          total: 10,
          percent: 26,
          etaSeconds: 12,
        }),
        SpotifyPreviewStreamEventSchema,
      ),
    ).toMatchObject({
      type: 'progress',
      phase: 'matching_tracks',
      current: 2,
      percent: 26,
    })
  })

  it('ignores blank and invalid lines', () => {
    expect(parseGenerationStreamLine('', SpotifyPreviewStreamEventSchema)).toBeNull()
    expect(
      parseGenerationStreamLine('{nope', SpotifyPreviewStreamEventSchema),
    ).toBeNull()
    expect(
      parseGenerationStreamLine(
        JSON.stringify({ type: 'nope' }),
        SpotifyPreviewStreamEventSchema,
      ),
    ).toBeNull()
  })
})

describe('readGenerationStream', () => {
  it('applies progress callbacks and returns the result playlist', async () => {
    const progress: number[] = []
    const body = [
      JSON.stringify({
        type: 'progress',
        phase: 'matching_tracks',
        current: 1,
        total: 2,
        percent: 50,
      }),
      JSON.stringify({ type: 'result', playlist: spotifyPreview }),
      '',
    ].join('\n')

    const response = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    })

    const result = await readGenerationStream(
      response,
      SpotifyPreviewStreamEventSchema,
      (event) => {
        progress.push(event.percent)
      },
    )

    expect(progress).toEqual([50])
    expect(result.previewId).toBe(spotifyPreview.previewId)
  })

  it('throws ApiError for stream error events', async () => {
    const body = `${JSON.stringify({
      type: 'error',
      statusCode: 422,
      code: 'NO_TRACKS_FOUND',
      message: 'No tracks',
    })}\n`

    await expect(
      readGenerationStream(
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
        SpotifyPreviewStreamEventSchema,
      ),
    ).rejects.toEqual(expect.any(ApiError))
  })
})

const generatedPlaylist = {
  name: 'Mix',
  description: '',
  generation,
  seeds: spotifyPreview.playlist.seeds,
  tracks: [],
  transfer: null,
} satisfies GeneratedPlaylistDto

function ndjson(...events: unknown[]): Response {
  return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' },
  })
}

describe('readGenerationStream contracts', () => {
  it('returns a Guest generated playlist with the Guest schema', async () => {
    const result = await readGenerationStream(
      ndjson({ type: 'result', playlist: generatedPlaylist }),
      GeneratedPlaylistStreamEventSchema,
    )

    expect(result).toEqual(generatedPlaylist)
  })

  it('rejects a Guest result read with the Spotify schema', async () => {
    await expect(
      readGenerationStream(
        ndjson({ type: 'result', playlist: generatedPlaylist }),
        SpotifyPreviewStreamEventSchema,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_GENERATION_RESPONSE' })
  })

  it('rejects a Spotify result read with the Guest schema', async () => {
    await expect(
      readGenerationStream(
        ndjson({ type: 'result', playlist: spotifyPreview }),
        GeneratedPlaylistStreamEventSchema,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_GENERATION_RESPONSE' })
  })

  it('resolves on the terminal result event without waiting for the stream to close', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: 'result', playlist: generatedPlaylist })}\n`,
          ),
        )
      },
    })
    const response = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/x-ndjson' },
    })

    await expect(
      readGenerationStream(response, GeneratedPlaylistStreamEventSchema),
    ).resolves.toEqual(generatedPlaylist)
  })
})

describe('interrupted generation streams', () => {
  it('reports a stream that ends without a terminal event as a retryable failure', async () => {
    const error = await readGenerationStream(
      ndjson({ type: 'progress', phase: 'matching_tracks', current: 1, total: 1, percent: 95 }),
      SpotifyPreviewStreamEventSchema,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'GENERATION_STREAM_INTERRUPTED' })
    expect(canRetryGeneration(error)).toBe(true)
  })

  it('keeps a transport failure retryable because generation writes nothing', () => {
    expect(canRetryGeneration(new TypeError('network error'))).toBe(true)
  })
})
