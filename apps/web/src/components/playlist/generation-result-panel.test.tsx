import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react'
import { MemoryRouter } from 'react-router-dom'
import type { GenerationProgress, SpotifyPreviewDto } from '@blendify/contracts'
import { GenerationResultPanel } from './generation-result-panel'
import { GenerationSubmitBar } from './generation-form-shared'
import { newSpotifySession, type SpotifySession } from '@/stores/playlist-run-store'
import { guestJazzPlaylist, jazzTrack, PREVIEW_ID } from '@/test/playlist-fixtures'

type PanelProps = Parameters<typeof GenerationResultPanel>[0]

function numericTokens(name: string): string[] {
  return screen.getByText(name).closest('li')?.textContent?.match(/\d+/g) ?? []
}

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    mode: 'spotify',
    isGenerating: false,
    result: null,
    progress: null,
    failure: null,
    requestedTrackCount: 0,
    workingTitleKey: 'spotifyPreview.working',
    workingHintKey: 'create.workingHint',
    copied: false,
    onCopy: vi.fn(),
    onRetry: vi.fn(),
    onAdjust: vi.fn(),
    onCreateAnother: vi.fn(),
    ...overrides,
  }
  const { container } = render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <GenerationResultPanel {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { props, container }
}

function progressPanel(progress: GenerationProgress): PanelProps {
  return {
    mode: 'spotify',
    isGenerating: true,
    result: null,
    progress,
    failure: null,
    requestedTrackCount: 10,
    workingTitleKey: 'spotifyPreview.working',
    workingHintKey: 'create.workingHint',
    copied: false,
    onCopy: vi.fn(),
    onRetry: vi.fn(),
    onAdjust: vi.fn(),
    onCreateAnother: vi.fn(),
  }
}

const guesterPlaylist = {
  name: 'Blendify · Mix · Guster',
  description: '',
  seeds: [{ type: 'artist', id: 'artist-1', name: 'Guster' }],
  tracks: Array.from({ length: 10 }, (_, index) => ({
    ...jazzTrack,
    id: `track-${index}`,
    uri: `spotify:track:track-${index}`,
    durationMs: 4 * 60_000,
  })),
  generation: {
    version: 1,
    kind: 'artist_mix',
    filters: { region: null, femaleVocals: false, releaseRange: null, excludeLive: false },
    popularity: 'balanced',
    orderMode: 'random',
    tracksPerSeed: 10,
    seeds: [{ id: 'artist-1', name: 'Guster' }],
  },
} satisfies SpotifyPreviewDto['playlist']

const readyOutcome = {
  mode: 'spotify',
  preview: { previewId: PREVIEW_ID, expiresAt: '2099-01-01T00:00:00.000Z', playlist: guesterPlaylist },
} as const

function spotifyBinding(session: Partial<SpotifySession> = {}): NonNullable<PanelProps['spotify']> {
  return {
    session: { ...newSpotifySession(guesterPlaylist.name), ...session },
    actions: {
      setTitle: vi.fn(),
      setCoverOption: vi.fn(),
      save: vi.fn(),
      checkStatus: vi.fn(),
    },
    focusOnArrival: false,
  }
}

