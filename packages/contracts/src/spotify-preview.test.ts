import { describe, expect, it } from 'vitest';
import {
  AiSessionDestinationSchema,
  AiSessionStateSchema,
  GenerateMixRequestSchema,
  PublishAiPlaylistRequestSchema,
  SPOTIFY_PREVIEW_ERROR_CODES,
  SPOTIFY_PUBLISH_INCOMPLETE_REASONS,
  SaveToSpotifyRequestSchema,
  SpotifyDestinationSchema,
  SpotifyPreviewIdSchema,
  SpotifyPreviewSchema,
  SpotifyPreviewStateSchema,
  SpotifyPreviewStreamEventSchema,
} from './index';

const PREVIEW_ID = 'AbCdEfGhIjKlMnOpQrSt_-';
const EXPIRES_AT = '2026-10-30T12:30:00.000Z';

const PLAYLIST = {
  name: 'Blendify · Mix · Sade',
  description: 'Made with Blendify from Sade.',
  generation: {
    version: 1,
    kind: 'artist_mix',
    tracksPerSeed: 1,
    seeds: [{ id: 'artist-1', name: 'Sade' }],
    filters: {
      region: null,
      femaleVocals: false,
      releaseRange: null,
      excludeLive: false,
    },
    popularity: 'balanced',
    orderMode: 'random',
  },
  seeds: [{ type: 'artist', id: 'artist-1', name: 'Sade' }],
  tracks: [
    {
      id: 'track-1',
      name: 'Smooth Operator',
      artistId: 'artist-1',
      artistName: 'Sade',
      durationMs: 250_000,
      popularity: 0,
      uri: 'spotify:track:track-1',
    },
  ],
};

