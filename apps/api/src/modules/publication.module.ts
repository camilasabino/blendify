import { Module } from '@nestjs/common';
import { PublishPlaylistService } from '@/application/services/publish-playlist.service';
import { SpotifyPublicationRunner } from '@/application/services/spotify-publication.runner';

@Module({
  providers: [PublishPlaylistService, SpotifyPublicationRunner],
  exports: [PublishPlaylistService, SpotifyPublicationRunner],
})
export class PublicationModule {}
