import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { emptySelectionFilters, type GeneratedPlaylistDto } from '@blendify/contracts'
import App from '@/App'
import { guestJazzPlaylist } from '@/test/playlist-fixtures'
import {
  jsonResponse,
  ndjsonResponse,
  pendingNdjsonResponse,
  renderWithProviders,
  setAuthState,
  stubApi,
  testUser,
  type FetchCall,
  type PendingNdjsonStream,
} from '@/test/app-harness'
import { usePlaylistRunStore } from '@/stores/playlist-run-store'

const STORAGE_KEY = 'blendify.guestResult'
const SOUNDIIZ_URL = 'https://soundiiz.com/go/import-playlist/abcdefghijklmnop'

const jazzRequest = {
  kind: 'genre_mix',
  name: 'Blendify · Mix · Jazz',
  description: 'Jazz, blended.',
  genreIds: ['jazz'],
  filters: {},
  popularity: 'balanced',
  tracksPerSeed: 25,
  orderMode: 'random',
}

const playlistWithTransfer: GeneratedPlaylistDto = {
  ...guestJazzPlaylist,
  transfer: { token: 'signed-token', expiresAt: '2099-01-01T00:00:00.000Z' },
}

const discoverPlaylist: GeneratedPlaylistDto = {
  ...guestJazzPlaylist,
  name: 'Blendify · Discover · Sade',
  generation: {
    version: 1,
    kind: 'discover_artist',
    targetTrackCount: 30,
    seed: { id: 'artist-1', name: 'Sade' },
    filters: emptySelectionFilters(),
    popularity: 'balanced',
    orderMode: 'random',
  },
  seeds: [{ type: 'artist', id: 'artist-1', name: 'Sade' }],
}

function storeGuestResult(value: unknown) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value))
}

function storedMixResult(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    feature: 'mix',
    request: jazzRequest,
    playlist: playlistWithTransfer,
    transfer: null,
    ...overrides,
  }
}

function stubGuestApi(overrides: Parameters<typeof stubApi>[0] = {}) {
  const streams: PendingNdjsonStream[] = []
  const api = stubApi({
    'GET /api/auth/me': () => jsonResponse({ user: null }),
    'GET /api/genres': () =>
      jsonResponse({ genres: [{ id: 'jazz', name: 'Jazz' }] }),
    'POST /api/generate/mix': (_call, signal) => {
      const stream = pendingNdjsonResponse(signal)
      streams.push(stream)
      return stream.response
    },
    ...overrides,
  })
  return { ...api, streams }
}

function generationCalls(calls: FetchCall[]) {
  return calls.filter(
    (call) =>
      call.method === 'POST' &&
      (call.url === '/api/generate/mix' || call.url === '/api/generate/discover'),
  )
}

async function generateGuestJazzMix(
  user: ReturnType<typeof userEvent.setup>,
  streams: PendingNdjsonStream[],
  playlist: GeneratedPlaylistDto = playlistWithTransfer,
) {
  await user.click(await screen.findByRole('radio', { name: 'Genres' }))
  await user.click(await screen.findByRole('button', { name: /Jazz/ }))
  await user.click(screen.getByRole('button', { name: 'Generate playlist' }))
  await screen.findByText('Generating your playlist')
  const stream = streams.at(-1)!
  stream.push({ type: 'result', playlist })
  stream.close()
  await screen.findByRole('heading', { name: playlist.name })
}

function warnsBeforeUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function reload(route: string) {
  usePlaylistRunStore.getState().discard()
  return renderWithProviders(<App />, { route })
}

