import { randomBytes } from 'node:crypto';
import type {
  PlaylistGeneration,
  PlaylistSeedDto,
  TrackDto,
} from '@blendify/contracts';
import type { SpotifyDestination } from '@/domain/publication/spotify-destination';
import { SPOTIFY_PREVIEW_TTL_MS } from './spotify-preview.policy';

export const SPOTIFY_PREVIEW_RECORD_VERSION = 2;

const PREVIEW_ID_BYTES = 16;

export interface SpotifyPreviewPlaylist {
  name: string;
  description: string;
  generation: PlaylistGeneration;
  seeds: PlaylistSeedDto[];
  tracks: TrackDto[];
  coverArtwork?: { imageUrl: string; spotifyUrl: string };
}

export interface SpotifyPreview {
  version: typeof SPOTIFY_PREVIEW_RECORD_VERSION;
  id: string;
  ownerUserId: string;
  playlist: SpotifyPreviewPlaylist;
  createdAt: string;
  expiresAt: string;
}

export interface SpotifyPreviewDestinationRecord {
  version: typeof SPOTIFY_PREVIEW_RECORD_VERSION;
  previewId: string;
  ownerUserId: string;
  previewExpiresAt: string;
  destination: SpotifyDestination;
  updatedAt: string;
}

export function generatePreviewId(): string {
  return randomBytes(PREVIEW_ID_BYTES).toString('base64url');
}

export function createSpotifyPreview(
  input: { ownerUserId: string; playlist: SpotifyPreviewPlaylist },
  now: Date,
): SpotifyPreview {
  return {
    version: SPOTIFY_PREVIEW_RECORD_VERSION,
    id: generatePreviewId(),
    ownerUserId: input.ownerUserId,
    playlist: input.playlist,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SPOTIFY_PREVIEW_TTL_MS).toISOString(),
  };
}

export function isReadableBy(
  record: { ownerUserId: string },
  userId: string,
): boolean {
  return record.ownerUserId === userId;
}

export function isPreviewLive(preview: SpotifyPreview, now: Date): boolean {
  return Date.parse(preview.expiresAt) > now.getTime();
}

export function destinationRecordFor(
  preview: Pick<SpotifyPreview, 'id' | 'ownerUserId' | 'expiresAt'>,
  destination: SpotifyDestination,
  now: Date,
): SpotifyPreviewDestinationRecord {
  return {
    version: SPOTIFY_PREVIEW_RECORD_VERSION,
    previewId: preview.id,
    ownerUserId: preview.ownerUserId,
    previewExpiresAt: preview.expiresAt,
    destination,
    updatedAt: now.toISOString(),
  };
}

export function withDestination(
  record: SpotifyPreviewDestinationRecord,
  destination: SpotifyDestination,
  now: Date,
): SpotifyPreviewDestinationRecord {
  return { ...record, destination, updatedAt: now.toISOString() };
}
