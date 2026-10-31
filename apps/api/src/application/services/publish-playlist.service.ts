import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  PlaylistDetail,
  PlaylistPublishStep,
  PlaylistTracksAddedState,
} from '@blendify/contracts';
import { PlaylistPublishIncompleteError } from '@/domain/errors/playlist-publish-incomplete.error';
import { isConfirmedRejection } from '@/domain/publication/spotify-destination';
import {
  PLAYLIST_REPOSITORY,
  type PlaylistRepositoryPort,
} from '@/domain/repositories/playlist.repository.port';
import type {
  MusicProviderPort,
  ProviderPlaylist,
} from '@/domain/repositories/music-provider.port';
import { Playlist } from '@/domain/playlist/playlist.entity';
import { toPlaylistDetail } from '@/application/dto/playlist-response.dto';

export type PublishedPlaylist = PlaylistDetail & {
  coverUploadFailed?: boolean;
};

@Injectable()
export class PublishPlaylistService {
  private readonly logger = new Logger(PublishPlaylistService.name);

  constructor(
    @Inject(PLAYLIST_REPOSITORY)
    private readonly playlists: PlaylistRepositoryPort,
  ) {}

  async execute(input: {
    playlist: Playlist;
    provider: MusicProviderPort;
    spotifyUserId: string;
    coverImageBase64?: string;
    persistToLibrary: boolean;
    onRemotePlaylistCreated?: (remote: ProviderPlaylist) => Promise<void>;
  }): Promise<PublishedPlaylist> {
    const { playlist, provider } = input;
    const remote = await provider.createPlaylist({
      userId: input.spotifyUserId,
      name: playlist.name.getValue(),
      description: playlist.description,
      isPublic: false,
    });
    await input.onRemotePlaylistCreated?.(remote);

    await this.completeStep(remote, 'add_tracks', () =>
      provider.addTracksToPlaylist(
        remote.id,
        playlist.tracks.map((track) => track.uri),
      ),
    );

    let coverUploadFailed = false;
    if (input.coverImageBase64) {
      try {
        await provider.uploadPlaylistCover(remote.id, input.coverImageBase64);
      } catch (error) {
        coverUploadFailed = true;
        this.logger.warn(
          `Playlist cover upload failed: ${errorMessage(error)}`,
        );
      }
    }

    playlist.linkToSpotify(remote.id, remote.url);
    try {
      const snapshot = await provider.getPlaylistSnapshot(remote.id);
      playlist.setImageUrl(snapshot?.imageUrl);
    } catch (error) {
      this.logger.warn(`Playlist image lookup failed: ${errorMessage(error)}`);
    }
    playlist.markCompleted();

    const result = input.persistToLibrary
      ? await this.completeStep(remote, 'save_to_library', () =>
          this.playlists.save(playlist),
        )
      : playlist;
    return {
      ...toPlaylistDetail(result),
      ...(coverUploadFailed ? { coverUploadFailed } : {}),
    };
  }

  private async completeStep<T>(
    remote: ProviderPlaylist,
    failedStep: PlaylistPublishStep,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const tracksAdded = tracksAddedAfter(failedStep, error);
      this.logger.warn(
        JSON.stringify({
          event: 'playlist_publish_incomplete',
          failedStep,
          tracksAdded,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        }),
      );
      throw new PlaylistPublishIncompleteError(
        {
          spotifyId: remote.id,
          spotifyUrl: remote.url,
          failedStep,
          tracksAdded,
        },
        { cause: error },
      );
    }
  }
}

function tracksAddedAfter(
  failedStep: PlaylistPublishStep,
  error: unknown,
): PlaylistTracksAddedState {
  if (failedStep === 'save_to_library') {
    return 'all';
  }
  return isConfirmedRejection(error) ? 'none' : 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
