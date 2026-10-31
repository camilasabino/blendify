import { QueryClient } from '@tanstack/react-query'
import {
  checkPlaylistPreviewStatus,
  restoreSpotifyPreview,
  savePlaylistPreview,
} from '@/lib/spotify-preview-save'
import {
  usePlaylistRunStore,
  type PlaylistRunSpec,
} from '@/stores/playlist-run-store'
import { jsonResponse, stubApi, type FetchCall } from '@/test/app-harness'
import {
  jazzPreview,
  PREVIEW_ID,
  previewState,
  publishedDestination,
} from '@/test/playlist-fixtures'

vi.mock('@/lib/playlist-cover', () => ({
  renderPlaylistCoverBase64: vi.fn(() => Promise.resolve('cover-data')),
}))

const SAVE_ROUTE = `POST /api/previews/${PREVIEW_ID}/save`
const STATE_ROUTE = `GET /api/previews/${PREVIEW_ID}`

const spec: PlaylistRunSpec = {
  feature: 'mix',
  mode: 'spotify',
  request: {
    kind: 'genre_mix',
    name: 'Jazz',
    description: '',
    genreIds: ['jazz'],
    popularity: 'balanced',
    tracksPerSeed: 1,
    orderMode: 'random',
  },
}

function store() {
  return usePlaylistRunStore.getState()
}

function session() {
  const { run } = store()
  return run?.status.phase === 'succeeded' ? run.status.spotify : null
}

function savePhase() {
  return session()?.save
}

function previewReady(expiresAt?: string) {
  const { id } = store().begin(spec)!
  store().succeed(id, {
    mode: 'spotify',
    preview: jazzPreview(expiresAt ? { expiresAt } : {}),
  })
  return id
}

function apiError(statusCode: number, code: string, details?: Record<string, unknown>) {
  return jsonResponse({ statusCode, code, message: code, ...(details ? { details } : {}) }, statusCode)
}

function posts(calls: FetchCall[]) {
  return calls.filter((call) => call.method === 'POST')
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
}

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

let queryClient: QueryClient
let invalidate: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  queryClient = new QueryClient()
  invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  localStorage.clear()
})

