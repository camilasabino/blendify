import {
  DiscoverArtistRequestSchema,
  DiscoverTrackRequestSchema,
} from '@blendify/contracts';
import { z } from 'zod';

export const GenerateDiscoverPlaylistSchema = z
  .discriminatedUnion('kind', [
    DiscoverArtistRequestSchema,
    DiscoverTrackRequestSchema,
  ])
  .and(
    z.object({
      market: z.string().optional(),
    }),
  );

export type GenerateDiscoverPlaylistDto = z.input<
  typeof GenerateDiscoverPlaylistSchema
>;
