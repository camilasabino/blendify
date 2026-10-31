import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import App from '@/App'
import {
  cleanSyncResult,
  emptyLibraryPage,
  guestJazzPlaylist,
  jazzPreview,
  PREVIEW_ID,
  previewState,
  publishedDestination,
} from '@/test/playlist-fixtures'
import {
  jsonResponse,
  pendingNdjsonResponse,
  renderWithProviders,
  setAuthState,
  stubApi,
  testUser,
  type FetchCall,
  type PendingNdjsonStream,
} from '@/test/app-harness'
import { usePlaylistRunStore } from '@/stores/playlist-run-store'

vi.mock('@/lib/playlist-cover', () => ({
  renderPlaylistCoverBase64: vi.fn().mockResolvedValue('cover-data'),
}))

const matchingProgress = {
  type: 'progress',
  phase: 'matching_tracks',
  current: 21,
  total: 50,
  percent: 42,
}

const spotifyDiscoverPreview = jazzPreview({
  previewId: 'BBBBBBBBBBBBBBBBBBBBBB',
  playlist: {
    ...jazzPreview().playlist,
    name: 'Blendify · Discover · Sade',
    seeds: [{ type: 'artist', id: 'artist-1', name: 'Sade' }],
    generation: {
      version: 1,
      kind: 'discover_artist',
      targetTrackCount: 30,
      seed: { id: 'artist-1', name: 'Sade' },
      filters: { region: null, femaleVocals: false, releaseRange: null, excludeLive: false },
      popularity: 'balanced',
      orderMode: 'random',
    },
  },
})

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}</p>
}

function renderApp(route: string, options: { strict?: boolean } = {}) {
  return renderWithProviders(
    <>
      <App />
      <LocationProbe />
    </>,
    { route, ...options },
  )
}

function stubSpotifyApi(overrides: Parameters<typeof stubApi>[0] = {}) {
  const streams: PendingNdjsonStream[] = []
  const pendingStream = (_call: unknown, signal?: AbortSignal) => {
    const stream = pendingNdjsonResponse(signal)
    streams.push(stream)
    return stream.response
  }
  const api = stubApi({
    'GET /api/genres': () =>
      jsonResponse({ genres: [{ id: 'jazz', name: 'Jazz' }] }),
    'GET /api/artists/search': () =>
      jsonResponse({
        artists: [
          {
            id: 'artist-1',
            name: 'Sade',
            imageUrl: 'https://i.scdn.co/image/sade',
            externalUrl: 'https://open.spotify.com/artist/artist-1',
          },
        ],
      }),
    'POST /api/previews/mix': pendingStream,
    'POST /api/previews/discover': pendingStream,
    'GET /api/playlists': () => jsonResponse(emptyLibraryPage),
    'POST /api/playlists/sync': () => jsonResponse(cleanSyncResult),
    'GET /api/player/devices': () => jsonResponse({ devices: [] }),
    ...overrides,
  })
  return { ...api, streams }
}

function generationCalls(calls: FetchCall[]) {
  return calls.filter(
    (call) =>
      call.method === 'POST' &&
      (call.url === '/api/previews/mix' || call.url === '/api/previews/discover'),
  )
}

async function startJazzMix(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('radio', { name: 'Genres' }))
  await user.click(await screen.findByRole('button', { name: /Jazz/ }))
  await user.click(screen.getByRole('button', { name: 'Generate preview' }))
  await screen.findByText('Generating your preview')
}

async function startSadeDiscover(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByRole('combobox'), 'sade')
  await user.click(
    (await screen.findByRole('option', { name: 'Sade' })).firstElementChild!,
  )
  await user.click(screen.getByRole('button', { name: 'Generate preview' }))
  await screen.findByText('Generating your preview')
}

async function goTo(user: ReturnType<typeof userEvent.setup>, name: string) {
  const nav = screen.getAllByRole('navigation', { name: 'Main menu' })[0]
  await user.click(within(nav).getByRole('link', { name }))
}

function statusRegion() {
  return screen.getByRole('region', { name: 'Playlist creation' })
}

beforeEach(() => {
  setAuthState(testUser)
})

