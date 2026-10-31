import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscoverPlaylistForm } from '@/components/playlist/discover-playlist-form'
import { renderPlaylistCoverBase64 } from '@/lib/playlist-cover'
import { usePlaylistRunStore } from '@/stores/playlist-run-store'
import {
  jsonResponse,
  ndjsonResponse,
  renderWithProviders,
  setAuthState,
  stubApi,
  testUser,
} from '@/test/app-harness'
import {
  guestJazzPlaylist,
  jazzPreview,
  PREVIEW_ID,
  previewState,
  publishedDestination,
} from '@/test/playlist-fixtures'

vi.mock('@/lib/playlist-cover', () => ({
  renderPlaylistCoverBase64: vi.fn().mockResolvedValue('cover-data'),
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const sadeSearch = () =>
  jsonResponse({
    artists: [
      {
        id: 'artist-1',
        name: 'Sade',
        imageUrl: 'https://i.scdn.co/image/sade',
        externalUrl: 'https://open.spotify.com/artist/artist-1',
      },
    ],
  })

async function pickSade(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('combobox'), 'sade')
  await user.click(
    (await screen.findByRole('option', { name: 'Sade' })).firstElementChild!,
  )
}

describe('DiscoverPlaylistForm Spotify preview', () => {
  beforeEach(() => {
    usePlaylistRunStore.getState().discard()
    vi.mocked(renderPlaylistCoverBase64).mockClear()
  })

  it('generates a preview without saving, then saves once with a cover that never uses the seed artwork', async () => {
    setAuthState(testUser)
    const { calls } = stubApi({
      'GET /api/artists/search': sadeSearch,
      'POST /api/previews/discover': () =>
        ndjsonResponse({ type: 'result', playlist: jazzPreview() }),
      [`POST /api/previews/${PREVIEW_ID}/save`]: () =>
        jsonResponse(previewState(publishedDestination)),
      'GET /api/player/devices': () => jsonResponse({ devices: [] }),
    })
    const user = userEvent.setup()
    renderWithProviders(<DiscoverPlaylistForm />, { route: '/app/discover' })

    expect(screen.queryByText('Add a cover image')).not.toBeInTheDocument()
    await pickSade(user)
    await user.click(screen.getByRole('button', { name: 'Generate preview' }))
    await screen.findByText('Preview · not saved yet')

    const generation = calls.find((call) => call.url === '/api/previews/discover')
    expect(generation?.body).toMatchObject({ kind: 'discover_artist' })
    expect(generation?.body).not.toHaveProperty('coverImageBase64')
    expect(generation?.body).not.toHaveProperty('persistToLibrary')
    expect(calls.some((call) => call.url.endsWith('/save'))).toBe(false)
    expect(renderPlaylistCoverBase64).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Save to Spotify' }))
    await screen.findByRole('heading', { name: 'Saved to Spotify' })

    expect(renderPlaylistCoverBase64).toHaveBeenCalledTimes(1)
    const [input] = vi.mocked(renderPlaylistCoverBase64).mock.calls[0]
    expect(input).toEqual({ title: expect.any(String), kind: 'discover' })
    expect(JSON.stringify(input)).not.toContain('i.scdn.co')
    const saves = calls.filter((call) => call.url.endsWith('/save'))
    expect(saves).toHaveLength(1)
    expect(saves[0].body).toMatchObject({ coverImageBase64: 'cover-data', persistToLibrary: true })
  })

  it('keeps the seed and offers a plain retry after an interrupted generation', async () => {
    setAuthState(testUser)
    let attempts = 0
    const { calls } = stubApi({
      'GET /api/artists/search': sadeSearch,
      'POST /api/previews/discover': () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new TypeError('network error'))
          : ndjsonResponse({ type: 'result', playlist: jazzPreview() })
      },
      'GET /api/player/devices': () => jsonResponse({ devices: [] }),
    })
    const user = userEvent.setup()
    renderWithProviders(<DiscoverPlaylistForm />, { route: '/app/discover' })

    await pickSade(user)
    await user.click(screen.getByRole('button', { name: 'Generate preview' }))
    await screen.findByRole('button', { name: 'Try again' })

    expect(screen.getByText('Sade')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Preview · not saved yet')

    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[1].body).toEqual(posts[0].body)
  })
})

