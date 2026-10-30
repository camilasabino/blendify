import { AiSessionStateSchema } from '@blendify/contracts';
import { EMPTY_AI_PRESERVATION } from '@/domain/ai/ai-intent-patch';
import {
  AI_SESSION_RECORD_VERSION,
  type AiSession,
  type AiSessionDestination,
} from '@/domain/ai/ai-session';
import { toAiSessionStateResponse } from './ai-generation-response.dto';

const NOW = new Date();
const LINK = { spotifyId: 'p1', spotifyUrl: 'https://open.spotify.com/p1' };

function session(destination: AiSessionDestination): AiSession {
  return {
    version: AI_SESSION_RECORD_VERSION,
    ownerUserId: 'user-1',
    originalPrompt: 'Shoegaze',
    promptVersion: 'intent-v3',
    aiSafe: { intent: null, preservation: EMPTY_AI_PRESERVATION },
    clarification: null,
    execution: null,
    destination,
    refinementAttempts: 0,
    pendingRefinement: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
  };
}

function publicDestination(destination: AiSessionDestination) {
  const response = toAiSessionStateResponse('token', session(destination), {
    transferEnabled: false,
  });
  return AiSessionStateSchema.parse(response).destination;
}

describe('AI session destination response', () => {
  it('keeps the legacy published shape when the cover upload failed', () => {
    expect(
      publicDestination({
        status: 'published',
        publishedAt: NOW.toISOString(),
        spotifyPlaylist: LINK,
        savedToLibrary: true,
        coverUploadFailed: true,
      }),
    ).toEqual({
      status: 'published',
      spotifyUrl: LINK.spotifyUrl,
      savedToLibrary: true,
    });
  });

  it.each([
    ['outcome_unknown', null],
    ['tracks_incomplete', LINK],
    ['library_not_saved', LINK],
    ['interrupted', LINK],
  ] as const)(
    'keeps the legacy incomplete shape for reason %s without exposing it',
    (reason, spotifyPlaylist) => {
      expect(
        publicDestination({
          status: 'publish_incomplete',
          failedAt: NOW.toISOString(),
          spotifyPlaylist,
          reason,
        }),
      ).toEqual({
        status: 'publish_incomplete',
        spotifyUrl: spotifyPlaylist?.spotifyUrl ?? null,
      });
    },
  );

  it('keeps the legacy publishing shape without the attempt id', () => {
    expect(
      publicDestination({
        status: 'publishing',
        attemptId: 'attempt-a',
        startedAt: NOW.toISOString(),
        spotifyPlaylist: LINK,
      }),
    ).toEqual({ status: 'publishing' });
  });
});