describe('GenerationResultPanel', () => {
  it('leads an unsaved Spotify preview with the editable title, natural metadata and a not-saved notice', () => {
    renderPanel({
      result: readyOutcome,
      spotify: spotifyBinding(),
      requestedTrackCount: 10,
    })

    expect(
      screen.getByRole('heading', { name: 'Blendify · Mix · Guster' }),
    ).toBeVisible()
    expect(screen.getByText('Preview · not saved yet')).toBeVisible()
    expect(screen.getByText('10 songs · 40 min')).toBeVisible()
    expect(screen.getByText(/This preview is temporary and isn’t saved yet/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeEnabled()
    expect(screen.queryByRole('link', { name: /Open in Spotify/ })).toBeNull()
  })

  it('tells people they can browse Blendify while a Spotify preview generates, without promising a save', () => {
    renderPanel({ isGenerating: true, requestStarted: true })

    expect(
      screen.getByText(/Nothing is saved to Spotify until you choose Save to Spotify/),
    ).toBeVisible()
    expect(screen.queryByText(/will be saved to Spotify/)).toBeNull()
  })

  it('keeps Try again visible and adds a collapsed explanation for a Spotify limit', async () => {
    const { props } = renderPanel({
      failure: {
        message: 'Spotify is temporarily limiting requests from Blendify. Try again later.',
        recovery: 'retry',
        explainsSpotifyLimit: true,
      },
    })

    const toggle = screen.getByRole('button', { name: 'Why am I seeing this?' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()

    await userEvent.setup().click(toggle)
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(props.onRetry).not.toHaveBeenCalled()
  })

  it('offers to connect Spotify again instead of a retry when authorization expired', () => {
    renderPanel({
      failure: {
        message: 'Your Spotify connection is no longer valid.',
        recovery: 'reconnect',
        explainsSpotifyLimit: false,
      },
    })

    expect(screen.getByRole('button', { name: 'Connect Spotify' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('does not promise background work before the request starts', () => {
    renderPanel({ isGenerating: true, requestStarted: false })

    expect(screen.queryByText(/You can leave this page/)).toBeNull()
  })

  it('renders nothing while idle', () => {
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it('announces progress through a small status region', () => {
    renderPanel({
      isGenerating: true,
      progress: {
        phase: 'matching_tracks',
        current: 2,
        total: 10,
        percent: 20,
      },
    })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Finding songs, 2 of 10 songs',
    )
    expect(
      screen.getByRole('region', { name: 'Generating your preview' }),
    ).not.toHaveAttribute('aria-live')
    expect(screen.getByText('2 of 10 songs', { selector: 'p' })).toBeVisible()
  })

  it('shows preparation without a counter or an ETA', () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <GenerationResultPanel
            {...progressPanel({
              phase: 'resolving_seeds',
              current: 1,
              total: 11,
              percent: 1,
              etaSeconds: 12,
            })}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Preparing your selection',
    )
    expect(screen.getByRole('status')).not.toHaveTextContent(/of /)
    expect(screen.getByText('1%')).toBeVisible()
    expect(screen.queryByText(/of 11/)).toBeNull()
    expect(screen.queryByText(/min remaining/i)).toBeNull()
  })

  it('counts songs found during search, including a partial fill', () => {
    const { rerender } = render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <GenerationResultPanel
            {...progressPanel({
              phase: 'matching_tracks',
              current: 0,
              total: 10,
              percent: 10,
              etaSeconds: 20,
            })}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Finding songs, 0 of 10 songs',
    )
    expect(screen.getByText('0 of 10 songs', { selector: 'p' })).toBeVisible()
    expect(screen.getByText('10%')).toBeVisible()
    expect(screen.queryByText(/min remaining/i)).toBeNull()

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <GenerationResultPanel
            {...progressPanel({
              phase: 'matching_tracks',
              current: 3,
              total: 10,
              percent: 34,
            })}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Finding songs, 3 of 10 songs',
    )
    expect(screen.getByText('3 of 10 songs', { selector: 'p' })).toBeVisible()

    rerender(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <GenerationResultPanel
            {...progressPanel({
              phase: 'matching_tracks',
              current: 6,
              total: 10,
              percent: 58,
              etaSeconds: 15,
            })}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent(
      'Finding songs, 6 of 10 songs',
    )
    expect(screen.getByText('6 of 10 songs', { selector: 'p' })).toBeVisible()
    expect(screen.getByText('58%')).toBeVisible()
    expect(screen.queryByText('10 of 10 songs')).toBeNull()
    expect(screen.queryByText(/min remaining/i)).toBeNull()
  })

  it('shows generation errors in place of the progress with a retry', async () => {
    const user = userEvent.setup()
    const { props } = renderPanel({
      failure: {
        message: 'Spotify is busy right now. Try again in about 2 minutes.',
        recovery: 'retry',
        explainsSpotifyLimit: false,
      },
    })

    expect(
      screen.getByRole('heading', { name: 'Couldn’t create the playlist' }),
    ).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Spotify is busy right now. Try again in about 2 minutes.',
    )

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })

  it('credits Last.fm once next to the preview', () => {
    renderPanel({
      result: readyOutcome,
      spotify: spotifyBinding(),
      requestedTrackCount: 10,
    })

    const credits = screen.getAllByRole('link', { name: /Last\.fm/ })
    expect(credits).toHaveLength(1)
    expect(credits[0]).toHaveAttribute('href', 'https://www.last.fm')
    expect(
      screen.getByText(/Music recommendations powered by/),
    ).toBeVisible()
  })
})

describe('GenerationResultPanel in Guest Mode', () => {
  function renderGuest(playlist = guestJazzPlaylist) {
    return renderPanel({
      mode: 'guest',
      result: { mode: 'guest', playlist },
      requestedTrackCount: 1,
    })
  }

  it('closes a short fill as a finished playlist', () => {
    renderPanel({
      mode: 'guest',
      isGenerating: false,
      workingTitleKey: 'create.workingGuest',
      requestedTrackCount: 10,
      result: {
        mode: 'guest',
        playlist: {
          ...guestJazzPlaylist,
          tracks: Array.from({ length: 6 }, (_, index) => ({
            ...jazzTrack,
            id: `track-${index}`,
            uri: `spotify:track:track-${index}`,
            externalUrl: `https://open.spotify.com/track/track-${index}`,
          })),
        },
      },
    })

    expect(
      screen.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(screen.getByText(/Found 6 of 10 songs/)).toBeVisible()
    expect(screen.queryByText('Finding songs')).toBeNull()
    expect(screen.queryByText('58%')).toBeNull()
    expect(screen.queryByText(/10 of 10/)).toBeNull()
    expect(screen.queryByText(/min remaining/i)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows the generated tracks with credited artists and no Spotify publication state', () => {
    renderGuest()

    expect(
      screen.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(screen.getByText('Jazz, blended.')).toBeVisible()
    expect(screen.getByText('1 song · 9 min')).toBeVisible()
    const songs = screen.getByRole('list', { name: 'Songs in this playlist' })
    expect(songs).toHaveTextContent('So What')
    expect(songs).toHaveTextContent('Miles Davis, John Coltrane · Kind of Blue')
    expect(screen.queryByRole('link', { name: 'Open in Spotify' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
    expect(screen.queryByText(/saved to Spotify/)).toBeNull()
    expect(
      screen.getByText(
        'This playlist is temporary. It stays in this browser tab until you close the tab, create another playlist or connect Spotify.',
      ),
    ).toBeVisible()
  })

  it('does not present unknown track popularity as a zero score', () => {
    renderGuest({
      ...guestJazzPlaylist,
      tracks: [
        { ...jazzTrack, popularity: 73 },
        {
          ...jazzTrack,
          id: 'track-2',
          name: 'Blue in Green',
          uri: 'spotify:track:track-2',
          popularity: 0,
        },
        {
          ...jazzTrack,
          id: 'track-3',
          name: 'Flamenco Sketches',
          uri: 'spotify:track:track-3',
          popularity: null,
        },
      ],
    })

    expect(numericTokens('So What')).toEqual(['1', '9', '05'])
    expect(numericTokens('Blue in Green')).toEqual(['2', '9', '05'])
    expect(numericTokens('Flamenco Sketches')).toEqual(['3', '9', '05'])
  })

  it('credits Last.fm alongside the Spotify track credit', () => {
    renderGuest()

    const credits = screen.getAllByRole('link', { name: /Last\.fm/ })
    expect(credits).toHaveLength(1)
    expect(credits[0]).toHaveAttribute('href', 'https://www.last.fm')
    expect(screen.getByText('Track details from')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Spotify' })).toBeVisible()
  })

  it('links each track back to Spotify only when it has a Spotify URL', () => {
    renderGuest({
      ...guestJazzPlaylist,
      tracks: [
        jazzTrack,
        { ...jazzTrack, id: 'track-2', name: 'Blue in Green', externalUrl: undefined },
      ],
    })

    const link = screen.getByRole('link', {
      name: 'Open So What by Miles Davis, John Coltrane in Spotify',
    })
    expect(link).toHaveAttribute('href', jazzTrack.externalUrl)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.queryByRole('link', { name: /Blue in Green/ })).toBeNull()
  })

  it('links Spotify artwork back to its Spotify source', () => {
    const { container } = renderGuest({
      ...guestJazzPlaylist,
      coverArtwork: {
        imageUrl: 'https://i.scdn.co/image/cover',
        spotifyUrl: 'https://open.spotify.com/track/track-1',
      },
    })

    expect(screen.getByText('Track details and artwork from')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Spotify' })).toBeVisible()
    const link = screen.getByRole('link', {
      name: 'Open cover artwork source in Spotify',
    })
    expect(link).toHaveAttribute('href', 'https://open.spotify.com/track/track-1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link.querySelector('img')).toHaveAttribute(
      'src',
      'https://i.scdn.co/image/cover',
    )
    expect(container.querySelectorAll('img[src^="https://i.scdn.co"]')).toHaveLength(1)
  })

  it('does not show Spotify artwork without a Spotify link', () => {
    const { container } = renderGuest({
      ...guestJazzPlaylist,
      coverArtwork: {
        imageUrl: 'https://i.scdn.co/image/cover',
        spotifyUrl: 'https://example.com/not-spotify',
      },
    })

    expect(screen.getByText('Track details from')).toBeVisible()
    expect(container.querySelector('img[src^="https://i.scdn.co"]')).toBeNull()
  })

  it('attributes only track details when no Spotify artwork is shown', () => {
    const { container } = renderGuest()

    expect(screen.getByText('Track details from')).toBeVisible()
    expect(screen.getByRole('img', { name: 'Spotify' })).toBeVisible()
    expect(container.querySelector('img[src^="https://i.scdn.co"]')).toBeNull()
  })

  it('keeps a result without transfer complete and without a transfer control', () => {
    renderGuest()

    expect(screen.getByText('Playlist generated')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Transfer with Soundiiz' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Soundiiz/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Create another' })).toBeVisible()
  })

  it('offers the Soundiiz transfer when the result includes one', () => {
    renderGuest({
      ...guestJazzPlaylist,
      transfer: { token: 'signed-token', expiresAt: '2026-09-25T13:00:00.000Z' },
    })

    const transfer = screen.getByRole('region', { name: 'Transfer with Soundiiz' })
    expect(transfer).toHaveTextContent(
      'Soundiiz will open an external page where you can choose the destination service and complete the transfer.',
    )
    expect(
      screen.getByRole('button', { name: 'Prepare transfer' }),
    ).toBeVisible()
    expect(document.body).not.toHaveTextContent('signed-token')
  })

  it('does not promise saving while a Guest generation runs', () => {
    renderPanel({
      mode: 'guest',
      isGenerating: true,
      requestStarted: true,
      workingTitleKey: 'create.workingGuest',
      workingHintKey: 'create.workingHintGuest',
    })

    expect(
      screen.getByRole('heading', { name: 'Generating your playlist' }),
    ).toBeVisible()
    expect(screen.queryByText(/Spotify/)).toBeNull()

    expect(
      screen.getByText(
        'Keep this page open until the playlist is ready. Leaving stops it, and nothing is saved.',
      ),
    ).toBeVisible()
  })

  it('titles a failed Guest generation without creation wording', () => {
    renderPanel({
      mode: 'guest',
      failure: {
        message: 'Something went wrong.',
        recovery: 'retry',
        explainsSpotifyLimit: false,
      },
    })

    expect(
      screen.getByRole('heading', { name: 'Couldn’t generate the playlist' }),
    ).toBeVisible()
  })
})

describe('GenerationSubmitBar', () => {
  it('describes the CTA with the estimated playlist size', () => {
    render(
      <GenerationSubmitBar
        isGenerating={false}
        disabledReason={null}
        error={null}
        idleLabel="Create playlist"
        busyLabel="Creating…"
        summary="≈ 40 songs · 10 per artist"
        icon={Sparkles}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Create playlist' }),
    ).toHaveAccessibleDescription('≈ 40 songs · 10 per artist')
  })

  it('explains why the CTA is disabled', () => {
    render(
      <GenerationSubmitBar
        isGenerating={false}
        disabledReason="Add at least one artist to continue."
        error={null}
        idleLabel="Create playlist"
        busyLabel="Creating…"
        icon={Sparkles}
      />,
    )

    const button = screen.getByRole('button', { name: 'Create playlist' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(
      'Add at least one artist to continue.',
    )
  })

  it('stays disabled without a reason while generating', () => {
    render(
      <GenerationSubmitBar
        isGenerating
        disabledReason={null}
        error={null}
        idleLabel="Create playlist"
        busyLabel="Creating…"
        icon={Sparkles}
      />,
    )

    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled()
  })
})
