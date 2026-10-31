import { Inject, Injectable } from '@nestjs/common';
import type { SpotifyPreviewStateDto } from '@blendify/contracts';
import { PreviewError } from '@/domain/errors/preview.error';
import type { SpotifyPreviewDestinationRecord } from '@/domain/preview/spotify-preview';
import {
  interruptPublication,
  type SpotifyDestination,
} from '@/domain/publication/spotify-destination';
import {
  SPOTIFY_PREVIEW_REPOSITORY,
  type SpotifyPreviewRepositoryPort,
} from '@/domain/repositories/spotify-preview.repository.port';
import { toSpotifyPreviewStateResponse } from '@/application/dto/spotify-preview-response.dto';
import {
  readableDestination,
  readableLivePreview,
} from '@/application/services/spotify-preview-access';

@Injectable()
export class GetSpotifyPreviewUseCase {
  constructor(
    @Inject(SPOTIFY_PREVIEW_REPOSITORY)
    private readonly previews: SpotifyPreviewRepositoryPort,
  ) {}

  async execute(command: {
    previewId: string;
    userId: string;
  }): Promise<SpotifyPreviewStateDto> {
    const now = new Date();
    const record = readableDestination(
      await this.previews.findDestination(command.previewId),
      command.userId,
    );
    const preview = readableLivePreview(
      await this.previews.find(command.previewId),
      command.userId,
      now,
    );

    const destination = record ? await this.destinationView(record) : null;
    if (!preview && !destination) {
      throw PreviewError.notFound();
    }
    return toSpotifyPreviewStateResponse({
      previewId: command.previewId,
      expiresAt: preview?.expiresAt ?? record?.previewExpiresAt ?? '',
      playlist: preview?.playlist ?? null,
      destination,
    });
  }

  private async destinationView(
    record: SpotifyPreviewDestinationRecord,
  ): Promise<SpotifyDestination | null> {
    const { destination } = record;
    if (
      destination.status !== 'publishing' ||
      (await this.previews.hasSaveClaim(record.previewId))
    ) {
      return destination;
    }

    const current = await this.previews.findDestination(record.previewId);
    if (
      current?.destination.status === 'publishing' &&
      current.destination.attemptId === destination.attemptId
    ) {
      return interruptPublication(current.destination, new Date());
    }
    return current?.destination ?? null;
  }
}