afterEach(() => {
  usePlaylistRunStore.getState().discard()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Spotify Mix generation across navigation', () => {
  it('stays visible in the shell, finishes once, and is restored when returning to Mix', async () => {
    const user = userEvent.setup()
    const { calls, streams } = stubSpotifyApi()
    const { queryClient } = renderApp('/app/mix')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await startJazzMix(user)
    streams[0].push(matchingProgress)
    await screen.findByText('42%')

    await goTo(user, 'Library')
    await screen.findByRole('heading', { name: 'Your Library' })

    const region = statusRegion()
    expect(within(region).getByText('Creating your Mix')).toBeVisible()
    expect(within(region).getByText(/Finding songs/)).toBeVisible()
    expect(within(region).getByText(/42%/)).toBeVisible()
    expect(
      within(region).getByRole('link', { name: 'View progress' }),
    ).toHaveAttribute('href', '/app/mix')
    expect(generationCalls(calls)).toHaveLength(1)

    streams[0].push({ type: 'result', playlist: jazzPreview() })
    streams[0].close()

    expect(await within(statusRegion()).findByText('Your Mix preview is ready · not saved')).toBeVisible()
    expect(invalidate).not.toHaveBeenCalled()

    await user.click(
      within(statusRegion()).getByRole('link', { name: 'View preview' }),
    )
    expect(screen.getByTestId('location')).toHaveTextContent('/app/mix')
    expect(
      await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()

    await goTo(user, 'Library')
    await goTo(user, 'Mix')

    expect(
      await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()
    expect(invalidate).not.toHaveBeenCalled()
    expect(generationCalls(calls)).toHaveLength(1)
  })

  it('restores progress and blocks a second submit when returning before completion', async () => {
    const user = userEvent.setup()
    const { calls, streams } = stubSpotifyApi()
    renderApp('/app/mix')

    await startJazzMix(user)
    streams[0].push(matchingProgress)
    await goTo(user, 'Stats')
    await goTo(user, 'Mix')

    expect(await screen.findByText('Generating your preview')).toBeVisible()
    expect(await screen.findByText('42%')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Generating…', hidden: true }),
    ).toBeDisabled()
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()
    expect(generationCalls(calls)).toHaveLength(1)

    streams[0].push({ type: 'result', playlist: jazzPreview() })
    streams[0].close()
    expect(
      await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
  })

  it('shows a failure raised after navigating away and retries from the stored request', async () => {
    const user = userEvent.setup()
    const { calls, streams } = stubSpotifyApi()
    renderApp('/app/mix')

    await startJazzMix(user)
    await goTo(user, 'Library')
    streams[0].push({
      type: 'error',
      statusCode: 502,
      code: 'CATALOG_UNAVAILABLE',
      message: 'Catalog unavailable',
    })
    streams[0].close()

    expect(
      await within(statusRegion()).findByText('Couldn’t create your Mix'),
    ).toBeVisible()

    await user.click(
      within(statusRegion()).getByRole('link', { name: 'View details' }),
    )
    expect(
      await screen.findByText('Couldn’t create the playlist'),
    ).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()
    expect(generationCalls(calls)).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(generationCalls(calls)).toHaveLength(2))
    expect(generationCalls(calls)[1].body).toEqual(generationCalls(calls)[0].body)
  })

  it('announces a terminal outcome once and does not replay it on remount', async () => {
    const user = userEvent.setup()
    const { streams } = stubSpotifyApi()
    renderApp('/app/mix')

    await startJazzMix(user)
    await goTo(user, 'Library')
    streams[0].push({ type: 'result', playlist: jazzPreview() })
    streams[0].close()
    await within(statusRegion()).findByText('Your Mix preview is ready · not saved')

    await goTo(user, 'Mix')
    await goTo(user, 'Stats')
    await goTo(user, 'Mix')
    await goTo(user, 'Library')

    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()
    expect(screen.queryByText('Your Mix preview is ready · not saved')).toBeNull()
  })
})

describe('Spotify generation lifecycle boundaries', () => {
  it('keeps the same single run under React StrictMode double mounting', async () => {
    const user = userEvent.setup()
    const { calls, streams } = stubSpotifyApi()
    renderApp('/app/mix', { strict: true })

    await startJazzMix(user)
    await goTo(user, 'Library')
    expect(
      within(statusRegion()).getByText('Creating your Mix'),
    ).toBeVisible()

    streams[0].push({ type: 'result', playlist: jazzPreview() })
    streams[0].close()
    await within(statusRegion()).findByText('Your Mix preview is ready · not saved')
    await goTo(user, 'Mix')

    expect(
      await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(generationCalls(calls)).toHaveLength(1)
  })

  it('aborts the run and clears the shell status when the account is deleted', async () => {
    const user = userEvent.setup()
    const { streams } = stubSpotifyApi({
      'DELETE /api/account': () => jsonResponse({ ok: true }),
    })
    renderApp('/app/mix')

    await startJazzMix(user)
    await goTo(user, 'Library')
    expect(
      await screen.findByRole('region', { name: 'Playlist creation' }),
    ).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Account menu: Camila' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete account' }))
    await user.click(await screen.findByRole('button', { name: 'Delete my account' }))

    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull(),
    )
    expect(streams[0].signal?.aborted).toBe(true)
    expect(usePlaylistRunStore.getState().run).toBeNull()
  })

  it('drops the run on logout so nothing survives into the next session', async () => {
    const user = userEvent.setup()
    const { streams } = stubSpotifyApi({
      'POST /api/auth/logout': () => jsonResponse({ ok: true }),
    })
    renderApp('/app/mix')

    await startJazzMix(user)
    await goTo(user, 'Discover')
    expect(
      await screen.findByRole('region', { name: 'Playlist creation' }),
    ).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Account menu: Camila' }))
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    await screen.findByRole('heading', { name: 'What do you want to create?' })
    expect(streams[0].signal?.aborted).toBe(true)
    expect(usePlaylistRunStore.getState().run).toBeNull()
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()
  })
})

