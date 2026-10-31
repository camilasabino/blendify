import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLocaleStore } from '@/i18n/use-locale'
import { ApiError } from '@/lib/api-error'
import {
  newSpotifySession,
  type SpotifySaveState,
  type SpotifySession,
} from '@/stores/playlist-run-store'
import { jazzPreview, publishedDestination } from '@/test/playlist-fixtures'
import { SpotifyPreviewResult } from './spotify-preview-result'

function setup(save: SpotifySaveState, overrides: Partial<SpotifySession> = {}) {
  useLocaleStore.getState().setLocale('en')
  const preview = jazzPreview()
  const actions = {
    setTitle: vi.fn(),
    setCoverOption: vi.fn(),
    save: vi.fn(),
    checkStatus: vi.fn(),
  }
  const handlers = {
    onCopy: vi.fn(),
    onGenerateAgain: vi.fn(),
    onAdjust: vi.fn(),
    onCreateAnother: vi.fn(),
  }
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <SpotifyPreviewResult
          titleId="title"
          outcome={{ mode: 'spotify', preview }}
          session={{ ...newSpotifySession(preview.playlist.name), ...overrides, save }}
          actions={actions}
          requestedTrackCount={1}
          focusOnArrival={false}
          copied={false}
          {...handlers}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  )
  return { actions, handlers, user: userEvent.setup() }
}

describe('SpotifyPreviewResult', () => {
  it('shows an unsaved preview with an explicit Save action and no Spotify link', async () => {
    const { actions, user } = setup({ phase: 'idle' })

    expect(screen.getByText('Preview · not saved yet')).toBeVisible()
    expect(screen.getByRole('switch', { name: 'Add a cover image' })).toBeChecked()
    expect(screen.queryByRole('link', { name: /Open in Spotify/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save to Spotify' }))
    expect(actions.save).toHaveBeenCalledOnce()
  })

  it('passes the cover option and the edited title to the session', async () => {
    const { actions, user } = setup({ phase: 'idle' })

    await user.click(screen.getByRole('switch', { name: 'Add a cover image' }))
    expect(actions.setCoverOption).toHaveBeenCalledWith(false)

    await user.click(screen.getByRole('button', { name: 'Edit title' }))
    await user.type(screen.getByRole('textbox', { name: 'Playlist title' }), '!')
    expect(actions.setTitle).toHaveBeenLastCalledWith(expect.stringMatching(/!$/))
  })

  it('locks the title and the Save action while saving', () => {
    setup({ phase: 'saving' })

    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Saving to Spotify…' })).toBeDisabled()
    expect(screen.getByRole('switch', { name: 'Add a cover image' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Create another' })).toBeNull()
  })

  it('confirms a save in progress and offers no Save action', () => {
    setup({ phase: 'reconciling', exhausted: false })

    expect(screen.getAllByText('Confirming whether the playlist was saved to Spotify…').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Save to Spotify' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull()
  })

  it('offers Check status, never Save, once the polling cap was reached', async () => {
    const { actions, user } = setup({ phase: 'reconciling', exhausted: true })

    expect(screen.queryByRole('button', { name: 'Save to Spotify' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(actions.checkStatus).toHaveBeenCalledOnce()
  })

  it('keeps the preview and shows the error after a confirmed failure', () => {
    setup({
      phase: 'failed',
      retryAt: null,
      error: new ApiError('x', 502, {
        statusCode: 502,
        code: 'SPOTIFY_REQUEST_REJECTED',
        message: 'x',
      }),
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/Spotify/)
    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeEnabled()
  })

  it('asks to reconnect when authorization expired and keeps the preview', () => {
    setup({
      phase: 'failed',
      retryAt: null,
      error: new ApiError('x', 401, {
        statusCode: 401,
        code: 'SPOTIFY_REAUTH_REQUIRED',
        message: 'x',
      }),
    })

    expect(screen.getByRole('button', { name: 'Connect Spotify' })).toBeVisible()
    expect(screen.getByText(/The preview stays here/)).toBeVisible()
  })

  it('holds Save back until the wait of a rate limit has passed', () => {
    setup({
      phase: 'failed',
      retryAt: Date.now() + 60_000,
      error: new ApiError('x', 429, {
        statusCode: 429,
        code: 'RATE_LIMITED',
        message: 'x',
        details: { retryAfterSeconds: 60 },
      }),
    })

    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeDisabled()
  })

  it('shows the saved outcome with copy link and the tracks', async () => {
    const { handlers, user } = setup({ phase: 'settled', destination: publishedDestination })

    expect(screen.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(handlers.onCopy).toHaveBeenCalledWith(publishedDestination.spotifyUrl)
    expect(screen.queryByRole('button', { name: 'Save to Spotify' })).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('shows a cover notice when the cover could not be rendered', () => {
    setup({ phase: 'settled', destination: publishedDestination }, { coverRenderFailed: true })

    expect(screen.getByText('Couldn’t add the cover.')).toBeVisible()
  })

  it('shows an incomplete outcome without a link and without a Save action', () => {
    setup({
      phase: 'settled',
      destination: { status: 'publish_incomplete', spotifyUrl: null, reason: 'outcome_unknown' },
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/may exist in your account/)
    expect(screen.queryByRole('link', { name: /Open in Spotify/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save to Spotify' })).toBeNull()
  })

  it('explains an expired preview without promising the same songs and generates it again', async () => {
    const { handlers, user } = setup({ phase: 'expired', mayHaveSaved: false })

    expect(screen.getByRole('heading', { name: 'This preview expired' })).toBeVisible()
    expect(screen.getAllByText(/the songs may be different/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Generate again' }))
    expect(handlers.onGenerateAgain).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Save to Spotify' })).toBeNull()
  })

  it('does not claim nothing was saved when the preview vanished during a save', () => {
    setup({ phase: 'expired', mayHaveSaved: true })

    expect(screen.getByRole('heading', { name: 'This preview is no longer available' })).toBeVisible()
    expect(screen.getAllByText(/check your playlists in Spotify/).length).toBeGreaterThan(0)
  })

  it('uses neutral copy when a preview that was never saved disappeared early', () => {
    setup({ phase: 'expired', mayHaveSaved: false, lostEarly: true })

    expect(screen.getByRole('heading', { name: 'This preview is no longer available' })).toBeVisible()
    expect(screen.getAllByText(/can no longer find this preview\. You can generate it again/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/check your playlists in Spotify/)).toBeNull()
    expect(screen.queryByText(/kept for about 30 minutes/)).toBeNull()
  })

  it('shows the generation error next to a restored previous preview', () => {
    setup({ phase: 'idle' }, { generationError: new Error('x') })

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t generate a new preview')
    expect(screen.getByRole('button', { name: 'Save to Spotify' })).toBeEnabled()
  })

  it('moves focus to the heading when the preview arrives', () => {
    useLocaleStore.getState().setLocale('en')
    const preview = jazzPreview()
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <SpotifyPreviewResult
            titleId="title"
            outcome={{ mode: 'spotify', preview }}
            session={newSpotifySession(preview.playlist.name)}
            actions={{ setTitle: vi.fn(), setCoverOption: vi.fn(), save: vi.fn(), checkStatus: vi.fn() }}
            requestedTrackCount={1}
            focusOnArrival
            copied={false}
            onCopy={vi.fn()}
            onGenerateAgain={vi.fn()}
            onAdjust={vi.fn()}
            onCreateAnother={vi.fn()}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: preview.playlist.name })).toHaveFocus()
  })
})
