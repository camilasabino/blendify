import { render, screen } from '@testing-library/react'
import type { SpotifyDestinationDto } from '@blendify/contracts'
import { useLocaleStore } from '@/i18n/use-locale'
import { SpotifyDestinationOutcome } from './spotify-destination-outcome'

const URL = 'https://open.spotify.com/playlist/p1'

function renderOutcome(destination: SpotifyDestinationDto) {
  useLocaleStore.getState().setLocale('en')
  return render(<SpotifyDestinationOutcome destination={destination} focusOnSettle={false} />)
}

describe('SpotifyDestinationOutcome', () => {
  it('announces a save in progress', () => {
    renderOutcome({ status: 'publishing' })

    expect(screen.getByText('Saving to Spotify…')).toBeVisible()
  })

  it('confirms a published playlist, with the Library note and a cover notice when relevant', () => {
    renderOutcome({
      status: 'published',
      spotifyUrl: URL,
      savedToLibrary: true,
      spotifyId: 'playlist-1',
      coverUploadFailed: true,
    })

    expect(screen.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(
      screen.getByText('The playlist is now in your Spotify account and your Library.'),
    ).toBeVisible()
    expect(screen.getByText('Couldn’t add the cover.')).toBeVisible()
    expect(screen.getByRole('link', { name: /Open in Spotify/ })).toHaveAttribute('href', URL)
  })

  it('accepts a published destination without the newer optional fields', () => {
    renderOutcome({ status: 'published', spotifyUrl: URL, savedToLibrary: false, spotifyId: 'playlist-1', coverUploadFailed: false })

    expect(screen.getByText('The playlist is now in your Spotify account.')).toBeVisible()
    expect(screen.queryByText('Couldn’t add the cover.')).toBeNull()
  })

  it.each([
    ['outcome_unknown', null, /may exist in your account\. Check Spotify/],
    ['tracks_incomplete', URL, /some songs may be missing/],
    ['library_not_saved', URL, /couldn’t add it to your Library/],
    ['interrupted', null, /Saving was interrupted/],
    ['interrupted', URL, /Saving was interrupted/],
  ] as const)('explains the incomplete reason %s (link: %s)', (reason, spotifyUrl, message) => {
    renderOutcome({ status: 'publish_incomplete', spotifyUrl, reason })

    expect(screen.getByRole('heading', { name: 'Couldn’t finish saving to Spotify' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('button', { name: /Save to Spotify/ })).toBeNull()
    if (spotifyUrl) {
      expect(screen.getByRole('link', { name: /Open in Spotify/ })).toHaveAttribute('href', spotifyUrl)
    } else {
      expect(screen.queryByRole('link')).toBeNull()
    }
  })

  it('refuses an unsafe link', () => {
    renderOutcome({ status: 'published', spotifyUrl: 'javascript:alert(1)', savedToLibrary: false, spotifyId: 'playlist-1', coverUploadFailed: false })

    expect(screen.queryByRole('link')).toBeNull()
  })
})