describe('Spotify Discover generation across navigation', () => {
  it('stays visible in the shell and its result is restored on Discover', async () => {
    const user = userEvent.setup()
    const { calls, streams } = stubSpotifyApi()
    const { queryClient } = renderApp('/app/discover')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await startSadeDiscover(user)
    streams[0].push(matchingProgress)
    await goTo(user, 'Library')

    expect(
      within(statusRegion()).getByText('Creating your Discover playlist'),
    ).toBeVisible()
    expect(
      within(statusRegion()).getByRole('link', { name: 'View progress' }),
    ).toHaveAttribute('href', '/app/discover')

    streams[0].push({ type: 'result', playlist: spotifyDiscoverPreview })
    streams[0].close()
    await within(statusRegion()).findByText('Your Discover preview is ready · not saved')
    expect(invalidate).not.toHaveBeenCalled()

    await goTo(user, 'Discover')
    expect(
      await screen.findByRole('heading', { name: 'Blendify · Discover · Sade' }),
    ).toBeVisible()
    expect(generationCalls(calls)).toHaveLength(1)
  })

  it('does not let another feature start or abort a run that is already active', async () => {
    const user = userEvent.setup()
    const { calls, streams } = stubSpotifyApi()
    renderApp('/app/mix')

    await startJazzMix(user)
    await goTo(user, 'Discover')

    await user.type(await screen.findByRole('combobox'), 'sade')
    await user.click(
      (await screen.findByRole('option', { name: 'Sade' })).firstElementChild!,
    )
    expect(screen.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
    expect(
      screen.getByText('Wait for your Mix to finish before creating another playlist.'),
    ).toBeVisible()
    expect(streams[0].signal?.aborted).toBe(false)
    expect(generationCalls(calls)).toHaveLength(1)
  })
})

describe('Guest generation across navigation', () => {
  function stubGuestApi() {
    const { streams, ...api } = stubSpotifyApi({
      'GET /api/auth/me': () => jsonResponse({ user: null }),
      'POST /api/generate/mix': (_call, signal) => {
        const stream = pendingNdjsonResponse(signal)
        streams.push(stream)
        return stream.response
      },
    })
    return { ...api, streams }
  }

  async function startGuestJazzMix(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('radio', { name: 'Genres' }))
    await user.click(await screen.findByRole('button', { name: /Jazz/ }))
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))
    await screen.findByText('Generating your playlist')
  }

  function leaveDialog() {
    return screen.getByRole('dialog', {
      name: 'Leave while your playlist is being generated?',
    })
  }

  beforeEach(() => {
    setAuthState(null)
  })

  it('asks before leaving an active generation and keeps it when the listener stays', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderApp('/app/mix')
    await startGuestJazzMix(user)

    await goTo(user, 'Discover')

    expect(leaveDialog()).toBeVisible()
    expect(screen.getByTestId('location')).toHaveTextContent('/app/mix')
    await user.click(screen.getByRole('button', { name: 'Stay on this page' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/app/mix')
    expect(screen.getByText('Generating your playlist')).toBeInTheDocument()
    expect(streams[0].signal?.aborted).toBe(false)
  })

  it('stops the generation only after the listener confirms leaving', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    renderApp('/app/mix')
    await startGuestJazzMix(user)

    await goTo(user, 'Discover')
    await user.click(screen.getByRole('button', { name: 'Leave' }))

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/app/discover'),
    )
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()
    expect(streams[0].signal?.aborted).toBe(true)

    await goTo(user, 'Mix')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Generating your playlist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Generate playlist' })).toBeInTheDocument()
  })

  it('also asks before a browser back navigation', async () => {
    const user = userEvent.setup()
    const { streams } = stubGuestApi()
    const { router } = renderWithProviders(
      <>
        <App />
        <LocationProbe />
      </>,
      { route: '/app' },
    )
    await act(() => router.navigate('/app/mix'))
    await startGuestJazzMix(user)

    await act(() => router.navigate(-1))

    expect(leaveDialog()).toBeVisible()
    expect(screen.getByTestId('location')).toHaveTextContent('/app/mix')
    await user.click(screen.getByRole('button', { name: 'Stay on this page' }))
    expect(streams[0].signal?.aborted).toBe(false)
  })

  it('keeps a finished result across in-app navigation without asking or generating again', async () => {
    const user = userEvent.setup()
    const { streams, calls } = stubGuestApi()
    renderApp('/app/mix')
    await startGuestJazzMix(user)
    streams[0].push({ type: 'result', playlist: guestJazzPlaylist })
    streams[0].close()
    await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })

    await goTo(user, 'Discover')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/app/discover')
    expect(screen.queryByRole('region', { name: 'Playlist creation' })).toBeNull()

    await goTo(user, 'Mix')
    expect(
      await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(
      calls.filter((call) => call.url === '/api/generate/mix'),
    ).toHaveLength(1)
  })

  it('does not ask before leaving while a Spotify run continues in the shell', async () => {
    setAuthState(testUser)
    const user = userEvent.setup()
    stubSpotifyApi()
    renderApp('/app/mix')
    await startJazzMix(user)

    await goTo(user, 'Library')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/app/library')
  })
})

