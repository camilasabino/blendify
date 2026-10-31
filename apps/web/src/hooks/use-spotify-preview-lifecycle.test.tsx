import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useSpotifyPreviewLifecycle } from '@/hooks/use-spotify-preview-lifecycle'
import { usePlaylistRunStore, type PlaylistRunSpec } from '@/stores/playlist-run-store'
import { jsonResponse, setAuthState, stubApi, testUser } from '@/test/app-harness'
import { jazzPreview, PREVIEW_ID, previewState, publishedDestination } from '@/test/playlist-fixtures'

const STORAGE_KEY = 'blendify.spotifyPreview'

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

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function previewReady(expiresAt: string) {
  const { id } = usePlaylistRunStore.getState().begin(spec)!
  usePlaylistRunStore.getState().succeed(id, { mode: 'spotify', preview: jazzPreview({ expiresAt }) })
  return id
}

function clearStoredReference() {
  sessionStorage.removeItem(STORAGE_KEY)
}

function savePhase() {
  const { run } = usePlaylistRunStore.getState()
  return run?.status.phase === 'succeeded' ? run.status.spotify?.save.phase : undefined
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  sessionStorage.clear()
  setAuthState(testUser)
})

afterEach(() => {
  usePlaylistRunStore.getState().discard()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useSpotifyPreviewLifecycle', () => {
  it('expires an unsaved preview at its expiry time without any request', () => {
    const { calls } = stubApi({})
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })

    act(() => {
      previewReady('2026-01-01T00:30:00.000Z')
    })
    act(() => {
      vi.advanceTimersByTime(29 * 60_000)
    })
    expect(savePhase()).toBe('idle')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(savePhase()).toBe('expired')
    expect(calls).toHaveLength(0)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('never expires a save in flight or a settled outcome', () => {
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    let id = 0
    act(() => {
      id = previewReady('2026-01-01T00:30:00.000Z')
      usePlaylistRunStore.getState().beginSave(id)
    })

    act(() => {
      vi.advanceTimersByTime(40 * 60_000)
    })
    expect(savePhase()).toBe('saving')

    act(() => {
      usePlaylistRunStore.getState().settleSave(id, publishedDestination)
      vi.advanceTimersByTime(40 * 60_000)
    })
    expect(savePhase()).toBe('settled')
  })

  it('writes the reference as the preview changes and clears it when the run is discarded', () => {
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })

    let id = 0
    act(() => {
      id = previewReady('2026-01-01T00:30:00.000Z')
    })
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toMatchObject({
      previewId: PREVIEW_ID,
      title: jazzPreview().playlist.name,
      coverOption: true,
    })

    act(() => usePlaylistRunStore.getState().setTitle(id, 'Edited'))
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toMatchObject({ title: 'Edited' })

    act(() => usePlaylistRunStore.getState().discard())
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('keeps the previous preview reference while a same-feature regeneration runs', () => {
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    act(() => {
      previewReady('2026-01-01T00:30:00.000Z')
      usePlaylistRunStore.getState().begin(spec)
    })

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toMatchObject({
      previewId: PREVIEW_ID,
    })
  })

  it('restores the stored preview once Spotify Mode is resolved, using only GET', async () => {
    const { calls } = stubApi({
      [`GET /api/previews/${PREVIEW_ID}`]: () => jsonResponse(previewState(null)),
    })
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        feature: 'mix',
        request: spec.request,
        previewId: PREVIEW_ID,
        expiresAt: '2026-01-01T00:20:00.000Z',
        title: 'Stored title',
        coverOption: false,
        saveAttempted: false,
      }),
    )

    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET /api/previews/${PREVIEW_ID}`,
    ])
    expect(usePlaylistRunStore.getState().run?.status).toMatchObject({
      spotify: { title: 'Stored title', coverOption: false },
    })
  })

  it('discards a reference from the previous storage version without any request', async () => {
    const { calls } = stubApi({})
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        feature: 'mix',
        request: spec.request,
        previewId: PREVIEW_ID,
        expiresAt: '2026-01-01T00:20:00.000Z',
        title: 'Stored title',
        coverOption: false,
      }),
    )

    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(calls).toHaveLength(0)
    expect(usePlaylistRunStore.getState().run).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('records the save attempt synchronously, before the request settles, and keeps it afterwards', () => {
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    let id = 0
    act(() => {
      id = previewReady('2026-01-01T00:30:00.000Z')
    })
    const read = () => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')
    expect(read()).toMatchObject({ version: 2, saveAttempted: false })

    act(() => {
      usePlaylistRunStore.getState().beginSave(id)
    })
    expect(read()).toMatchObject({ saveAttempted: true })

    act(() => {
      usePlaylistRunStore.getState().beginReconcile(id)
    })
    expect(read()).toMatchObject({ saveAttempted: true })

    act(() => {
      usePlaylistRunStore.getState().settleSave(id, publishedDestination)
    })
    expect(read()).toMatchObject({ saveAttempted: true })
  })

  it('stores only the minimal reference', () => {
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    act(() => {
      previewReady('2026-01-01T00:30:00.000Z')
    })

    expect(Object.keys(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).sort()).toEqual([
      'coverOption',
      'expiresAt',
      'feature',
      'previewId',
      'request',
      'saveAttempted',
      'title',
      'version',
    ])
  })

  it('restores a recorded attempt as possibly saved when the preview is gone', async () => {
    stubApi({
      [`GET /api/previews/${PREVIEW_ID}`]: () =>
        jsonResponse({ statusCode: 404, code: 'PREVIEW_NOT_FOUND', message: 'gone' }, 404),
    })
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        feature: 'mix',
        request: spec.request,
        previewId: PREVIEW_ID,
        expiresAt: '2025-12-31T23:00:00.000Z',
        title: 'Stored title',
        coverOption: false,
        saveAttempted: true,
      }),
    )

    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(usePlaylistRunStore.getState().run?.status).toMatchObject({
      spotify: { save: { phase: 'expired', mayHaveSaved: true } },
    })
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('ignores a restore that resolves after leaving Spotify Mode', async () => {
    let release!: (response: Response) => void
    stubApi({
      [`GET /api/previews/${PREVIEW_ID}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        feature: 'mix',
        request: spec.request,
        previewId: PREVIEW_ID,
        expiresAt: '2026-01-01T00:20:00.000Z',
        title: 'Stored title',
        coverOption: false,
        saveAttempted: false,
      }),
    )
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => setAuthState(null))
    await act(async () => {
      release(jsonResponse(previewState(null)))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(usePlaylistRunStore.getState().run).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('ignores a restore that resolves after the run was discarded on sign-out', async () => {
    let release!: (response: Response) => void
    stubApi({
      [`GET /api/previews/${PREVIEW_ID}`]: () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        feature: 'mix',
        request: spec.request,
        previewId: PREVIEW_ID,
        expiresAt: '2026-01-01T00:20:00.000Z',
        title: 'Stored title',
        coverOption: false,
        saveAttempted: false,
      }),
    )
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => {
      usePlaylistRunStore.getState().discard()
      clearStoredReference()
    })
    await act(async () => {
      release(jsonResponse(previewState(null)))
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(usePlaylistRunStore.getState().run).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('discards an invalid stored reference without any request', async () => {
    const { calls } = stubApi({})
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 99 }))

    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(calls).toHaveLength(0)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('drops the reference and the run when the listener is no longer in Spotify Mode', async () => {
    stubApi({})
    renderHook(() => useSpotifyPreviewLifecycle(), { wrapper })
    act(() => {
      previewReady('2026-01-01T00:30:00.000Z')
    })

    act(() => setAuthState(null))

    expect(usePlaylistRunStore.getState().run).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