afterEach(() => {
  store().discard()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('saving a preview', () => {
  it('publishes once with the edited title, the cover and the Library preference read at save time', async () => {
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => jsonResponse(previewState(publishedDestination)),
    })
    const id = previewReady()
    store().setTitle(id, '  Evening jazz  ')
    localStorage.setItem('blendify.persistToLibrary', 'false')

    await savePlaylistPreview(queryClient)

    expect(posts(calls)).toHaveLength(1)
    expect(posts(calls)[0].body).toEqual({
      name: 'Evening jazz',
      persistToLibrary: false,
      coverImageBase64: 'cover-data',
    })
    expect(savePhase()).toMatchObject({
      phase: 'settled',
      destination: { status: 'published' },
    })
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['usage-stats'] }],
      [{ queryKey: ['playlists'] }],
    ])
  })

  it('sends no cover when the option is off', async () => {
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => jsonResponse(previewState(publishedDestination)),
    })
    const id = previewReady()
    store().setCoverOption(id, false)

    await savePlaylistPreview(queryClient)

    expect(posts(calls)[0].body).not.toHaveProperty('coverImageBase64')
  })

  it('does not block the save when the cover cannot be rendered', async () => {
    const cover = await import('@/lib/playlist-cover')
    vi.mocked(cover.renderPlaylistCoverBase64).mockRejectedValueOnce(new Error('canvas'))
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => jsonResponse(previewState(publishedDestination)),
    })
    previewReady()

    await savePlaylistPreview(queryClient)

    expect(posts(calls)).toHaveLength(1)
    expect(posts(calls)[0].body).not.toHaveProperty('coverImageBase64')
    expect(session()?.coverRenderFailed).toBe(true)
    expect(savePhase()?.phase).toBe('settled')
  })

  it('sends exactly one request however many times Save is triggered', async () => {
    let release: (response: Response) => void = () => {}
    const { calls } = stubApi({
      [SAVE_ROUTE]: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    previewReady()

    const first = savePlaylistPreview(queryClient)
    const second = savePlaylistPreview(queryClient)
    const third = savePlaylistPreview(queryClient)
    await settle()
    release(jsonResponse(previewState(publishedDestination)))
    await Promise.all([first, second, third])

    expect(posts(calls)).toHaveLength(1)
  })

  it('does not save an invalid title', async () => {
    const { calls } = stubApi({})
    const id = previewReady()
    store().setTitle(id, '   ')

    await savePlaylistPreview(queryClient)

    expect(calls).toHaveLength(0)
    expect(savePhase()).toEqual({ phase: 'idle' })
  })

  it.each([
    ['published', publishedDestination, true],
    [
      'publish_incomplete (outcome_unknown)',
      { status: 'publish_incomplete', spotifyUrl: null, reason: 'outcome_unknown' },
      false,
    ],
    [
      'publish_incomplete (tracks_incomplete)',
      {
        status: 'publish_incomplete',
        spotifyUrl: 'https://open.spotify.com/playlist/p',
        reason: 'tracks_incomplete',
      },
      false,
    ],
    [
      'publish_incomplete (library_not_saved)',
      {
        status: 'publish_incomplete',
        spotifyUrl: 'https://open.spotify.com/playlist/p',
        reason: 'library_not_saved',
      },
      false,
    ],
    [
      'publish_incomplete (interrupted)',
      { status: 'publish_incomplete', spotifyUrl: null, reason: 'interrupted' },
      false,
    ],
  ] as const)('settles on the server outcome %s and invalidates only for a confirmed publication', async (_label, destination, invalidates) => {
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => jsonResponse(previewState(destination)),
    })
    previewReady()

    await savePlaylistPreview(queryClient)

    expect(savePhase()).toMatchObject({ phase: 'settled', destination })
    expect(invalidate).toHaveBeenCalledTimes(invalidates ? 2 : 0)
    expect(posts(calls)).toHaveLength(1)
  })

  it('settles an incomplete outcome that has no Spotify link and offers no new save', async () => {
    stubApi({
      [SAVE_ROUTE]: () =>
        jsonResponse(previewState({ status: 'publish_incomplete', spotifyUrl: null })),
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await savePlaylistPreview(queryClient)

    expect(savePhase()).toMatchObject({ phase: 'settled' })
  })
})

