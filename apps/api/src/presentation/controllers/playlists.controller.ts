import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BulkLibraryRequestSchema,
  DeletePlaylistQuerySchema,
  PlaylistLibraryQuerySchema,
  RenamePlaylistRequestSchema,
  type DeletePlaylistQuery,
  type PlaylistLibraryQuery,
} from '@blendify/contracts';
import type { z } from 'zod';
import { JwtAuthGuard } from '@/infrastructure/auth/jwt-auth.guard';
import { ListLibraryPlaylistsUseCase } from '@/application/use-cases/list-library-playlists.use-case';
import { SyncLibraryUseCase } from '@/application/use-cases/sync-library.use-case';
import { GetPlaylistDetailUseCase } from '@/application/use-cases/get-playlist-detail.use-case';
import { RenamePlaylistUseCase } from '@/application/use-cases/rename-playlist.use-case';
import { RemovePlaylistFromLibraryUseCase } from '@/application/use-cases/remove-playlist-from-library.use-case';
import { BulkLibraryUseCase } from '@/application/use-cases/bulk-library.use-case';
import { CurrentUser } from '@/presentation/decorators/current-user.decorator';
import { ZodValidationPipe } from '@/presentation/pipes/zod-validation.pipe';
import { User } from '@/domain/user/user.entity';

type RenameRequest = z.output<typeof RenamePlaylistRequestSchema>;
type BulkRequest = z.output<typeof BulkLibraryRequestSchema>;

@ApiTags('playlists')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/playlists')
export class PlaylistsController {
  constructor(
    private readonly library: ListLibraryPlaylistsUseCase,
    private readonly sync: SyncLibraryUseCase,
    private readonly detail: GetPlaylistDetailUseCase,
    private readonly rename: RenamePlaylistUseCase,
    private readonly remove: RemovePlaylistFromLibraryUseCase,
    private readonly bulk: BulkLibraryUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List saved Blendify playlists' })
  list(
    @CurrentUser() user: User,
    @Query(new ZodValidationPipe(PlaylistLibraryQuerySchema))
    query: PlaylistLibraryQuery,
  ) {
    return this.library.execute(user.id, {
      limit: query.limit,
      offset: query.offset,
      q: query.q,
    });
  }

  @Post('sync')
  @ApiOperation({
    summary: 'Reconcile the entire Blendify Library against Spotify',
  })
  syncLibrary(@CurrentUser() user: User) {
    return this.sync.execute(user.id);
  }

  @Post('bulk')
  @ApiOperation({ summary: 'Run a bulk action on saved playlists' })
  bulkLibrary(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(BulkLibraryRequestSchema)) body: BulkRequest,
  ) {
    return this.bulk.execute(user.id, body.action, {
      q: body.q,
      playlistIds: body.playlistIds,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a saved playlist with its tracks' })
  getDetail(@CurrentUser() user: User, @Param('id') id: string) {
    return this.detail.execute(user.id, id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a playlist in Blendify and Spotify' })
  renamePlaylist(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenamePlaylistRequestSchema))
    body: RenameRequest,
  ) {
    return this.rename.execute(user.id, id, body.name);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a playlist from Blendify and optionally Spotify',
  })
  async deletePlaylist(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query(new ZodValidationPipe(DeletePlaylistQuerySchema))
    query: DeletePlaylistQuery,
  ) {
    await this.remove.execute(user.id, id, {
      fromSpotify: query.fromSpotify,
    });
    return { ok: true as const };
  }
}
