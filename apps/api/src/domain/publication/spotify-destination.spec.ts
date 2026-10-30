import { BusinessRuleError } from '@/domain/errors/business-rule.error';
import { PlaylistPublishIncompleteError } from '@/domain/errors/playlist-publish-incomplete.error';
import { ProviderOutcomeUnknownError } from '@/domain/errors/provider-outcome-unknown.error';
import { SpotifyProviderError } from '@/domain/errors/spotify-provider.error';
import { SpotifyReauthRequiredError } from '@/domain/errors/spotify-reauth-required.error';
import {
  classifyPublicationFailure,
  completePublication,
  failPublication,
  interruptPublication,
  isSettled,
  recordRemoteCreated,
  startPublication,
  type SpotifyDestination,
} from './spotify-destination';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const LATER = new Date('2026-10-30T12:00:05.000Z');
const LINK = { spotifyId: 'p1', spotifyUrl: 'https://open.spotify.com/p1' };

function incompleteAfter(step: 'add_tracks' | 'save_to_library') {
  return new PlaylistPublishIncompleteError({
    spotifyId: LINK.spotifyId,
    spotifyUrl: LINK.spotifyUrl,
    failedStep: step,
    tracksAdded: step === 'save_to_library' ? 'all' : 'unknown',
  });
}

describe('Spotify destination transitions', () => {
  it('starts an attempt as publishing without a playlist', () => {
    expect(startPublication('attempt-a', NOW)).toEqual({
      status: 'publishing',
      attemptId: 'attempt-a',
      startedAt: NOW.toISOString(),
      spotifyPlaylist: null,
    });
  });

  it('records the remote playlist on the same attempt', () => {
    const publishing = startPublication('attempt-a', NOW);

    expect(recordRemoteCreated(publishing, LINK)).toEqual({
      ...publishing,
      spotifyPlaylist: LINK,
    });
  });

  it('completes a publication with its Library and cover state', () => {
    expect(
      completePublication(
        {
          spotifyPlaylist: LINK,
          savedToLibrary: true,
          coverUploadFailed: true,
        },
        LATER,
      ),
    ).toEqual({
      status: 'published',
      publishedAt: LATER.toISOString(),
      spotifyPlaylist: LINK,
      savedToLibrary: true,
      coverUploadFailed: true,
    });
  });

  it.each([
    'outcome_unknown',
    'tracks_incomplete',
    'library_not_saved',
  ] as const)(
    'settles a failed attempt as incomplete with reason %s and keeps any known link',
    (reason) => {
      const withoutLink = startPublication('attempt-a', NOW);
      const withLink = recordRemoteCreated(withoutLink, LINK);

      expect(failPublication(withoutLink, reason, LATER)).toEqual({
        status: 'publish_incomplete',
        failedAt: LATER.toISOString(),
        spotifyPlaylist: null,
        reason,
      });
      expect(failPublication(withLink, reason, LATER)).toMatchObject({
        spotifyPlaylist: LINK,
        reason,
      });
    },
  );

  it('settles an abandoned attempt as interrupted, keeping its link', () => {
    const abandoned = recordRemoteCreated(
      startPublication('attempt-a', NOW),
      LINK,
    );

    expect(interruptPublication(abandoned, LATER)).toEqual({
      status: 'publish_incomplete',
      failedAt: LATER.toISOString(),
      spotifyPlaylist: LINK,
      reason: 'interrupted',
    });
  });

  it('treats only published and incomplete destinations as settled', () => {
    const publishing = startPublication('attempt-a', NOW);
    const destinations: [SpotifyDestination | null, boolean][] = [
      [null, false],
      [publishing, false],
      [
        completePublication(
          {
            spotifyPlaylist: LINK,
            savedToLibrary: false,
            coverUploadFailed: false,
          },
          LATER,
        ),
        true,
      ],
      [failPublication(publishing, 'outcome_unknown', LATER), true],
    ];

    for (const [destination, settled] of destinations) {
      expect(isSettled(destination)).toBe(settled);
    }
  });
});

describe('classifyPublicationFailure', () => {
  it.each([
    [
      'a Spotify rejection',
      new SpotifyProviderError('SPOTIFY_REQUEST_REJECTED', {
        operation: 'createPlaylist',
        category: 'rejected',
        status: 400,
      }),
    ],
    ['a reauthorization requirement', new SpotifyReauthRequiredError()],
    [
      'a Spotify quota rejection',
      new BusinessRuleError('Spotify is busy', 'SPOTIFY_RATE_LIMITED'),
    ],
    [
      'an exhausted Spotify quota',
      new BusinessRuleError('Quota exceeded', 'SPOTIFY_QUOTA_EXCEEDED'),
    ],
  ])('allows a retry after %s before creation', (_label, error) => {
    expect(classifyPublicationFailure(error, false)).toEqual({
      kind: 'confirmed_not_created',
    });
  });

  it.each([
    ['an unknown provider outcome', new ProviderOutcomeUnknownError('timeout')],
    ['a generic Error', new Error('socket hang up')],
    ['a TypeError', new TypeError('undefined is not a function')],
    [
      'an unrelated business rule',
      new BusinessRuleError('User not found', 'USER_NOT_FOUND'),
    ],
    ['a non-Error value', 'boom'],
  ])(
    'treats %s before creation as an unknown outcome, never as retryable',
    (_label, error) => {
      expect(classifyPublicationFailure(error, false)).toEqual({
        kind: 'incomplete',
        reason: 'outcome_unknown',
      });
    },
  );

  it.each([
    ['an add-tracks failure', incompleteAfter('add_tracks')],
    [
      'a Spotify rejection',
      new SpotifyProviderError('SPOTIFY_REQUEST_REJECTED', {
        operation: 'addTracks',
        category: 'rejected',
        status: 400,
      }),
    ],
    ['an unknown outcome', new ProviderOutcomeUnknownError('timeout')],
    ['an unexpected error', new Error('boom')],
  ])(
    'reports missing tracks after %s once the playlist exists',
    (_label, error) => {
      expect(classifyPublicationFailure(error, true)).toEqual({
        kind: 'incomplete',
        reason: 'tracks_incomplete',
      });
    },
  );

  it('reports a Library failure on a complete playlist', () => {
    expect(
      classifyPublicationFailure(incompleteAfter('save_to_library'), true),
    ).toEqual({ kind: 'incomplete', reason: 'library_not_saved' });
  });
});
