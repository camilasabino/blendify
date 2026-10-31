import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MixPlaylistForm } from '@/components/playlist/mix-playlist-form'
import { messages } from '@/i18n/messages'
import { useLocaleStore } from '@/i18n/use-locale'
import { renderPlaylistCoverBase64 } from '@/lib/playlist-cover'
import { usePlaylistRunStore } from '@/stores/playlist-run-store'
import {
  jsonResponse,
  ndjsonResponse,
  renderWithProviders,
  setAuthState,
  stubApi,
  testUser,
  type FetchCall,
} from '@/test/app-harness'
import {
  guestJazzPlaylist as guestPlaylist,
  jazzPreview,
  PREVIEW_ID,
  previewState,
  publishedDestination,
} from '@/test/playlist-fixtures'

vi.mock('@/lib/playlist-cover', () => ({
  renderPlaylistCoverBase64: vi.fn().mockResolvedValue('cover-data'),
}))

const progress = {
  type: 'progress',
  phase: 'matching_tracks',
  current: 1,
  total: 1,
  percent: 90,
}

function stubGeneration() {
  return stubApi({
    'GET /api/genres': () =>
      jsonResponse({ genres: [{ id: 'jazz', name: 'Jazz' }] }),
    'POST /api/generate/mix': () =>
      ndjsonResponse(progress, { type: 'result', playlist: guestPlaylist }),
    'POST /api/previews/mix': () =>
      ndjsonResponse(progress, { type: 'result', playlist: jazzPreview() }),
    [`POST /api/previews/${PREVIEW_ID}/save`]: () =>
      jsonResponse(previewState(publishedDestination)),
    'GET /api/player/devices': () => jsonResponse({ devices: [] }),
  })
}

async function generateJazzMix(submitLabel: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('radio', { name: 'Genres' }))
  await user.click(await screen.findByRole('button', { name: /Jazz/ }))
  await user.click(screen.getByRole('button', { name: submitLabel }))
  return screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })
}