describe('Spotify preview contracts', () => {
  it('accepts only 128-bit base64url preview ids', () => {
    expect(SpotifyPreviewIdSchema.safeParse(PREVIEW_ID).success).toBe(true);
    for (const invalid of [
      '',
      'short',
      `${PREVIEW_ID}x`,
      'AbCdEfGhIjKlMnOpQrSt+/',
      'AbCdEfGhIjKlMnOpQrSt=',
    ]) {
      expect(SpotifyPreviewIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('parses a preview and strips any transfer offer', () => {
    const parsed = SpotifyPreviewSchema.parse({
      previewId: PREVIEW_ID,
      expiresAt: EXPIRES_AT,
      playlist: {
        ...PLAYLIST,
        transfer: { token: 't', expiresAt: EXPIRES_AT },
      },
    });

    expect(parsed.playlist).toEqual(PLAYLIST);
    expect(parsed.playlist).not.toHaveProperty('transfer');
  });

  it('rejects unknown preview fields', () => {
    expect(
      SpotifyPreviewSchema.safeParse({
        previewId: PREVIEW_ID,
        expiresAt: EXPIRES_AT,
        playlist: PLAYLIST,
        ownerUserId: 'user-1',
      }).success,
    ).toBe(false);
  });

  it('streams progress, result and error events', () => {
    const result = {
      type: 'result',
      playlist: {
        previewId: PREVIEW_ID,
        expiresAt: EXPIRES_AT,
        playlist: PLAYLIST,
      },
    };

    expect(SpotifyPreviewStreamEventSchema.parse(result)).toEqual(result);
    expect(
      SpotifyPreviewStreamEventSchema.parse({
        type: 'progress',
        phase: 'matching_tracks',
        current: 1,
        total: 2,
        percent: 50,
      }),
    ).toMatchObject({ type: 'progress' });
    expect(
      SpotifyPreviewStreamEventSchema.parse({
        type: 'error',
        statusCode: 422,
        code: 'NO_TRACKS_FOUND',
        message: 'No tracks found.',
      }),
    ).toMatchObject({ type: 'error' });
    expect(
      SpotifyPreviewStreamEventSchema.safeParse({
        type: 'result',
        playlist: PLAYLIST,
      }).success,
    ).toBe(false);
  });

  it('keeps a state with an expired playlist but a retained outcome', () => {
    const state = {
      previewId: PREVIEW_ID,
      expiresAt: EXPIRES_AT,
      playlist: null,
      destination: {
        status: 'published',
        spotifyUrl: 'https://open.spotify.com/playlist/p1',
        savedToLibrary: true,
        spotifyId: 'p1',
        coverUploadFailed: false,
      },
    };

    expect(SpotifyPreviewStateSchema.parse(state)).toEqual(state);
    expect(
      SpotifyPreviewStateSchema.parse({
        ...state,
        playlist: PLAYLIST,
        destination: null,
      }).destination,
    ).toBeNull();
    expect(
      SpotifyPreviewStateSchema.safeParse({ ...state, extra: true }).success,
    ).toBe(false);
  });
});

describe('Spotify destination contract', () => {
  it('parses every destination status', () => {
    const published = {
      status: 'published',
      spotifyUrl: 'https://open.spotify.com/playlist/p1',
      savedToLibrary: false,
      spotifyId: 'p1',
      coverUploadFailed: false,
    };
    const incomplete = { status: 'publish_incomplete', spotifyUrl: null };

    for (const destination of [
      { status: 'publishing' },
      published,
      { ...published, coverUploadFailed: true },
      ...SPOTIFY_PUBLISH_INCOMPLETE_REASONS.map((reason) => ({
        ...incomplete,
        reason,
      })),
    ]) {
      expect(SpotifyDestinationSchema.parse(destination)).toEqual(destination);
    }
  });

  it('requires the fields of a settled destination', () => {
    for (const invalid of [
      {
        status: 'published',
        spotifyUrl: null,
        savedToLibrary: true,
        coverUploadFailed: false,
      },
      {
        status: 'published',
        spotifyUrl: null,
        savedToLibrary: true,
        spotifyId: 'p1',
      },
      { status: 'publish_incomplete', spotifyUrl: null },
    ]) {
      expect(SpotifyDestinationSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('rejects unknown reasons, statuses and fields', () => {
    for (const invalid of [
      { status: 'publish_incomplete', spotifyUrl: null, reason: 'other' },
      { status: 'transfer_prepared' },
      { status: 'publishing', spotifyUrl: 'https://sp/p1' },
    ]) {
      expect(SpotifyDestinationSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('is the Spotify subset of the AI destination', () => {
    for (const destination of [
      { status: 'publishing' },
      {
        status: 'published',
        spotifyUrl: null,
        savedToLibrary: true,
        spotifyId: 'p1',
        coverUploadFailed: false,
      },
      { status: 'publish_incomplete', spotifyUrl: null, reason: 'interrupted' },
    ]) {
      expect(AiSessionDestinationSchema.parse(destination)).toEqual(
        destination,
      );
    }
    expect(
      AiSessionDestinationSchema.parse({
        status: 'transfer_prepared',
        transfer: {
          url: 'https://soundiiz.com/t/1',
          expiresAt: EXPIRES_AT,
          trackCount: 1,
        },
      }).status,
    ).toBe('transfer_prepared');
    expect(AiSessionStateSchema.shape.destination).toBeDefined();
  });
});

describe('Save to Spotify request contract', () => {
  it('is the same contract AI publish uses', () => {
    expect(PublishAiPlaylistRequestSchema).toBe(SaveToSpotifyRequestSchema);
  });

  it('accepts only the permitted publication fields', () => {
    expect(
      SaveToSpotifyRequestSchema.parse({ name: '  Late night  ' }),
    ).toMatchObject({ name: 'Late night' });

    for (const extra of [
      { tracks: [] },
      { seeds: [] },
      { generation: {} },
      { description: 'x' },
      { kind: 'artist_mix' },
    ]) {
      expect(
        SaveToSpotifyRequestSchema.safeParse({ name: 'Mix', ...extra }).success,
      ).toBe(false);
    }
    expect(SaveToSpotifyRequestSchema.safeParse({ name: '  ' }).success).toBe(
      false,
    );
  });
});

describe('Spotify preview error codes', () => {
  it('lists the preview-specific codes', () => {
    expect(SPOTIFY_PREVIEW_ERROR_CODES).toEqual([
      'PREVIEW_NOT_FOUND',
      'PREVIEW_SAVE_IN_PROGRESS',
    ]);
  });

  it('keeps publication fields out of generation requests', () => {
    expect(
      GenerateMixRequestSchema.safeParse({
        kind: 'artist_mix',
        artistIds: ['a'],
        tracksPerSeed: 5,
        popularity: 'balanced',
        persistToLibrary: true,
      }).success,
    ).toBe(false);
  });
});