describe('confirmed failures', () => {
  it.each([
    ['SPOTIFY_REQUEST_REJECTED', 502],
    ['SPOTIFY_REAUTH_REQUIRED', 401],
    ['SPOTIFY_PERMISSION_DENIED', 403],
    ['RATE_LIMITED', 429],
    ['SERVICE_UNAVAILABLE', 503],
    ['UNAUTHORIZED', 401],
  ])('returns to the unsaved preview on %s and never retries on its own', async (code, status) => {
    const { calls } = stubApi({ [SAVE_ROUTE]: () => apiError(status, code) })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(120_000)

    expect(savePhase()).toMatchObject({ phase: 'failed' })
    expect(posts(calls)).toHaveLength(1)
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(0)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('keeps the wait of a rate limit and allows saving again after it', async () => {
    let attempt = 0
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => {
        attempt += 1
        return attempt === 1
          ? apiError(429, 'RATE_LIMITED', { retryAfterSeconds: 30 })
          : jsonResponse(previewState(publishedDestination))
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    expect(savePhase()).toMatchObject({
      phase: 'failed',
      retryAt: Date.now() + 30_000,
    })

    await savePlaylistPreview(queryClient)

    expect(posts(calls)).toHaveLength(2)
    expect(savePhase()?.phase).toBe('settled')
  })

  it('retries the same save after a confirmed rejection only on a new user action', async () => {
    let attempt = 0
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => {
        attempt += 1
        return attempt === 1
          ? apiError(502, 'SPOTIFY_REQUEST_REJECTED')
          : jsonResponse(previewState(publishedDestination))
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    expect(posts(calls)).toHaveLength(1)
    await savePlaylistPreview(queryClient)

    expect(posts(calls)).toHaveLength(2)
    expect(savePhase()?.phase).toBe('settled')
  })
})

describe('reconciliation', () => {
  it('reconciles a 409 through GET and never repeats the POST', async () => {
    let reads = 0
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => {
        reads += 1
        return jsonResponse(
          previewState(reads < 3 ? { status: 'publishing' } : publishedDestination),
        )
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: false })

    await advance(1_000)
    await advance(2_000)
    await advance(4_000)

    expect(savePhase()).toMatchObject({ phase: 'settled' })
    expect(posts(calls)).toHaveLength(1)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('keeps polling a 409 while the other request has not created its destination yet', async () => {
    let reads = 0
    stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => {
        reads += 1
        return jsonResponse(previewState(reads < 2 ? null : publishedDestination))
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(1_000)
    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: false })
    await advance(2_000)

    expect(savePhase()?.phase).toBe('settled')
  })

  it('reconciles a network failure and returns to the unsaved preview when the server never saw it', async () => {
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => Promise.reject(new TypeError('network error')),
      [STATE_ROUTE]: () => jsonResponse(previewState(null)),
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: false })
    await advance(1_000)

    expect(savePhase()).toMatchObject({ phase: 'failed' })
    expect(posts(calls)).toHaveLength(1)
  })

  it('reconciles a response without an error code', async () => {
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => new Response('Bad gateway', { status: 502 }),
      [STATE_ROUTE]: () => jsonResponse(previewState(publishedDestination)),
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(1_000)

    expect(savePhase()?.phase).toBe('settled')
    expect(posts(calls)).toHaveLength(1)
  })

  it('reconciles an unreadable success response', async () => {
    stubApi({
      [SAVE_ROUTE]: () => jsonResponse({ nope: true }),
      [STATE_ROUTE]: () => jsonResponse(previewState(publishedDestination)),
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(1_000)

    expect(savePhase()?.phase).toBe('settled')
  })

  it('polls at 1, 2, 4 and 8 seconds, then every 8 seconds, and stops at the 60 second cap', async () => {
    const reads: number[] = []
    const startedAt = Date.now()
    stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => {
        reads.push(Date.now() - startedAt)
        return jsonResponse(previewState({ status: 'publishing' }))
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(70_000)

    expect(reads).toEqual([1_000, 3_000, 7_000, 15_000, 23_000, 31_000, 39_000, 47_000, 55_000, 60_000])
    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: true })
  })

  it('offers a status check after the cap and reuses the server outcome', async () => {
    let published = false
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () =>
        jsonResponse(previewState(published ? publishedDestination : { status: 'publishing' })),
    })
    previewReady()
    await savePlaylistPreview(queryClient)
    await advance(70_000)
    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: true })

    published = true
    await checkPlaylistPreviewStatus(queryClient)

    expect(savePhase()?.phase).toBe('settled')
    expect(posts(calls)).toHaveLength(1)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('keeps the status check available while the save is still running', async () => {
    stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => jsonResponse(previewState({ status: 'publishing' })),
    })
    previewReady()
    await savePlaylistPreview(queryClient)
    await advance(70_000)

    await checkPlaylistPreviewStatus(queryClient)

    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: true })
  })

  it('does not claim nothing was saved when the status check finds the preview gone', async () => {
    let reads = 0
    stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => {
        reads += 1
        return reads < 2
          ? jsonResponse(previewState({ status: 'publishing' }))
          : apiError(404, 'PREVIEW_NOT_FOUND')
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(1_000)
    await advance(2_000)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: true })
  })

  it('stops polling when the run is discarded', async () => {
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => jsonResponse(previewState({ status: 'publishing' })),
    })
    previewReady()
    await savePlaylistPreview(queryClient)

    store().discard()
    await advance(70_000)

    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(0)
  })

  it('survives transient read failures while polling', async () => {
    let reads = 0
    stubApi({
      [SAVE_ROUTE]: () => apiError(409, 'PREVIEW_SAVE_IN_PROGRESS'),
      [STATE_ROUTE]: () => {
        reads += 1
        return reads === 1
          ? Promise.reject(new TypeError('offline'))
          : jsonResponse(previewState(publishedDestination))
      },
    })
    previewReady()

    await savePlaylistPreview(queryClient)
    await advance(1_000)
    expect(savePhase()?.phase).toBe('reconciling')
    await advance(2_000)

    expect(savePhase()?.phase).toBe('settled')
  })
})