beforeEach(() => {
  setAuthState(null)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Guest result persistence', () => {
  it('stores only the finished playlist, its settings and transfer state', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderWithProviders(<App />, { route: '/app/mix' })

    await generateGuestJazzMix(user, streams)

    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')
    expect(Object.keys(stored).sort()).toEqual([
      'feature',
      'playlist',
      'request',
      'transfer',
      'version',
    ])
    expect(stored).toMatchObject({
      version: 1,
      feature: 'mix',
      request: { kind: 'genre_mix', genreIds: ['jazz'] },
      playlist: playlistWithTransfer,
      transfer: null,
    })
    expect(stored.request).not.toHaveProperty('persistToLibrary')
    expect(stored.request).not.toHaveProperty('coverImageBase64')
    expect(JSON.stringify(stored)).not.toMatch(/user-1|Camila|session|cookie/i)
  })

  it('restores the result after a reload without generating again', async () => {
    const user = userEvent.setup()
    const { streams, calls } = stubGuestApi()
    const first = renderWithProviders(<App />, { route: '/app/mix' })
    await generateGuestJazzMix(user, streams)
    first.unmount()

    reload('/app/mix')

    expect(
      await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(screen.getByText('Playlist generated')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Prepare transfer' }),
    ).toBeVisible()
    expect(generationCalls(calls)).toHaveLength(1)
  })

  it('restores a Discover result only on Discover', async () => {
    stubGuestApi()
    storeGuestResult({
      version: 1,
      feature: 'discover',
      request: {
        kind: 'discover_artist',
        artistId: 'artist-1',
        artist: { id: 'artist-1', name: 'Sade', imageUrl: null },
        name: 'Blendify · Discover · Sade',
        description: '',
        targetTrackCount: 30,
        popularity: 'balanced',
        orderMode: 'random',
      },
      playlist: discoverPlaylist,
      transfer: null,
    })

    const mix = renderWithProviders(<App />, { route: '/app/mix' })
    expect(
      await screen.findByRole('button', { name: 'Generate playlist' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Blendify · Discover · Sade' }),
    ).toBeNull()
    mix.unmount()

    renderWithProviders(<App />, { route: '/app/discover' })
    expect(
      await screen.findByRole('heading', { name: 'Blendify · Discover · Sade' }),
    ).toBeVisible()
  })

  it('keeps a prepared Soundiiz transfer across a reload without preparing it again', async () => {
    const user = userEvent.setup()
    const { streams, calls } = stubGuestApi({
      'POST /api/transfers': () =>
        jsonResponse({
          url: SOUNDIIZ_URL,
          expiresAt: '2099-01-01T00:00:00.000Z',
          trackCount: 1,
        }),
    })
    const first = renderWithProviders(<App />, { route: '/app/mix' })
    await generateGuestJazzMix(user, streams)
    await user.click(screen.getByRole('button', { name: 'Prepare transfer' }))
    await screen.findByRole('link', { name: /Continue on Soundiiz/ })
    first.unmount()

    reload('/app/mix')

    expect(
      await screen.findByRole('link', { name: /Continue on Soundiiz/ }),
    ).toHaveAttribute('href', SOUNDIIZ_URL)
    expect(screen.queryByRole('button', { name: 'Prepare transfer' })).toBeNull()
    expect(calls.filter((call) => call.url === '/api/transfers')).toHaveLength(1)
  })

  it('clears the stored result when the listener starts a new playlist', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderWithProviders(<App />, { route: '/app/mix' })
    await generateGuestJazzMix(user, streams)

    await user.click(screen.getByRole('button', { name: 'Create another' }))

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('replaces the stored result as soon as a new generation starts', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderWithProviders(<App />, { route: '/app/mix' })
    await generateGuestJazzMix(user, streams)

    await user.click(screen.getByRole('button', { name: /Show settings/ }))
    await user.click(screen.getByRole('button', { name: 'Generate new playlist' }))
    await screen.findByText('Generating your playlist')

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('never restores a Guest result in Spotify Mode and removes it', async () => {
    setAuthState(testUser)
    stubApi({
      'GET /api/auth/me': () => jsonResponse({ user: testUser }),
      'GET /api/genres': () => jsonResponse({ genres: [] }),
      'GET /api/player/devices': () => jsonResponse({ devices: [] }),
    })
    storeGuestResult(storedMixResult())

    renderWithProviders(<App />, { route: '/app/mix' })

    expect(
      await screen.findByRole('button', { name: 'Create playlist' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeNull()
    await waitFor(() => expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull())
  })

  it.each([
    ['corrupted JSON', '{"version":1,'],
    ['an older schema version', JSON.stringify(storedMixResult({ version: 0 }))],
    ['an unknown feature', JSON.stringify(storedMixResult({ feature: 'ai' }))],
    [
      'an invalid playlist',
      JSON.stringify(storedMixResult({ playlist: { name: 'Broken' } })),
    ],
    [
      'unexpected extra fields',
      JSON.stringify(storedMixResult({ accessKey: 'secret' })),
    ],
  ])('discards %s and shows an empty form', async (_case, raw) => {
    const { calls } = stubGuestApi()
    sessionStorage.setItem(STORAGE_KEY, raw)

    renderWithProviders(<App />, { route: '/app/mix' })

    expect(
      await screen.findByRole('button', { name: 'Generate playlist' }),
    ).toBeVisible()
    await waitFor(() => expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull())
    expect(generationCalls(calls)).toHaveLength(0)
  })

  it('keeps working when the browser blocks session storage', async () => {
    const user = userEvent.setup()
    const blocked = () => {
      throw new DOMException('Blocked', 'SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked)
    const { streams } = stubGuestApi()
    renderWithProviders(<App />, { route: '/app/mix' })

    await generateGuestJazzMix(user, streams)

    expect(screen.getByText('Playlist generated')).toBeVisible()
  })
})

describe('Guest leave protection', () => {
  it('warns before unloading during a generation and not once the result is stored', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderWithProviders(<App />, { route: '/app/mix' })

    expect(warnsBeforeUnload()).toBe(false)
    await user.click(await screen.findByRole('radio', { name: 'Genres' }))
    await user.click(await screen.findByRole('button', { name: /Jazz/ }))
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))
    await screen.findByText('Generating your playlist')
    expect(warnsBeforeUnload()).toBe(true)

    streams[0].push({ type: 'result', playlist: playlistWithTransfer })
    streams[0].close()
    await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })

    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
    expect(warnsBeforeUnload()).toBe(false)
  })

  it('warns before unloading a finished result that could not be stored', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderWithProviders(<App />, { route: '/app/mix' })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })

    await generateGuestJazzMix(user, streams)

    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(warnsBeforeUnload()).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Create another' }))
    expect(warnsBeforeUnload()).toBe(false)
  })

  it('warns before unloading while a Soundiiz transfer is being prepared', async () => {
    const user = userEvent.setup()
    let finishTransfer: () => void = () => {}
    const { streams } = stubGuestApi({
      'POST /api/transfers': () =>
        new Promise((resolve) => {
          finishTransfer = () =>
            resolve(
              jsonResponse({
                url: SOUNDIIZ_URL,
                expiresAt: '2099-01-01T00:00:00.000Z',
                trackCount: 1,
              }),
            )
        }),
    })
    renderWithProviders(<App />, { route: '/app/mix' })
    await generateGuestJazzMix(user, streams)

    await user.click(screen.getByRole('button', { name: 'Prepare transfer' }))
    await screen.findByText('Preparing transfer…')
    expect(warnsBeforeUnload()).toBe(true)

    finishTransfer()
    await screen.findByRole('link', { name: /Continue on Soundiiz/ })
    await waitFor(() => expect(warnsBeforeUnload()).toBe(false))
  })

  it('warns before unloading during a Spotify generation', async () => {
    setAuthState(testUser)
    const user = userEvent.setup()
    stubApi({
      'GET /api/auth/me': () => jsonResponse({ user: testUser }),
      'GET /api/genres': () =>
        jsonResponse({ genres: [{ id: 'jazz', name: 'Jazz' }] }),
      'GET /api/player/devices': () => jsonResponse({ devices: [] }),
      'POST /api/playlists/mix': (_call, signal) =>
        pendingNdjsonResponse(signal).response,
    })
    renderWithProviders(<App />, { route: '/app/mix' })

    await user.click(await screen.findByRole('radio', { name: 'Genres' }))
    await user.click(await screen.findByRole('button', { name: /Jazz/ }))
    await user.click(screen.getByRole('button', { name: 'Create playlist' }))
    await screen.findByText('Creating your playlist')

    expect(warnsBeforeUnload()).toBe(true)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('does not warn for a restored result', async () => {
    stubGuestApi({
      'POST /api/generate/mix': () =>
        ndjsonResponse({ type: 'result', playlist: guestJazzPlaylist }),
    })
    storeGuestResult(storedMixResult())

    renderWithProviders(<App />, { route: '/app/mix' })
    await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })

    expect(warnsBeforeUnload()).toBe(false)
  })
})
