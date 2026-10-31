import {
  rerunPlaylistRun,
  startPlaylistRun,
} from '@/lib/playlist-run-coordinator'
import {
  usePlaylistRunStore,
  type PlaylistRunSpec,
} from '@/stores/playlist-run-store'
import {
  jsonResponse,
  pendingNdjsonResponse,
  stubApi,
  type PendingNdjsonStream,
} from '@/test/app-harness'
import { guestJazzPlaylist, jazzPreview } from '@/test/playlist-fixtures'

const request: PlaylistRunSpec['request'] = {
  kind: 'genre_mix',
  name: 'Jazz',
  description: '',
  genreIds: ['jazz'],
  popularity: 'balanced',
  tracksPerSeed: 1,
  orderMode: 'random',
}

const spotifySpec: PlaylistRunSpec = { feature: 'mix', mode: 'spotify', request }
const discoverSpec: PlaylistRunSpec = {
  feature: 'discover',
  mode: 'spotify',
  request: {
    kind: 'discover_artist',
    artistId: 'artist-1',
    artist: { id: 'artist-1', name: 'Sade', imageUrl: null },
    description: '',
    targetTrackCount: 30,
    popularity: 'balanced',
    orderMode: 'random',
  },
}
const guestSpec: PlaylistRunSpec = { ...spotifySpec, mode: 'guest' }

function phase() {
  return usePlaylistRunStore.getState().run?.status.phase
}

function pendingRoute(streams: PendingNdjsonStream[]) {
  return (_call: unknown, signal?: AbortSignal) => {
    const stream = pendingNdjsonResponse(signal)
    streams.push(stream)
    return stream.response
  }
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  usePlaylistRunStore.getState().discard()
  vi.unstubAllGlobals()
})

