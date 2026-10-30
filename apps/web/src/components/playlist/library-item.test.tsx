import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  PLAYLIST_NAME_MAX_LENGTH,
  type PlaylistSummary,
} from '@blendify/contracts'
import { LibraryItem } from '@/components/playlist/library-item'
import {
  jsonResponse,
  renderWithProviders,
  setAuthState,
  stubApi,
  testUser,
} from '@/test/app-harness'
import { spotifyJazzPlaylist } from '@/test/playlist-fixtures'

function summary(imageUrl: string | null): PlaylistSummary {
  return {
    ...spotifyJazzPlaylist,
    kind: 'artist_mix',
    seeds: [
      {
        type: 'artist',
        id: 'artist-1',
        name: 'Sade',
        imageUrl: 'https://i.scdn.co/image/sade',
      },
    ],
    imageUrl,
  }
}

function renderItem(
  playlist: PlaylistSummary,
  routes: Parameters<typeof stubApi>[0] = {},
) {
  setAuthState(testUser)
  const api = stubApi(routes)
  const view = renderWithProviders(
    <ul>
      <LibraryItem
        playlist={playlist}
        selecting={false}
        selected={false}
        onToggleSelect={vi.fn()}
        onAskConfirm={vi.fn()}
      />
    </ul>,
    { route: '/app/library' },
  )
  return { ...view, ...api }
}

const RENAME_ROUTE = 'PATCH /api/playlists/playlist-1'

async function openRename(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
  return screen.getByRole('textbox', { name: 'Playlist name' })
}

afterEach(() => vi.unstubAllGlobals())

describe('LibraryItem cover', () => {
  it('never shows seed artwork as the playlist cover', () => {
    const { container } = renderItem(summary(null))

    expect(container.querySelector('img[src="https://i.scdn.co/image/sade"]')).toBeNull()
  })

  it('shows the playlist image that Spotify reports for the playlist', () => {
    const { container } = renderItem(
      summary('https://mosaic.scdn.co/640/playlist-1'),
    )

    expect(
      container.querySelector('img[src="https://mosaic.scdn.co/640/playlist-1"]'),
    ).not.toBeNull()
  })
})

describe('LibraryItem rename', () => {
  it('labels the name field and applies the shared playlist name limit', async () => {
    const user = userEvent.setup()
    renderItem(summary(null))

    const input = await openRename(user)

    expect(input).toHaveFocus()
    expect(input).toHaveAttribute('maxLength', String(PLAYLIST_NAME_MAX_LENGTH))
  })

  it('sends a single rename while the first one is still saving', async () => {
    const user = userEvent.setup()
    let resolveRename: (response: Response) => void = () => {}
    const { calls } = renderItem(summary(null), {
      [RENAME_ROUTE]: () =>
        new Promise<Response>((resolve) => {
          resolveRename = resolve
        }),
    })

    const input = await openRename(user)
    await user.clear(input)
    await user.type(input, 'Late night{Enter}{Enter}')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.keyboard('{Escape}')

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1)
    expect(input).toBeInTheDocument()

    resolveRename(jsonResponse({ ...summary(null), name: 'Late night' }))
    await vi.waitFor(() => {
      expect(screen.queryByRole('textbox', { name: 'Playlist name' })).toBeNull()
    })
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus()
  })

  it('announces a failed rename on the field and keeps the draft', async () => {
    const user = userEvent.setup()
    renderItem(summary(null), {
      [RENAME_ROUTE]: () =>
        jsonResponse(
          { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Boom' },
          500,
        ),
    })

    const input = await openRename(user)
    await user.clear(input)
    await user.type(input, 'Late night{Enter}')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn’t rename the playlist. Try again.')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription(
      'Couldn’t rename the playlist. Try again.',
    )
    expect(input).toHaveValue('Late night')

    await user.type(input, '!')

    expect(screen.queryByRole('alert')).toBeNull()
    expect(input).not.toHaveAttribute('aria-invalid')
  })
})
