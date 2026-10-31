import { Module } from '@nestjs/common';
import { BulkLibraryUseCase } from '@/application/use-cases/bulk-library.use-case';
import { RemovePlaylistFromLibraryUseCase } from '@/application/use-cases/remove-playlist-from-library.use-case';
import { GetPlaylistDetailUseCase } from '@/application/use-cases/get-playlist-detail.use-case';
import { ListLibraryPlaylistsUseCase } from '@/application/use-cases/list-library-playlists.use-case';
import { SyncLibraryUseCase } from '@/application/use-cases/sync-library.use-case';
import { RenamePlaylistUseCase } from '@/application/use-cases/rename-playlist.use-case';
import { CreateSpotifyPreviewUseCase } from '@/application/use-cases/create-spotify-preview.use-case';
import { GetSpotifyPreviewUseCase } from '@/application/use-cases/get-spotify-preview.use-case';
import { SaveSpotifyPreviewUseCase } from '@/application/use-cases/save-spotify-preview.use-case';
import { SPOTIFY_PREVIEW_REPOSITORY } from '@/domain/repositories/spotify-preview.repository.port';
import { RedisSpotifyPreviewRepository } from '@/infrastructure/preview/redis-spotify-preview.repository';
import { PreviewsController } from '@/presentation/controllers/previews.controller';
import { PlaylistsController } from '@/presentation/controllers/playlists.controller';
import { GenerationModule } from './generation.module';
import { PublicationModule } from './publication.module';

@Module({
  imports: [GenerationModule, PublicationModule],
  controllers: [PlaylistsController, PreviewsController],
  providers: [
    CreateSpotifyPreviewUseCase,
    GetSpotifyPreviewUseCase,
    SaveSpotifyPreviewUseCase,
    RedisSpotifyPreviewRepository,
    {
      provide: SPOTIFY_PREVIEW_REPOSITORY,
      useExisting: RedisSpotifyPreviewRepository,
    },
    ListLibraryPlaylistsUseCase,
    SyncLibraryUseCase,
    GetPlaylistDetailUseCase,
    RenamePlaylistUseCase,
    RemovePlaylistFromLibraryUseCase,
    BulkLibraryUseCase,
  ],
})
export class PlaylistsModule {}