describe('playlist run coordinator', () => {
  it('runs a Spotify generation to a preview without any publication', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })

    expect(startPlaylistRun(spotifySpec)).toBe('started')
    streams[0].push({
      type: 'progress',
      phase: 'matching_tracks',
      current: 1,
      total: 1,
      percent: 95,
    })
    await settle()
    expect(usePlaylistRunStore.getState().run?.status).toMatchObject({
      phase: 'active',
      progress: { percent: 95 },
    })

    const stored = jazzPreview()
    streams[0].push({ type: 'result', playlist: stored })
    streams[0].close()
    await settle()

    expect(phase()).toBe('succeeded')
    expect(usePlaylistRunStore.getState().run?.status).toMatchObject({
      outcome: { mode: 'spotify', preview: stored },
      spotify: { save: { phase: 'idle' } },
    })
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/previews/mix',
    ])
  })

  it('sends only the generation request, never publication fields', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })

    startPlaylistRun(spotifySpec)

    expect(calls[0].body).toEqual(request)
  })

  it('uses the Discover preview endpoint for Discover runs', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/discover': pendingRoute(streams) })

    startPlaylistRun(discoverSpec)

    expect(calls.map((call) => call.url)).toEqual(['/api/previews/discover'])
  })

  it('uses the Guest endpoint for Guest runs', async () => {
    const streams: PendingNdjsonStream[] = []
    stubApi({ 'POST /api/generate/mix': pendingRoute(streams) })

    startPlaylistRun(guestSpec)
    streams[0].push({ type: 'result', playlist: guestJazzPlaylist })
    streams[0].close()
    await settle()

    expect(phase()).toBe('succeeded')
    expect(usePlaylistRunStore.getState().run?.status).toMatchObject({ spotify: null })
  })

  it('refuses to start while a run is active without issuing a second request', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })

    expect(startPlaylistRun(spotifySpec)).toBe('started')
    expect(startPlaylistRun(spotifySpec)).toBe('blocked')
    await settle()

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('aborts the request and skips every side effect after a discard', async () => {
    const streams: PendingNdjsonStream[] = []
    stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })

    startPlaylistRun(spotifySpec)
    usePlaylistRunStore.getState().discard()
    await settle()

    expect(streams[0].signal?.aborted).toBe(true)
    expect(usePlaylistRunStore.getState().run).toBeNull()
  })

  it('marks a typed backend error as failed and lets the same request run again', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })

    startPlaylistRun(spotifySpec)
    streams[0].push({
      type: 'error',
      statusCode: 502,
      code: 'CATALOG_UNAVAILABLE',
      message: 'Catalog unavailable',
    })
    streams[0].close()
    await settle()
    expect(phase()).toBe('failed')

    expect(rerunPlaylistRun()).toBe(true)
    await settle()

    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toEqual(posts[0].body)
    expect(phase()).toBe('active')
  })

  it.each([
    ['a dropped connection', () => Promise.reject(new TypeError('network error'))],
    [
      'a stream that ends without a result',
      () =>
        Promise.resolve(
          new Response('', { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
        ),
    ],
    [
      'an HTTP error response',
      () => jsonResponse({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'nope' }, 500),
    ],
  ])('treats %s as an ordinary retryable failure because generation writes nothing', async (_label, respond) => {
    const { calls } = stubApi({ 'POST /api/previews/mix': respond })

    startPlaylistRun(spotifySpec)
    await settle()

    expect(phase()).toBe('failed')
    expect(rerunPlaylistRun()).toBe(true)
    await settle()
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2)
  })

  it.each([
    ['SPOTIFY_REAUTH_REQUIRED', 401],
    ['SPOTIFY_PERMISSION_DENIED', 403],
  ])('does not rerun after %s', async (code, statusCode) => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })
    startPlaylistRun(spotifySpec)
    streams[0].push({ type: 'error', statusCode, code, message: code })
    streams[0].close()
    await settle()

    expect(phase()).toBe('failed')
    expect(rerunPlaylistRun()).toBe(false)
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('reruns a Guest result from the stored request', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/generate/mix': pendingRoute(streams) })
    startPlaylistRun(guestSpec)
    streams[0].push({ type: 'result', playlist: guestJazzPlaylist })
    streams[0].close()
    await settle()

    expect(rerunPlaylistRun()).toBe(true)
    await settle()

    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2)
  })

  it('does not rerun a live Spotify preview', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })
    startPlaylistRun(spotifySpec)
    streams[0].push({ type: 'result', playlist: jazzPreview() })
    streams[0].close()
    await settle()

    expect(rerunPlaylistRun()).toBe(false)
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
  })

  it('generates an expired preview again from the stored request', async () => {
    const streams: PendingNdjsonStream[] = []
    const { calls } = stubApi({ 'POST /api/previews/mix': pendingRoute(streams) })
    startPlaylistRun(spotifySpec)
    streams[0].push({ type: 'result', playlist: jazzPreview() })
    streams[0].close()
    await settle()
    const { run } = usePlaylistRunStore.getState()
    usePlaylistRunStore.getState().expireUnsaved(run!.id)

    expect(rerunPlaylistRun()).toBe(true)
    await settle()

    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toEqual(request)
  })

  describe('replacing an unsaved preview (D4)', () => {
    async function previewOf(spec: PlaylistRunSpec, route: string) {
      const streams: PendingNdjsonStream[] = []
      const api = stubApi({ [`POST ${route}`]: pendingRoute(streams) })
      startPlaylistRun(spec)
      streams[0].push({ type: 'result', playlist: jazzPreview() })
      streams[0].close()
      await settle()
      return api
    }

    it('asks for confirmation before another feature generates over an unsaved preview', async () => {
      const { calls } = await previewOf(spotifySpec, '/api/previews/mix')

      expect(startPlaylistRun(discoverSpec)).toBe('needs_confirmation')

      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
      expect(usePlaylistRunStore.getState().run?.spec.feature).toBe('mix')
    })

    it('replaces the preview once the other feature is confirmed', async () => {
      await previewOf(spotifySpec, '/api/previews/mix')
      stubApi({ 'POST /api/previews/discover': pendingRoute([]) })

      expect(startPlaylistRun(discoverSpec, { confirmedReplacement: true })).toBe('started')

      expect(usePlaylistRunStore.getState().run?.spec.feature).toBe('discover')
    })

    it('needs no confirmation for the same feature and keeps the previous preview meanwhile', async () => {
      await previewOf(spotifySpec, '/api/previews/mix')
      stubApi({ 'POST /api/previews/mix': pendingRoute([]) })

      expect(startPlaylistRun(spotifySpec)).toBe('started')

      expect(usePlaylistRunStore.getState().run?.status).toMatchObject({
        phase: 'active',
        previous: { outcome: { mode: 'spotify' } },
      })
    })

    it('needs no confirmation after the preview expired', async () => {
      await previewOf(spotifySpec, '/api/previews/mix')
      usePlaylistRunStore.getState().expireUnsaved(usePlaylistRunStore.getState().run!.id)
      stubApi({ 'POST /api/previews/discover': pendingRoute([]) })

      expect(startPlaylistRun(discoverSpec)).toBe('started')
    })

    it('never asks Guest runs for confirmation', async () => {
      stubApi({ 'POST /api/generate/discover': pendingRoute([]) })
      usePlaylistRunStore.getState().restore(guestSpec, { mode: 'guest', playlist: guestJazzPlaylist }, null)

      expect(startPlaylistRun({ ...discoverSpec, mode: 'guest' })).toBe('started')
    })
  })
})
