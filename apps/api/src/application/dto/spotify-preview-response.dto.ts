import type {
  SpotifyDestinationDto,
  SpotifyPreviewDto,
  SpotifyPreviewStateDto,
} from '@blendify/contracts';
import type {
  SpotifyPreview,
  SpotifyPreviewPlaylist,
} from '@/domain/preview/spotify-preview';
import type {
  IncompleteSpotifyDestination,
  PublishedSpotifyDestination,
  PublishingSpotifyDestination,
} from '@/domain/publication/spotify-destination';

export type StoredSpotifyDestination =
  | PublishingSpotifyDestination
  | (Omit<PublishedSpotifyDestination, 'coverUploadFailed'> &
      Partial<Pick<PublishedSpotifyDestination, 'coverUploadFailed'>>)
  | (Omit<IncompleteSpotifyDestination, 'reason'> &
      Partial<Pick<IncompleteSpotifyDestination, 'reason'>>);

export function toSpotifyPreviewPlaylistResponse(
  playlist: SpotifyPreviewPlaylist,
): SpotifyPreviewDto['playlist'] {
  return {
    name: playlist.name,
    description: playlist.description,
    generation: playlist.generation,
    seeds: playlist.seeds,
    tracks: playlist.tracks,
    ...(playlist.coverArtwork
      ? { coverArtwork: { ...playlist.coverArtwork } }
      : {}),
  };
}

export function toSpotifyPreviewResponse(
  preview: SpotifyPreview,
): SpotifyPreviewDto {
  return {
    previewId: preview.id,
    expiresAt: preview.expiresAt,
    playlist: toSpotifyPreviewPlaylistResponse(preview.playlist),
  };
}

export function toSpotifyPreviewStateResponse(view: {
  previewId: string;
  expiresAt: string;
  playlist: SpotifyPreviewPlaylist | null;
  destination: StoredSpotifyDestination | null;
}): SpotifyPreviewStateDto {
  return {
    previewId: view.previewId,
    expiresAt: view.expiresAt,
    playlist: view.playlist
      ? toSpotifyPreviewPlaylistResponse(view.playlist)
      : null,
    destination: view.destination
      ? toSpotifyDestinationResponse(view.destination)
      : null,
  };
}

// AI sessions persisted before reason and coverUploadFailed existed lack both fields.
export function toSpotifyDestinationResponse(
  destination: StoredSpotifyDestination,
): SpotifyDestinationDto {
  switch (destination.status) {
    case 'publishing':
      return { status: 'publishing' };
    case 'published':
      return {
        status: 'published',
        spotifyUrl: destination.spotifyPlaylist.spotifyUrl,
        savedToLibrary: destination.savedToLibrary,
        ...(destination.spotifyPlaylist.spotifyId
          ? { spotifyId: destination.spotifyPlaylist.spotifyId }
          : {}),
        ...(destination.coverUploadFailed === undefined
          ? {}
          : { coverUploadFailed: destination.coverUploadFailed }),
      };
    case 'publish_incomplete':
      return {
        status: 'publish_incomplete',
        spotifyUrl: destination.spotifyPlaylist?.spotifyUrl ?? null,
        ...(destination.reason ? { reason: destination.reason } : {}),
      };
  }
}