describe('DiscoverPlaylistForm region filter', () => {
  beforeEach(() => {
    usePlaylistRunStore.getState().discard()
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T12:00:00Z') })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const stay = {
    id: 'stay',
    name: 'Stay',
    artistId: 'sade',
    artistName: 'Sade',
    albumImageUrl: null,
    durationMs: 180_000,
    popularity: 40,
    uri: 'spotify:track:stay',
  }

  const regionalDiscovery = {
    ...guestJazzPlaylist,
    generation: {
      version: 1,
      kind: 'discover_artist',
      targetTrackCount: 10,
      seed: { id: 'artist-1', name: 'Sade' },
      filters: { region: 'argentina' },
      popularity: 'balanced',
      orderMode: 'random',
    },
  }

  it('refines discovered results by region for both artist and song seeds', async () => {
    setAuthState(null)
    const { calls } = stubApi({
      'GET /api/artists/search': () =>
        jsonResponse({ artists: [{ id: 'artist-1', name: 'Sade' }] }),
      'GET /api/tracks/search': () => jsonResponse({ tracks: [stay] }),
      'POST /api/generate/discover': () =>
        ndjsonResponse({ type: 'result', playlist: regionalDiscovery }),
    })
    const user = userEvent.setup()
    renderWithProviders(<DiscoverPlaylistForm />, { route: '/app/discover' })

    const toggle = screen.getByRole('button', { name: 'Refine results' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /Region/ })).toBeNull()
    await user.click(toggle)
    const section = screen
      .getByRole('heading', { name: 'Refine results' })
      .closest('section')!
    const region = screen.getByRole('button', { name: /Region/ })
    expect(section).toContainElement(region)
    expect(region).toHaveTextContent('Any region')
    expect(region).toHaveAccessibleDescription(
      'Optional · Limits results to a scene or region.',
    )
    await user.click(region)
    await user.click(await screen.findByRole('option', { name: 'Argentina' }))
    expect(region).toHaveTextContent('Argentina')

    await user.type(screen.getByRole('combobox', { name: 'Artist' }), 'sade')
    await user.click(
      (await screen.findByRole('option', { name: /Sade/ }, { timeout: 3_000 }))
        .firstElementChild!,
    )
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))
    await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })
    expect(screen.getByText(/^Sade · Argentina · /)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try different settings' }))
    expect(screen.getByRole('button', { name: 'Refine results' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await user.click(screen.getByRole('radio', { name: 'Song' }))
    expect(screen.getByRole('button', { name: /Region/ })).toHaveTextContent(
      'Argentina',
    )
    await user.type(screen.getByRole('combobox', { name: 'Song' }), 'stay')
    await user.click(
      (await screen.findByRole('option', { name: /Stay/ }, { timeout: 3_000 }))
        .firstElementChild!,
    )
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))

    await vi.waitFor(() => {
      expect(
        calls.filter((call) => call.url === '/api/generate/discover'),
      ).toHaveLength(2)
    })
    const posts = calls.filter((call) => call.url === '/api/generate/discover')
    expect(posts.map((call) => call.body)).toMatchObject([
      {
        kind: 'discover_artist',
        artistId: 'artist-1',
        filters: { region: 'argentina' },
      },
      {
        kind: 'discover_track',
        trackId: 'stay',
        filters: { region: 'argentina' },
      },
    ])
  })

  it('offers every result filter in order and sends them canonically', async () => {
    setAuthState(null)
    const filtered = {
      ...regionalDiscovery,
      generation: {
        ...regionalDiscovery.generation,
        filters: {
          region: null,
          femaleVocals: true,
          releaseRange: { fromYear: 1990, toYear: 1999 },
          excludeLive: true,
        },
      },
    }
    const { calls } = stubApi({
      'GET /api/artists/search': () =>
        jsonResponse({ artists: [{ id: 'artist-1', name: 'Sade' }] }),
      'POST /api/generate/discover': () =>
        ndjsonResponse({ type: 'result', playlist: filtered }),
    })
    const user = userEvent.setup()
    renderWithProviders(<DiscoverPlaylistForm />, { route: '/app/discover' })

    await user.click(screen.getByRole('button', { name: 'Refine results' }))
    const section = screen
      .getByRole('heading', { name: 'Refine results' })
      .closest('section')!
    const selects = within(section)
      .getAllByRole('button')
      .filter((control) => control.getAttribute('aria-haspopup') === 'listbox')
    expect(selects.map((control) => control.textContent)).toEqual([
      'Any region',
      'Any',
      'Any',
    ])
    const vocals = within(section).getByRole('button', { name: /Vocals/ })
    expect(vocals).toHaveAccessibleDescription(
      'Optional · Filters result artists by their vocals.',
    )
    await user.click(vocals)
    expect(
      await screen.findByRole('option', { name: 'Female vocals' }),
    ).toBeVisible()
    expect(screen.queryByRole('option', { name: /women/i })).toBeNull()
    await user.click(screen.getByRole('option', { name: 'Female vocals' }))
    await user.click(within(section).getByRole('button', { name: /Decade/ }))
    const decades = (await screen.findAllByRole('option')).map(
      (option) => option.textContent,
    )
    expect(decades).toEqual([
      'Any',
      '2020–2026',
      '2010–2019',
      '2000–2009',
      '1990–1999',
      '1980–1989',
      '1970–1979',
      '1960–1969',
      '1950–1959',
    ])
    await user.click(screen.getByRole('option', { name: '1990–1999' }))
    const live = within(section).getByRole('switch', {
      name: 'Exclude live versions',
    })
    expect(live).toHaveAccessibleDescription(
      'Skips recordings identified as live or unplugged.',
    )
    await user.click(live)
    expect(live).toHaveAttribute('aria-checked', 'true')

    await user.type(screen.getByRole('combobox', { name: 'Artist' }), 'sade')
    await user.click(
      (await screen.findByRole('option', { name: /Sade/ }, { timeout: 3_000 }))
        .firstElementChild!,
    )
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))
    await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })

    const [post] = calls.filter((call) => call.url === '/api/generate/discover')
    expect(post.body).toMatchObject({
      kind: 'discover_artist',
      filters: {
        region: null,
        femaleVocals: true,
        releaseRange: { fromYear: 1990, toYear: 1999 },
        excludeLive: true,
      },
    })
    expect(
      screen.getByText(/^Sade · Female vocals · 1990–1999 · No live versions · /),
    ).toBeInTheDocument()
  })
})

describe('DiscoverPlaylistForm validation errors', () => {
  it('announces a missing seed on the seed search', async () => {
    setAuthState(null)
    const { calls } = stubApi({})
    renderWithProviders(<DiscoverPlaylistForm />, { route: '/app/discover' })

    const submit = screen.getByRole('button', { name: 'Generate playlist' })
    fireEvent.submit(submit.closest('form')!)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose an artist first.',
    )
    const search = screen.getByRole('combobox')
    expect(search).toHaveAttribute('aria-invalid', 'true')
    expect(search).toHaveAccessibleDescription('Choose an artist first.')
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
})