function generationCalls(calls: FetchCall[]) {
  return calls.filter((call) => call.method === 'POST')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MixPlaylistForm genre region', () => {
  afterEach(() => {
    useLocaleStore.getState().setLocale('en')
  })

  it('shows localized genre labels and submits canonical genre and region values', async () => {
    const es = messages.es
    setAuthState(null)
    const { calls } = stubApi({
      'GET /api/genres': () =>
        jsonResponse({
          genres: [
            {
              id: 'korean ballad',
              name: 'Korean Ballad',
            },
          ],
        }),
      'POST /api/generate/mix': () =>
        ndjsonResponse(progress, { type: 'result', playlist: guestPlaylist }),
    })
    renderWithProviders(<MixPlaylistForm />)
    act(() => useLocaleStore.getState().setLocale('es'))
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: es['create.modeGenres'] }))
    expect(
      screen.getByRole('button', { name: es['create.refineResults'] }),
    ).toHaveAccessibleDescription(es['create.refineResultsNone'])
    await user.click(
      screen.getByRole('button', { name: es['create.refineResults'] }),
    )
    const region = screen.getByRole('button', { name: new RegExp(es['create.region']) })
    expect(region).toHaveTextContent(es['create.regionAny'])
    await user.click(await screen.findByRole('button', { name: 'Balada coreana' }))
    await user.click(region)
    await user.click(await screen.findByRole('option', { name: es['region.brazilian'] }))
    await user.click(screen.getByRole('button', { name: es['create.generateGuest'] }))
    await vi.waitFor(() => {
      expect(generationCalls(calls)).toHaveLength(1)
    })
    expect(generationCalls(calls)[0].body).toMatchObject({
      kind: 'genre_mix',
      name: 'Blendify · Mezcla · Balada coreana · Brasil',
      genreIds: ['korean ballad'],
      filters: { region: 'brazilian' },
    })
  })

  it('keeps Refine results collapsed until it is opened', async () => {
    setAuthState(null)
    stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    const toggle = screen.getByRole('button', { name: 'Refine results' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Optional · No filters')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Decade/ })).toBeNull()
    expect(screen.queryByRole('switch', { name: 'Exclude live versions' })).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Refine results' }).closest('section'),
    ).toHaveTextContent('3')
    expect(
      screen.getByRole('heading', { name: 'Size' }).closest('section'),
    ).toHaveTextContent('4')

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(screen.getByRole('switch', { name: 'Exclude live versions' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(toggle)
    expect(screen.getByText('No live versions')).toBeVisible()
    await user.click(toggle)
    expect(
      screen.getByRole('switch', { name: 'Exclude live versions' }),
    ).toHaveAttribute('aria-checked', 'true')
  })

  it('shows only the decade and live controls for an artist mix', async () => {
    setAuthState(null)
    stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Refine results' }))
    const section = screen
      .getByRole('heading', { name: 'Refine results' })
      .closest('section')
    expect(section).not.toBeNull()
    expect(
      within(section!).getByRole('button', { name: /Decade/ }),
    ).toHaveAttribute('aria-haspopup', 'listbox')
    expect(
      within(section!).getByRole('switch', { name: 'Exclude live versions' }),
    ).toHaveAttribute('aria-checked', 'false')
    expect(
      within(section!).queryByRole('button', { name: /Region/ }),
    ).not.toBeInTheDocument()
    expect(
      within(section!).queryByRole('button', { name: /Vocals/ }),
    ).not.toBeInTheDocument()
    expect(within(section!).queryByText(/female/i)).not.toBeInTheDocument()
  })

  it('shows every filter in order under Refine results for genre mixes', async () => {
    setAuthState(null)
    stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: 'Genres' }))
    await user.click(screen.getByRole('button', { name: 'Refine results' }))

    const section = screen
      .getByRole('heading', { name: 'Refine results' })
      .closest('section')
    expect(section).not.toBeNull()
    const controls = within(section!)
      .getAllByRole('button')
      .map((control) => control.getAttribute('aria-haspopup') === 'listbox' ? control.textContent : null)
      .filter(Boolean)
    expect(controls).toEqual(['Any region', 'Any', 'Any'])
    expect(
      within(section!).getByRole('button', { name: /Region/ }),
    ).toHaveAttribute('aria-haspopup', 'listbox')
    expect(within(section!).getByRole('button', { name: /Vocals/ })).toBeVisible()
    expect(within(section!).getByRole('button', { name: /Decade/ })).toBeVisible()
    expect(
      within(section!).getByRole('switch', { name: 'Exclude live versions' }),
    ).toBeVisible()
    const source = screen
      .getByRole('heading', { name: 'Artists or genres' })
      .closest('section')
    expect(
      within(source!).queryByRole('button', { name: /Region/ }),
    ).not.toBeInTheDocument()
  })

  it('sends every selected genre mix filter canonically', async () => {
    setAuthState(null)
    const { calls } = stubApi({
      'GET /api/genres': () =>
        jsonResponse({ genres: [{ id: 'rock', name: 'Rock' }] }),
      'POST /api/generate/mix': () =>
        ndjsonResponse(progress, { type: 'result', playlist: guestPlaylist }),
    })
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: 'Genres' }))
    await user.click(await screen.findByRole('button', { name: 'Rock' }))
    await user.click(screen.getByRole('button', { name: 'Refine results' }))
    await user.click(screen.getByRole('button', { name: /Region/ }))
    await user.click(await screen.findByRole('option', { name: 'Argentina' }))
    await user.click(screen.getByRole('button', { name: /Vocals/ }))
    await user.click(await screen.findByRole('option', { name: 'Female vocals' }))
    await user.click(screen.getByRole('button', { name: /Decade/ }))
    await user.click(await screen.findByRole('option', { name: '1990–1999' }))
    await user.click(screen.getByRole('switch', { name: 'Exclude live versions' }))
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))

    await vi.waitFor(() => {
      expect(generationCalls(calls)).toHaveLength(1)
    })
    const [request] = generationCalls(calls)
    expect(request.body).toMatchObject({
      kind: 'genre_mix',
      name: 'Blendify · Mix · Rock · Argentina',
      filters: {
        region: 'argentina',
        femaleVocals: true,
        releaseRange: { fromYear: 1990, toYear: 1999 },
        excludeLive: true,
      },
    })
    expect(request.body).not.toHaveProperty('decade')
  })

  describe('current decade', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('submits the current decade ending at the current year', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-01T12:00:00Z') })
      setAuthState(null)
      const { calls } = stubGeneration()
      renderWithProviders(<MixPlaylistForm />)
      const user = userEvent.setup()

      await user.click(screen.getByRole('radio', { name: 'Genres' }))
      await user.click(await screen.findByRole('button', { name: /Jazz/ }))
      await user.click(screen.getByRole('button', { name: 'Refine results' }))
      await user.click(screen.getByRole('button', { name: /Decade/ }))
      await user.click(await screen.findByRole('option', { name: '2020–2026' }))
      await user.click(screen.getByRole('button', { name: 'Generate playlist' }))

      await vi.waitFor(() => {
        expect(generationCalls(calls)).toHaveLength(1)
      })
      expect(generationCalls(calls)[0].body).toMatchObject({
        filters: { releaseRange: { fromYear: 2020, toYear: 2026 } },
      })
    })
  })

  it('reopens Refine results with active filters on adjust and collapses it on Create another', async () => {
    setAuthState(null)
    stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: 'Genres' }))
    await user.click(await screen.findByRole('button', { name: /Jazz/ }))
    await user.click(screen.getByRole('button', { name: 'Refine results' }))
    await user.click(screen.getByRole('switch', { name: 'Exclude live versions' }))
    await user.click(screen.getByRole('button', { name: 'Refine results' }))
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))
    await screen.findByRole('heading', { name: 'Blendify · Mix · Jazz' })

    await user.click(screen.getByRole('button', { name: 'Try different settings' }))
    const toggle = screen.getByRole('button', { name: 'Refine results' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('switch', { name: 'Exclude live versions' }),
    ).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('button', { name: 'Create another' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Optional · No filters')).toBeVisible()
    await user.click(toggle)
    expect(
      screen.getByRole('switch', { name: 'Exclude live versions' }),
    ).toHaveAttribute('aria-checked', 'false')
  })

  it('never sends artist-level filters chosen for genres with an artist mix', async () => {
    setAuthState(null)
    const { calls } = stubApi({
      'GET /api/genres': () =>
        jsonResponse({ genres: [{ id: 'jazz', name: 'Jazz' }] }),
      'GET /api/artists/search': () =>
        jsonResponse({
          artists: [{ id: 'artist-1', name: 'Radiohead', imageUrl: null }],
        }),
      'POST /api/generate/mix': () =>
        ndjsonResponse(progress, { type: 'result', playlist: guestPlaylist }),
    })
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: 'Genres' }))
    await user.click(screen.getByRole('button', { name: 'Refine results' }))
    await user.click(screen.getByRole('button', { name: /Region/ }))
    await user.click(await screen.findByRole('option', { name: 'Argentina' }))
    await user.click(screen.getByRole('button', { name: /Vocals/ }))
    await user.click(await screen.findByRole('option', { name: 'Female vocals' }))
    await user.click(screen.getByRole('button', { name: /Decade/ }))
    await user.click(await screen.findByRole('option', { name: '1980–1989' }))
    await user.click(screen.getByRole('radio', { name: 'Artists' }))
    expect(screen.queryByRole('button', { name: /Region/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Vocals/ })).toBeNull()
    await user.type(screen.getByRole('combobox'), 'Radiohead')
    await user.click(
      await screen.findByRole('option', { name: /Radiohead/ }, { timeout: 3_000 }),
    )
    await user.click(screen.getByRole('switch', { name: 'Exclude live versions' }))
    await user.click(screen.getByRole('button', { name: 'Generate playlist' }))

    await vi.waitFor(() => {
      expect(generationCalls(calls)).toHaveLength(1)
    })
    const [request] = generationCalls(calls)
    expect(request.body).toMatchObject({
      kind: 'artist_mix',
      filters: {
        region: null,
        femaleVocals: false,
        releaseRange: { fromYear: 1980, toYear: 1989 },
        excludeLive: true,
      },
    })
    expect(request.body).not.toHaveProperty('region')

    await user.click(screen.getByRole('radio', { name: 'Genres', hidden: true }))
    expect(
      screen.getByRole('button', { name: /Region/, hidden: true }),
    ).toHaveTextContent('Argentina')
    expect(
      screen.getByRole('button', { name: /Vocals/, hidden: true }),
    ).toHaveTextContent('Female vocals')
  })
})

