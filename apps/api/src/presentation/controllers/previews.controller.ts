import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  GenerateDiscoverRequestSchema,
  GenerateMixRequestSchema,
  SaveToSpotifyRequestSchema,
  SpotifyPreviewIdSchema,
  type SpotifyPreviewDto,
  type SpotifyPreviewStateDto,
} from '@blendify/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { JwtAuthGuard } from '@/infrastructure/auth/jwt-auth.guard';
import type { ProgressReporter } from '@/application/services/generation-progress.tracker';
import { CreateSpotifyPreviewUseCase } from '@/application/use-cases/create-spotify-preview.use-case';
import { GetSpotifyPreviewUseCase } from '@/application/use-cases/get-spotify-preview.use-case';
import { SaveSpotifyPreviewUseCase } from '@/application/use-cases/save-spotify-preview.use-case';
import { PreviewError } from '@/domain/errors/preview.error';
import type { User } from '@/domain/user/user.entity';
import { CurrentUser } from '@/presentation/decorators/current-user.decorator';
import {
  acceptsNdjson,
  writeNdjsonGeneration,
} from '@/presentation/http/ndjson-generation';
import { ZodValidationPipe } from '@/presentation/pipes/zod-validation.pipe';
import { LimitGenerationConcurrency } from '@/presentation/request-limits/generation-concurrency.interceptor';
import { RateLimit } from '@/presentation/request-limits/rate-limit.guard';

type MixRequest = z.output<typeof GenerateMixRequestSchema>;
type DiscoverRequest = z.output<typeof GenerateDiscoverRequestSchema>;
type SaveBody = z.output<typeof SaveToSpotifyRequestSchema>;

@ApiTags('previews')
@ApiCookieAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/previews')
export class PreviewsController {
  constructor(
    private readonly createPreview: CreateSpotifyPreviewUseCase,
    private readonly getPreview: GetSpotifyPreviewUseCase,
    private readonly savePreview: SaveSpotifyPreviewUseCase,
  ) {}

  @Post('mix')
  @RateLimit('generation')
  @LimitGenerationConcurrency()
  @ApiOperation({ summary: 'Generate a Spotify Mode mix preview' })
  generateMix(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(GenerateMixRequestSchema)) body: MixRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(user.id, body, req, res);
  }

  @Post('discover')
  @RateLimit('generation')
  @LimitGenerationConcurrency()
  @ApiOperation({ summary: 'Generate a Spotify Mode discovery preview' })
  generateDiscover(
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(GenerateDiscoverRequestSchema))
    body: DiscoverRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(user.id, body, req, res);
  }

  @Get(':previewId')
  @ApiOperation({ summary: 'Read a preview and its save outcome' })
  find(
    @CurrentUser() user: User,
    @Param('previewId') previewId: string,
  ): Promise<SpotifyPreviewStateDto> {
    return this.getPreview.execute({
      previewId: requirePreviewId(previewId),
      userId: user.id,
    });
  }

  @Post(':previewId/save')
  @HttpCode(HttpStatus.OK)
  @LimitGenerationConcurrency()
  @ApiOperation({ summary: 'Save a preview to Spotify' })
  save(
    @CurrentUser() user: User,
    @Param('previewId') previewId: string,
    @Body(new ZodValidationPipe(SaveToSpotifyRequestSchema)) body: SaveBody,
  ): Promise<SpotifyPreviewStateDto> {
    return this.savePreview.execute({
      previewId: requirePreviewId(previewId),
      userId: user.id,
      name: body.name,
      coverImageBase64: body.coverImageBase64,
      persistToLibrary: body.persistToLibrary,
    });
  }

  private async respond(
    userId: string,
    request: MixRequest | DiscoverRequest,
    req: Request,
    res: Response,
  ): Promise<SpotifyPreviewDto | void> {
    if (!acceptsNdjson(req)) {
      return this.generate(userId, request);
    }
    await writeNdjsonGeneration(res, (onProgress) =>
      this.generate(userId, request, onProgress),
    );
  }

  private generate(
    userId: string,
    request: MixRequest | DiscoverRequest,
    onProgress?: ProgressReporter,
  ): Promise<SpotifyPreviewDto> {
    return this.createPreview.execute(
      { userId, request },
      onProgress ? { onProgress } : undefined,
    );
  }
}

function requirePreviewId(previewId: string): string {
  if (!SpotifyPreviewIdSchema.safeParse(previewId).success) {
    throw PreviewError.notFound();
  }
  return previewId;
}
