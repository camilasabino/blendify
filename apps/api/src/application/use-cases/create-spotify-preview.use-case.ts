import { Inject, Injectable } from '@nestjs/common';
import type { SpotifyPreviewDto } from '@blendify/contracts';
import { BusinessRuleError } from '@/domain/errors/business-rule.error';
import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import {
  createSpotifyPreview,
  type SpotifyPreview,
} from '@/domain/preview/spotify-preview';
import {
  SPOTIFY_PREVIEW_MAX_BYTES,
  SPOTIFY_PREVIEW_TTL_MS,
} from '@/domain/preview/spotify-preview.policy';
import {
  SPOTIFY_PREVIEW_REPOSITORY,
  type SpotifyPreviewRepositoryPort,
} from '@/domain/repositories/spotify-preview.repository.port';
import { toTrackResponse } from '@/application/dto/playlist-response.dto';
import { toSpotifyPreviewResponse } from '@/application/dto/spotify-preview-response.dto';
import type { ProgressReporter } from '@/application/services/generation-progress.tracker';
import { logPreviewCreated } from '@/application/services/spotify-preview-observability';
import {
  GeneratePlaylistUseCase,
  type PlaylistGenerationRequest,
} from './generate-playlist.use-case';

@Injectable()
export class CreateSpotifyPreviewUseCase {
  constructor(
    private readonly generator: GeneratePlaylistUseCase,
    @Inject(SPOTIFY_PREVIEW_REPOSITORY)
    private readonly previews: SpotifyPreviewRepositoryPort,
  ) {}

  async execute(
    input: { userId: string; request: PlaylistGenerationRequest },
    options?: { onProgress?: ProgressReporter },
  ): Promise<SpotifyPreviewDto> {
    const generated = await this.generator.execute(
      input.request,
      options?.onProgress ? { onProgress: options.onProgress } : undefined,
    );
    if (generated.tracks.length === 0) {
      throw BusinessRuleError.noTracksFound();
    }

    const preview = createSpotifyPreview(
      {
        ownerUserId: input.userId,
        playlist: {
          name: generated.name,
          description: generated.description,
          generation: generated.generation,
          seeds: [...generated.seeds],
          tracks: generated.tracks.map(toTrackResponse),
          ...(generated.coverArtwork
            ? { coverArtwork: { ...generated.coverArtwork } }
            : {}),
        },
      },
      new Date(),
    );
    assertWithinSizeCap(preview);

    await this.previews.create(preview, SPOTIFY_PREVIEW_TTL_MS);
    logPreviewCreated({
      kind: generated.generation.kind,
      trackCount: generated.tracks.length,
    });
    return toSpotifyPreviewResponse(preview);
  }
}

function assertWithinSizeCap(preview: SpotifyPreview): void {
  if (Buffer.byteLength(JSON.stringify(preview)) > SPOTIFY_PREVIEW_MAX_BYTES) {
    throw new CoordinationUnavailableError();
  }
}