describe('Spotify preview save across navigation and reloads', () => {
  const STORAGE_KEY = 'blendify.spotifyPreview'
  const SAVE_ROUTE = `POST /api/previews/${PREVIEW_ID}/save`
  const STATE_ROUTE = `GET /api/previews/${PREVIEW_ID}`

  function deferred() {
    let resolve: (response: Response) => void = () => {}
    const promise = new Promise<Response>((done) => {
      resolve = done
    })
    return { promise, resolve }
  }

  async function reachMixPreview(
    user: ReturnType<typeof userEvent.setup>,
    api: ReturnType<typeof stubSpotifyApi>,
  ) {
    await startJazzMix(user)
    api.streams[0].push({ type: 'result', playlist: jazzPreview() })
    api.streams[0].close()
    await screen.findByText('Preview · not saved yet')
  }

  function warnsBeforeUnload() {
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  beforeEach(() => {
    sessionStorage.clear()
  })

  it('keeps a save running while the listener navigates and reports the outcome in the shell', async () => {
    const user = userEvent.setup()
    const save = deferred()
    const api = stubSpotifyApi({ [SAVE_ROUTE]: () => save.promise })
    const { queryClient } = renderApp('/app/mix')
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await reachMixPreview(user, api)

    await user.click(screen.getByRole('button', { name: 'Save to Spotify' }))
    expect(warnsBeforeUnload()).toBe(true)
    await goTo(user, 'Library')

    expect(
      await within(statusRegion()).findByText('Saving your Mix to Spotify'),
    ).toBeVisible()
    save.resolve(jsonResponse(previewState(publishedDestination)))
    expect(
      await within(statusRegion()).findByText('Your Mix is saved to Spotify'),
    ).toBeVisible()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['usage-stats'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['playlists'] })

    await goTo(user, 'Mix')
    expect(await screen.findByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(api.calls.filter((call) => call.url.endsWith('/save'))).toHaveLength(1)
    expect(warnsBeforeUnload()).toBe(false)
  })

  it('blocks any new generation while a save is in flight', async () => {
    const user = userEvent.setup()
    const save = deferred()
    const api = stubSpotifyApi({ [SAVE_ROUTE]: () => save.promise })
    renderApp('/app/mix')
    await reachMixPreview(user, api)
    await user.click(screen.getByRole('button', { name: 'Save to Spotify' }))

    await goTo(user, 'Discover')
    await user.type(await screen.findByRole('combobox'), 'sade')
    await user.click(
      (await screen.findByRole('option', { name: 'Sade' })).firstElementChild!,
    )

    expect(screen.getByRole('button', { name: 'Generate preview' })).toBeDisabled()
    expect(
      screen.getByText('Wait for your Mix to finish before creating another playlist.'),
    ).toBeVisible()
    expect(generationCalls(api.calls)).toHaveLength(1)
    save.resolve(jsonResponse(previewState(publishedDestination)))
  })

  it('stores only a reference to the preview, never its tracks or any credential', async () => {
    const user = userEvent.setup()
    const api = stubSpotifyApi()
    renderApp('/app/mix')
    await reachMixPreview(user, api)

    const stored = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')
    expect(Object.keys(stored).sort()).toEqual([
      'coverOption',
      'expiresAt',
      'feature',
      'previewId',
      'request',
      'saveAttempted',
      'title',
      'version',
    ])
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toContain('So What')
  })

  it('restores an unsaved preview after a reload with its title draft, then saves it once', async () => {
    const user = userEvent.setup()
    const first = stubSpotifyApi()
    const view = renderApp('/app/mix')
    await reachMixPreview(user, first)
    await user.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByRole('textbox', { name: 'Playlist title' })
    await user.clear(input)
    await user.type(input, 'After reload')
    await user.click(screen.getByRole('button', { name: 'Done' }))
    view.unmount()
    usePlaylistRunStore.getState().discard()
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}'), title: 'After reload' }),
    )

    const second = stubSpotifyApi({
      [STATE_ROUTE]: () => jsonResponse(previewState(null)),
      [SAVE_ROUTE]: () => jsonResponse(previewState(publishedDestination)),
    })
    renderApp('/app/mix')

    expect(await screen.findByRole('heading', { name: 'After reload' })).toBeVisible()
    expect(generationCalls(second.calls)).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Save to Spotify' }))
    await screen.findByRole('heading', { name: 'Saved to Spotify' })
    const saves = second.calls.filter((call) => call.url.endsWith('/save'))
    expect(saves).toHaveLength(1)
    expect(saves[0].body).toMatchObject({ name: 'After reload' })
  })

  it('reconciles a publication that was running when the page reloaded without posting again', async () => {
    const user = userEvent.setup()
    const first = stubSpotifyApi()
    const view = renderApp('/app/mix')
    await reachMixPreview(user, first)
    view.unmount()
    usePlaylistRunStore.getState().discard()

    let reads = 0
    const second = stubSpotifyApi({
      [STATE_ROUTE]: () => {
        reads += 1
        return jsonResponse(
          previewState(reads === 1 ? { status: 'publishing' } : publishedDestination),
        )
      },
    })
    renderApp('/app/mix')

    expect(
      (await screen.findAllByText('Confirming whether the playlist was saved to Spotify…'))
        .length,
    ).toBeGreaterThan(0)
    expect(await screen.findByRole('heading', { name: 'Saved to Spotify' }, { timeout: 4_000 })).toBeVisible()
    expect(second.calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })

  it('shows the retained outcome after a reload even though the preview content expired', async () => {
    const user = userEvent.setup()
    const first = stubSpotifyApi()
    const view = renderApp('/app/mix')
    await reachMixPreview(user, first)
    view.unmount()
    usePlaylistRunStore.getState().discard()

    stubSpotifyApi({
      [STATE_ROUTE]: () =>
        jsonResponse(previewState(publishedDestination, { playlist: null })),
    })
    renderApp('/app/mix')

    expect(await screen.findByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(screen.getByRole('link', { name: /Open in Spotify/ })).toBeVisible()
    expect(screen.queryByRole('list', { name: 'Songs in this playlist' })).toBeNull()
  })

  it('warns that a save may have happened when a reload finds the preview gone after a recorded attempt', async () => {
    const user = userEvent.setup()
    const first = stubSpotifyApi()
    const view = renderApp('/app/mix')
    await reachMixPreview(user, first)
    view.unmount()
    usePlaylistRunStore.getState().discard()
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}'),
        expiresAt: '2020-01-01T00:00:00.000Z',
        saveAttempted: true,
      }),
    )

    stubSpotifyApi({
      [STATE_ROUTE]: () =>
        jsonResponse({ statusCode: 404, code: 'PREVIEW_NOT_FOUND', message: 'gone' }, 404),
    })
    renderApp('/app/mix')

    expect(
      await screen.findByRole('heading', { name: 'This preview is no longer available' }),
    ).toBeVisible()
    expect(screen.getAllByText(/check your playlists in Spotify/).length).toBeGreaterThan(0)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('clears the reference and the preview when the listener logs out', async () => {
    const user = userEvent.setup()
    const api = stubSpotifyApi({ 'POST /api/auth/logout': () => jsonResponse({ ok: true }) })
    renderApp('/app/mix')
    await reachMixPreview(user, api)

    await user.click(screen.getByRole('button', { name: 'Account menu: Camila' }))
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

    await screen.findByRole('heading', { name: 'What do you want to create?' })
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(usePlaylistRunStore.getState().run).toBeNull()
  })

  it('asks before another feature replaces an unsaved preview and keeps it when cancelled', async () => {
    const user = userEvent.setup()
    const api = stubSpotifyApi()
    renderApp('/app/mix')
    await reachMixPreview(user, api)

    await goTo(user, 'Discover')
    await user.type(await screen.findByRole('combobox'), 'sade')
    await user.click(
      (await screen.findByRole('option', { name: 'Sade' })).firstElementChild!,
    )
    await user.click(screen.getByRole('button', { name: 'Generate preview' }))
    const dialog = await screen.findByRole('dialog', {
      name: 'Replace the unsaved preview?',
    })
    expect(dialog).toBeVisible()
    expect(generationCalls(api.calls)).toHaveLength(1)

    await user.click(within(dialog).getByRole('button', { name: 'Keep preview' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(generationCalls(api.calls)).toHaveLength(1)
    await goTo(user, 'Mix')
    expect(await screen.findByText('Preview · not saved yet')).toBeVisible()
  })

  it('replaces the unsaved preview once the other feature is confirmed', async () => {
    const user = userEvent.setup()
    const api = stubSpotifyApi()
    renderApp('/app/mix')
    await reachMixPreview(user, api)

    await goTo(user, 'Discover')
    await user.type(await screen.findByRole('combobox'), 'sade')
    await user.click(
      (await screen.findByRole('option', { name: 'Sade' })).firstElementChild!,
    )
    await user.click(screen.getByRole('button', { name: 'Generate preview' }))
    await user.click(
      await screen.findByRole('button', { name: 'Replace preview' }),
    )

    await screen.findByText('Generating your preview')
    expect(generationCalls(api.calls)).toHaveLength(2)
    expect(usePlaylistRunStore.getState().run?.spec.feature).toBe('discover')
  })

  it('does not ask when navigating between pages with an unsaved preview', async () => {
    const user = userEvent.setup()
    const api = stubSpotifyApi()
    renderApp('/app/mix')
    await reachMixPreview(user, api)

    await goTo(user, 'Library')
    await goTo(user, 'Stats')
    await goTo(user, 'Mix')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Preview · not saved yet')).toBeVisible()
  })

  it('keeps the previous preview when a same-feature regeneration fails', async () => {
    const user = userEvent.setup()
    const api = stubSpotifyApi()
    renderApp('/app/mix')
    await reachMixPreview(user, api)

    await user.click(screen.getByRole('button', { name: 'Try different settings' }))
    await user.click(screen.getByRole('button', { name: 'Generate new preview' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await screen.findByText('Generating your preview')
    api.streams[1].push({
      type: 'error',
      statusCode: 502,
      code: 'CATALOG_UNAVAILABLE',
      message: 'Catalog unavailable',
    })
    api.streams[1].close()

    expect(await screen.findByText('Preview · not saved yet')).toBeVisible()
    expect(
      screen.getByText('Couldn’t generate a new preview. This one is still available.'),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeEnabled()
  })
})