describe('an unavailable preview', () => {
  it('treats a 404 on a preview the client still thinks is live as possibly saved', async () => {
    stubApi({ [SAVE_ROUTE]: () => apiError(404, 'PREVIEW_NOT_FOUND') })
    previewReady()

    await savePlaylistPreview(queryClient)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: true })
  })

  it('treats a first-attempt 404 after the client expiry time as possibly saved', async () => {
    const { calls } = stubApi({ [SAVE_ROUTE]: () => apiError(404, 'PREVIEW_NOT_FOUND') })
    previewReady('2026-01-01T00:00:30.000Z')
    vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'))

    await savePlaylistPreview(queryClient)
    await advance(60_000)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: true })
    expect(posts(calls)).toHaveLength(1)
  })

  it('treats a first-attempt 404 as possibly saved when the client clock runs ahead of the server', async () => {
    stubApi({ [SAVE_ROUTE]: () => apiError(404, 'PREVIEW_NOT_FOUND') })
    previewReady('2026-01-01T00:20:00.000Z')
    vi.setSystemTime(new Date('2026-01-01T01:00:00.000Z'))

    await savePlaylistPreview(queryClient)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: true })
  })

  it('treats a 404 that follows a possibly completed publication as possibly saved and never retries', async () => {
    let writes = 0
    const { calls } = stubApi({
      [SAVE_ROUTE]: () => {
        writes += 1
        return apiError(404, 'PREVIEW_NOT_FOUND')
      },
    })
    previewReady()
    const id = store().run!.id
    store().beginSave(id)
    store().failSave(id, new Error('first attempt failed'), null)

    await savePlaylistPreview(queryClient)
    await advance(120_000)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: true })
    expect(writes).toBe(1)
    expect(posts(calls)).toHaveLength(1)
  })

  it('never sends a save for a preview that already expired on the client', async () => {
    const { calls } = stubApi({})
    const id = previewReady()
    store().expireUnsaved(id)

    await savePlaylistPreview(queryClient)

    expect(calls).toHaveLength(0)
  })
})