describe('MixPlaylistForm artist search', () => {
  it('does not start a generation when Enter is pressed in the artist search', async () => {
    setAuthState(null)
    const { calls } = stubApi({
      'GET /api/artists/search': () =>
        jsonResponse({
          artists: [
            { id: 'artist-1', name: 'Radiohead', imageUrl: null },
            { id: 'artist-2', name: 'Portishead', imageUrl: null },
          ],
        }),
      'POST /api/generate/mix': () =>
        ndjsonResponse(progress, { type: 'result', playlist: guestPlaylist }),
    })
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    const search = screen.getByRole('combobox', { name: 'Artists' })
    await user.type(search, 'Radiohead')
    await user.click(
      await screen.findByRole('option', { name: /Radiohead/ }, { timeout: 3_000 }),
    )
    expect(screen.getByRole('button', { name: 'Generate playlist' })).toBeEnabled()

    await user.type(search, 'Portishead{Enter}')
    await screen.findByRole('option', { name: /Portishead/ }, { timeout: 3_000 })
    await user.keyboard('{Enter}')

    expect(generationCalls(calls)).toHaveLength(0)
    expect(search).toHaveValue('Portishead')
  })
})

describe('MixPlaylistForm validation errors', () => {
  it('announces a missing artist on the artist search until one is added', async () => {
    setAuthState(null)
    const { calls } = stubApi({
      'GET /api/artists/search': () =>
        jsonResponse({
          artists: [{ id: 'artist-1', name: 'Radiohead', imageUrl: null }],
        }),
    })
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    const submit = screen.getByRole('button', { name: 'Generate playlist' })
    fireEvent.submit(submit.closest('form')!)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Add at least one artist.')
    const search = screen.getByRole('combobox', { name: 'Artists' })
    expect(search).toHaveAttribute('aria-invalid', 'true')
    expect(search).toHaveAccessibleDescription('Add at least one artist.')
    expect(generationCalls(calls)).toHaveLength(0)

    await user.type(search, 'Radiohead')
    await user.click(
      await screen.findByRole('option', { name: /Radiohead/ }, { timeout: 3_000 }),
    )

    expect(screen.queryByRole('alert')).toBeNull()
    expect(search).not.toHaveAttribute('aria-invalid')
    expect(search).not.toHaveAttribute('aria-describedby')
  })

  it('announces a missing genre on the genre search', async () => {
    setAuthState(null)
    stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: 'Genres' }))
    const submit = screen.getByRole('button', { name: 'Generate playlist' })
    fireEvent.submit(submit.closest('form')!)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Add at least one genre.',
    )
    const search = screen.getByRole('textbox', { name: 'Search genres…' })
    expect(search).toHaveAttribute('aria-invalid', 'true')
    expect(search).toHaveAccessibleDescription('Add at least one genre.')
  })

  it('announces a pasted list error on the paste field', async () => {
    setAuthState(null)
    const { calls } = stubApi({})
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Paste a list of artists' }))
    const paste = screen.getByRole('textbox', { name: 'Paste a list of artists' })
    expect(paste).toHaveAccessibleDescription('One artist per line.')
    await user.click(paste)
    await user.paste(
      Array.from({ length: 13 }, (_, index) => `Artist ${index}`).join('\n'),
    )
    await user.click(screen.getByRole('button', { name: 'Add artists' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You can select up to 12 artists.',
    )
    expect(paste).toHaveAttribute('aria-invalid', 'true')
    expect(paste).toHaveAccessibleDescription(
      'You can select up to 12 artists. One artist per line.',
    )
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0)
  })
})

