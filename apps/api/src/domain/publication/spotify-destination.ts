import { PlaylistPublishIncompleteError } from '@/domain/errors/playlist-publish-incomplete.error';
import { SpotifyProviderError } from '@/domain/errors/spotify-provider.error';
import { SpotifyReauthRequiredError } from '@/domain/errors/spotify-reauth-required.error';
import { isSpotifyQuotaError } from '@/domain/genre/catalog-resolve';

export interface SpotifyPlaylistLink {
  spotifyId: string;
  spotifyUrl: string | null;
}

export type SpotifyPublishIncompleteReason =
  'outcome_unknown' | 'tracks_incomplete' | 'library_not_saved' | 'interrupted';

export interface PublishingSpotifyDestination {
  status: 'publishing';
  attemptId: string;
  startedAt: string;
  spotifyPlaylist: SpotifyPlaylistLink | null;
}

export interface PublishedSpotifyDestination {
  status: 'published';
  publishedAt: string;
  spotifyPlaylist: SpotifyPlaylistLink;
  savedToLibrary: boolean;
  coverUploadFailed: boolean;
}

export interface IncompleteSpotifyDestination {
  status: 'publish_incomplete';
  failedAt: string;
  spotifyPlaylist: SpotifyPlaylistLink | null;
  reason: SpotifyPublishIncompleteReason;
}

export type SettledSpotifyDestination =
  PublishedSpotifyDestination | IncompleteSpotifyDestination;

export type SpotifyDestination =
  PublishingSpotifyDestination | SettledSpotifyDestination;

export type PublicationFailure =
  | { kind: 'confirmed_not_created' }
  | { kind: 'incomplete'; reason: SpotifyPublishIncompleteReason };

export function startPublication(
  attemptId: string,
  now: Date,
): PublishingSpotifyDestination {
  return {
    status: 'publishing',
    attemptId,
    startedAt: now.toISOString(),
    spotifyPlaylist: null,
  };
}

export function recordRemoteCreated(
  destination: PublishingSpotifyDestination,
  spotifyPlaylist: SpotifyPlaylistLink,
): PublishingSpotifyDestination {
  return { ...destination, spotifyPlaylist };
}

export function completePublication(
  published: {
    spotifyPlaylist: SpotifyPlaylistLink;
    savedToLibrary: boolean;
    coverUploadFailed: boolean;
  },
  now: Date,
): PublishedSpotifyDestination {
  return {
    status: 'published',
    publishedAt: now.toISOString(),
    ...published,
  };
}

export function failPublication(
  destination: PublishingSpotifyDestination,
  reason: SpotifyPublishIncompleteReason,
  now: Date,
): IncompleteSpotifyDestination {
  return {
    status: 'publish_incomplete',
    failedAt: now.toISOString(),
    spotifyPlaylist: destination.spotifyPlaylist,
    reason,
  };
}

export function interruptPublication(
  destination: PublishingSpotifyDestination,
  now: Date,
): IncompleteSpotifyDestination {
  return failPublication(destination, 'interrupted', now);
}

export function isSettled(
  destination: { status: string } | null,
): destination is SettledSpotifyDestination {
  return (
    destination?.status === 'published' ||
    destination?.status === 'publish_incomplete'
  );
}

export function classifyPublicationFailure(
  error: unknown,
  remoteCreated: boolean,
): PublicationFailure {
  if (!remoteCreated) {
    return isConfirmedRejection(error)
      ? { kind: 'confirmed_not_created' }
      : { kind: 'incomplete', reason: 'outcome_unknown' };
  }
  if (
    error instanceof PlaylistPublishIncompleteError &&
    error.details.failedStep === 'save_to_library'
  ) {
    return { kind: 'incomplete', reason: 'library_not_saved' };
  }
  return { kind: 'incomplete', reason: 'tracks_incomplete' };
}

export function isConfirmedRejection(error: unknown): boolean {
  return (
    error instanceof SpotifyProviderError ||
    error instanceof SpotifyReauthRequiredError ||
    isSpotifyQuotaError(error)
  );
}