describe('restoring a preview', () => {
  const stored = {
    feature: 'mix' as const,
    request: spec.request as Extract<PlaylistRunSpec, { feature: 'mix' }>['request'],
    previewId: PREVIEW_ID,
    expiresAt: '2026-01-01T00:20:00.000Z',
    title: 'My edit',
    coverOption: false,
    saveAttempted: false,
  }

  it('restores an unsaved preview with its title draft and cover option', async () => {
    stubApi({ [STATE_ROUTE]: () => jsonResponse(previewState(null)) })

    await restoreSpotifyPreview(stored, queryClient)

    expect(store().run).toMatchObject({ seen: true, spec: { mode: 'spotify', feature: 'mix' } })
    expect(session()).toMatchObject({
      title: 'My edit',
      coverOption: false,
      save: { phase: 'idle' },
    })
  })

  it('restores a settled outcome even when the preview content is gone', async () => {
    stubApi({
      [STATE_ROUTE]: () =>
        jsonResponse(previewState(publishedDestination, { playlist: null })),
    })

    await restoreSpotifyPreview(stored, queryClient)

    expect(store().run?.status).toMatchObject({
      outcome: { preview: { playlist: null } },
    })
    expect(savePhase()).toMatchObject({ phase: 'settled' })
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('resumes reconciling a publication that was running when the page reloaded, without a POST', async () => {
    let reads = 0
    const { calls } = stubApi({
      [STATE_ROUTE]: () => {
        reads += 1
        return jsonResponse(
          previewState(reads < 2 ? { status: 'publishing' } : publishedDestination),
        )
      },
    })

    await restoreSpotifyPreview(stored, queryClient)
    expect(savePhase()).toEqual({ phase: 'reconciling', exhausted: false })
    await advance(1_000)
    await advance(2_000)

    expect(savePhase()?.phase).toBe('settled')
    expect(posts(calls)).toHaveLength(0)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('returns to the unsaved preview when a publication that was running turns out rejected', async () => {
    let reads = 0
    stubApi({
      [STATE_ROUTE]: () => {
        reads += 1
        return jsonResponse(previewState(reads < 2 ? { status: 'publishing' } : null))
      },
    })

    await restoreSpotifyPreview(stored, queryClient)
    await advance(1_000)

    expect(savePhase()).toMatchObject({ phase: 'failed' })
  })

  it('shows plain expiry for a 404 after the expiry time when no save was attempted', async () => {
    stubApi({ [STATE_ROUTE]: () => apiError(404, 'PREVIEW_NOT_FOUND') })
    vi.setSystemTime(new Date('2026-01-01T00:25:00.000Z'))

    await restoreSpotifyPreview(stored, queryClient)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: false })
  })

  it('shows neutral copy state when a preview with no save attempt vanished before its expiry', async () => {
    stubApi({ [STATE_ROUTE]: () => apiError(404, 'PREVIEW_NOT_FOUND') })

    await restoreSpotifyPreview(stored, queryClient)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: false, lostEarly: true })
    expect(session()?.hadSaveAttempt).toBe(false)
  })

  it('warns that a save may have happened for a 404 after a recorded attempt, even past the expiry', async () => {
    stubApi({ [STATE_ROUTE]: () => apiError(404, 'PREVIEW_NOT_FOUND') })
    vi.setSystemTime(new Date('2026-01-01T00:25:00.000Z'))

    await restoreSpotifyPreview({ ...stored, saveAttempted: true }, queryClient)

    expect(savePhase()).toEqual({ phase: 'expired', mayHaveSaved: true })
  })

  it('keeps the recorded attempt when the server reports no destination yet', async () => {
    stubApi({ [STATE_ROUTE]: () => jsonResponse(previewState(null)) })

    await restoreSpotifyPreview({ ...stored, saveAttempted: true }, queryClient)

    expect(session()).toMatchObject({ hadSaveAttempt: true, save: { phase: 'idle' } })
  })

  it('does not recreate a run when the app was discarded while the read was pending', async () => {
    let release!: (response: Response) => void
    stubApi({
      [STATE_ROUTE]: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })

    const pending = restoreSpotifyPreview(stored, queryClient)
    store().discard()
    release(jsonResponse(previewState(null)))
    await pending

    expect(store().run).toBeNull()
  })

  it('does not recreate a run from a pending 404 after the restore was aborted', async () => {
    let release!: (response: Response) => void
    stubApi({
      [STATE_ROUTE]: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })

    const pending = restoreSpotifyPreview({ ...stored, saveAttempted: true }, queryClient)
    store().abortRestore()
    release(apiError(404, 'PREVIEW_NOT_FOUND'))
    await pending

    expect(store().run).toBeNull()
  })

  it('restores nothing when the state cannot be read right now', async () => {
    stubApi({ [STATE_ROUTE]: () => Promise.reject(new TypeError('offline')) })

    await restoreSpotifyPreview(stored, queryClient)

    expect(store().run).toBeNull()
  })

  it('does not replace a run that started in the meantime', async () => {
    stubApi({ [STATE_ROUTE]: () => jsonResponse(previewState(null)) })
    const { id } = store().begin(spec)!

    await restoreSpotifyPreview(stored, queryClient)

    expect(store().run).toMatchObject({ id, status: { phase: 'active' } })
  })
})