describe('MixPlaylistForm generation modes', () => {
  it('generates through the Guest endpoint without publication fields', async () => {
    setAuthState(null)
    const { calls } = stubGeneration()
    renderWithProviders(<MixPlaylistForm />)

    expect(screen.getByRole('heading', { name: 'Size' })).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Size and cover' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Add a cover image')).not.toBeInTheDocument()
    await generateJazzMix('Generate playlist')

    const [request] = generationCalls(calls)
    expect(request.url).toBe('/api/generate/mix')
    expect(request.body).not.toHaveProperty('persistToLibrary')
    expect(request.body).not.toHaveProperty('coverImageBase64')
    expect(request.body).toMatchObject({ kind: 'genre_mix', genreIds: ['jazz'] })

    expect(screen.getByText('Playlist generated')).toBeVisible()
    expect(screen.queryByText('Playlist ready')).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Generate new playlist', hidden: true }),
    ).toBeInTheDocument()
    const songs = screen.getByRole('list', { name: 'Songs in this playlist' })
    expect(within(songs).getByText('So What')).toBeVisible()
    expect(
      within(songs).getByText('Miles Davis, John Coltrane · Kind of Blue'),
    ).toBeVisible()
    expect(
      screen.getByText(
        'This playlist is temporary. It stays in this browser tab until you close the tab, create another playlist or connect Spotify.',
      ),
    ).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Open in Spotify' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Transfer with Soundiiz' })).toBeNull()
  })

  it('generates a Spotify preview from the same form without saving anything', async () => {
    setAuthState(testUser)
    const { calls } = stubGeneration()
    renderWithProviders(<MixPlaylistForm />)

    expect(screen.getByRole('heading', { name: 'Size' })).toBeVisible()
    expect(screen.queryByText('Add a cover image')).not.toBeInTheDocument()
    await generateJazzMix('Generate preview')

    const [request] = generationCalls(calls)
    expect(request.url).toBe('/api/previews/mix')
    expect(request.body).toMatchObject({ kind: 'genre_mix', genreIds: ['jazz'] })
    expect(request.body).not.toHaveProperty('persistToLibrary')
    expect(request.body).not.toHaveProperty('coverImageBase64')
    expect(generationCalls(calls)).toHaveLength(1)
    expect(screen.getByText('Preview · not saved yet')).toBeVisible()
    expect(screen.getByText(/This preview is temporary and isn’t saved yet/)).toBeVisible()
    expect(screen.getByText('Add a cover image')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Generate new preview', hidden: true }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open in Spotify' })).toBeNull()
    expect(renderPlaylistCoverBase64).not.toHaveBeenCalled()
    const songs = screen.getByRole('list', { name: 'Songs in this playlist' })
    expect(within(songs).getByText('So What')).toBeVisible()
  })

  it('saves exactly once with the edited title, however many times Save is activated', async () => {
    setAuthState(testUser)
    const { calls } = stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()
    await generateJazzMix('Generate preview')

    await user.click(screen.getByRole('button', { name: 'Edit title' }))
    const input = screen.getByRole('textbox', { name: 'Playlist title' })
    await user.clear(input)
    await user.type(input, 'Late night jazz')
    await user.click(screen.getByRole('button', { name: 'Done' }))

    const save = screen.getByRole('button', { name: 'Save to Spotify' })
    await user.dblClick(save)
    await user.keyboard('{Enter}')
    await screen.findByRole('heading', { name: 'Saved to Spotify' })

    const saves = calls.filter((call) => call.url.endsWith('/save'))
    expect(saves).toHaveLength(1)
    expect(saves[0].body).toEqual({
      name: 'Late night jazz',
      persistToLibrary: true,
      coverImageBase64: 'cover-data',
    })
    expect(renderPlaylistCoverBase64).toHaveBeenCalledWith({
      title: 'Late night jazz',
      kind: 'mix',
    })
    expect(screen.getByRole('link', { name: /Open in Spotify/ })).toHaveAttribute(
      'href',
      publishedDestination.spotifyUrl,
    )
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Save to Spotify' })).toBeNull()
    expect(screen.queryByText(/This preview is temporary/)).toBeNull()
  })

  it('disables Save with a reason while the title is empty', async () => {
    setAuthState(testUser)
    stubGeneration()
    renderWithProviders(<MixPlaylistForm />)
    const user = userEvent.setup()
    await generateJazzMix('Generate preview')

    await user.click(screen.getByRole('button', { name: 'Edit title' }))
    await user.clear(screen.getByRole('textbox', { name: 'Playlist title' }))

    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeDisabled()
    expect(screen.getByText('Add a title to save this playlist.')).toBeVisible()
  })
})

describe('MixPlaylistForm after an interrupted Spotify generation', () => {
  beforeEach(() => {
    usePlaylistRunStore.getState().discard()
  })

  it.each([
    [
      'the stream ends without a result',
      () => ndjsonResponse(progress),
    ],
    ['the connection drops', () => Promise.reject(new TypeError('network error'))],
  ])('offers a plain retry when %s because generation writes nothing', async (_label, firstReply) => {
    setAuthState(testUser)
    let attempts = 0
    const api = stubApi({
      'GET /api/genres': () => jsonResponse({ genres: [{ id: 'jazz', name: 'Jazz' }] }),
      'POST /api/previews/mix': () => {
        attempts += 1
        return attempts === 1
          ? firstReply()
          : ndjsonResponse(progress, { type: 'result', playlist: jazzPreview() })
      },
      'GET /api/player/devices': () => jsonResponse({ devices: [] }),
    })
    const user = userEvent.setup()
    renderWithProviders(<MixPlaylistForm />)
    await user.click(screen.getByRole('radio', { name: 'Genres' }))
    await user.click(await screen.findByRole('button', { name: /Jazz/ }))
    await user.click(screen.getByRole('button', { name: 'Generate preview' }))
    await screen.findByRole('heading', { name: 'Couldn’t create the playlist' })

    expect(screen.getByRole('button', { name: 'Generate preview' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Create a new playlist anyway' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('Preview · not saved yet')

    const creations = generationCalls(api.calls)
    expect(creations).toHaveLength(2)
    expect(creations[1].body).toEqual(creations[0].body)
    expect(api.calls.some((call) => call.url.endsWith('/save'))).toBe(false)
  })
})
