import { Logger } from '@nestjs/common';
import {
  SpotifyPreviewSchema,
  SpotifyPreviewStateSchema,
} from '@blendify/contracts';
import { BusinessRuleError } from '@/domain/errors/business-rule.error';
import { CoordinationUnavailableError } from '@/domain/errors/coordination-unavailable.error';
import { PlaylistPublishIncompleteError } from '@/domain/errors/playlist-publish-incomplete.error';
import { PreviewError } from '@/domain/errors/preview.error';
import { ProviderOutcomeUnknownError } from '@/domain/errors/provider-outcome-unknown.error';
import { SpotifyProviderError } from '@/domain/errors/spotify-provider.error';
import { GeneratedPlaylist } from '@/domain/playlist/generated-playlist';
import {
  SPOTIFY_PREVIEW_MAX_BYTES,
  SPOTIFY_PREVIEW_TTL_MS,
} from '@/domain/preview/spotify-preview.policy';
import { DESTINATION_LEASE_MS } from '@/application/services/destination-lease.policy';
import { makeTrack } from './generation-world.testing';
import {
  OWNER,
  REMOTE,
  createPreviewWorld,
  deferredPublish,
  flush,
  memoryPreviewRepository,
  previewPlaylist,
} from './spotify-preview-world.testing';
import type { PlaylistGenerationRequest } from './generate-playlist.use-case';

const REQUEST = {
  kind: 'artist_mix',
  artistIds: ['sade'],
  tracksPerSeed: 3,
  popularity: 'balanced',
  orderMode: 'random',
  name: '',
  description: '',
  filters: {
    region: null,
    femaleVocals: false,
    releaseRange: null,
    excludeLive: false,
  },
} as PlaylistGenerationRequest;

const SAVE = { name: 'Late night', persistToLibrary: true } as const;

function generated(titles: string[] = ['Z', 'A', 'M']): GeneratedPlaylist {
  const stored = previewPlaylist();
  return GeneratedPlaylist.create({
    name: stored.name,
    description: stored.description,
    generation: stored.generation,
    seeds: stored.seeds,
    tracks: titles.map((title) => makeTrack('Sade', title)),
  });
}

function generator(playlist: GeneratedPlaylist = generated()) {
  return { execute: jest.fn(() => Promise.resolve(playlist)) };
}

async function createPreview(
  world: ReturnType<typeof createPreviewWorld>,
  userId = OWNER.id,
) {
  return world.create(generator()).execute({ userId, request: REQUEST });
}

describe('Spotify preview use cases', () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('CreateSpotifyPreviewUseCase', () => {
    it('stores the generated playlist for its owner with a fixed 30 minute lifetime', async () => {
      const world = createPreviewWorld();

      const preview = await createPreview(world);

      expect(SpotifyPreviewSchema.safeParse(preview).success).toBe(true);
      expect(preview.expiresAt).toBe('2026-10-30T12:30:00.000Z');
      expect(SPOTIFY_PREVIEW_TTL_MS).toBe(30 * 60_000);
      await expect(
        world.repository.find(preview.previewId),
      ).resolves.toMatchObject({
        ownerUserId: OWNER.id,
        expiresAt: preview.expiresAt,
        playlist: { name: preview.playlist.name },
      });
    });

    it('keeps the generated tracks in their generated order', async () => {
      const world = createPreviewWorld();

      const preview = await createPreview(world);
      const stored = await world.repository.find(preview.previewId);

      const expected = ['Z', 'A', 'M'].map(
        (title) => makeTrack('Sade', title).uri,
      );
      expect(preview.playlist.tracks.map((track) => track.uri)).toEqual(
        expected,
      );
      expect(stored?.playlist.tracks.map((track) => track.uri)).toEqual(
        expected,
      );
    });

    it('does not touch Spotify, the Library or usage stats', async () => {
      const world = createPreviewWorld();

      await createPreview(world);

      expect(world.publish).not.toHaveBeenCalled();
      expect(world.providers.forUser).not.toHaveBeenCalled();
      expect(world.quota.consume).not.toHaveBeenCalled();
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();
    });

    it('forwards progress to the generator', async () => {
      const world = createPreviewWorld();
      const source = generator();
      const onProgress = jest.fn();

      await world
        .create(source)
        .execute({ userId: OWNER.id, request: REQUEST }, { onProgress });

      expect(source.execute).toHaveBeenCalledWith(REQUEST, { onProgress });
    });

    it('stores nothing when generation fails', async () => {
      const world = createPreviewWorld();
      const failing = {
        execute: jest.fn(() =>
          Promise.reject(BusinessRuleError.noTracksFound()),
        ),
      };
      const create = jest.spyOn(world.repository, 'create');

      await expect(
        world.create(failing).execute({ userId: OWNER.id, request: REQUEST }),
      ).rejects.toMatchObject({ code: 'NO_TRACKS_FOUND' });

      expect(create).not.toHaveBeenCalled();
    });

    it('stores nothing for an empty generation', async () => {
      const world = createPreviewWorld();
      const create = jest.spyOn(world.repository, 'create');

      await expect(
        world
          .create(generator(generated([])))
          .execute({ userId: OWNER.id, request: REQUEST }),
      ).rejects.toMatchObject({ code: 'NO_TRACKS_FOUND' });

      expect(create).not.toHaveBeenCalled();
    });

    it('rejects a record above the size cap without storing it', async () => {
      const world = createPreviewWorld();
      const create = jest.spyOn(world.repository, 'create');
      const base = generated();
      const huge = GeneratedPlaylist.create({
        name: base.name,
        generation: base.generation,
        seeds: [...base.seeds],
        tracks: [...base.tracks],
        description: 'x'.repeat(SPOTIFY_PREVIEW_MAX_BYTES),
      });

      await expect(
        world
          .create(generator(huge))
          .execute({ userId: OWNER.id, request: REQUEST }),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);

      expect(create).not.toHaveBeenCalled();
    });

    it('fails closed when the store is unavailable in production', async () => {
      const world = createPreviewWorld(memoryPreviewRepository('fail-closed'));

      await expect(createPreview(world)).rejects.toBeInstanceOf(
        CoordinationUnavailableError,
      );
    });
  });

  describe('GetSpotifyPreviewUseCase', () => {
    it('returns the stored playlist for its owner, without a destination', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);

      const state = await world.get.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
      });

      expect(SpotifyPreviewStateSchema.safeParse(state).success).toBe(true);
      expect(state).toMatchObject({
        previewId: preview.previewId,
        expiresAt: preview.expiresAt,
        destination: null,
        playlist: { name: preview.playlist.name },
      });
    });

    it('does not extend the preview lifetime when it is read', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);

      jest.setSystemTime(Date.now() + SPOTIFY_PREVIEW_TTL_MS - 1_000);
      const state = await world.get.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
      });
      expect(state.expiresAt).toBe(preview.expiresAt);

      jest.setSystemTime(Date.now() + 2_000);
      await expect(
        world.get.execute({ previewId: preview.previewId, userId: OWNER.id }),
      ).rejects.toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
    });

    it('answers unknown, expired and foreign ids with the same not found error', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const failures: unknown[] = [];

      for (const command of [
        { previewId: 'A'.repeat(22), userId: OWNER.id },
        { previewId: preview.previewId, userId: 'user-2' },
      ]) {
        failures.push(
          await world.get.execute(command).catch((e: unknown) => e),
        );
      }
      jest.setSystemTime(Date.now() + SPOTIFY_PREVIEW_TTL_MS + 1);
      failures.push(
        await world.get
          .execute({ previewId: preview.previewId, userId: OWNER.id })
          .catch((e: unknown) => e),
      );

      for (const failure of failures) {
        expect(failure).toBeInstanceOf(PreviewError);
        expect(failure).toMatchObject({
          code: 'PREVIEW_NOT_FOUND',
          message: PreviewError.notFound().message,
        });
      }
    });

    it('hides a retained outcome from another user', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      await world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });

      await expect(
        world.get.execute({ previewId: preview.previewId, userId: 'user-2' }),
      ).rejects.toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
    });

    it('settles an abandoned attempt as interrupted in the view without persisting it', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const pending = deferredPublish(world);
      const running = world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });
      await flush();
      await pending[0].createRemote();
      jest.setSystemTime(Date.now() + DESTINATION_LEASE_MS + 1);

      const state = await world.get.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
      });

      expect(state.destination).toEqual({
        status: 'publish_incomplete',
        spotifyUrl: REMOTE.url,
        reason: 'interrupted',
      });
      await expect(
        world.repository.findDestination(preview.previewId),
      ).resolves.toMatchObject({ destination: { status: 'publishing' } });

      pending[0].succeed();
      await running;
    });

    it('fails closed instead of showing an interrupted save when the claim check is unavailable', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const pending = deferredPublish(world);
      const running = world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });
      await flush();
      jest
        .spyOn(world.repository, 'hasSaveClaim')
        .mockRejectedValueOnce(new CoordinationUnavailableError());

      await expect(
        world.get.execute({
          previewId: preview.previewId,
          userId: OWNER.id,
        }),
      ).rejects.toBeInstanceOf(CoordinationUnavailableError);
      await expect(
        world.repository.findDestination(preview.previewId),
      ).resolves.toMatchObject({ destination: { status: 'publishing' } });

      pending[0].succeed();
      await running;
    });

    it('reports a save in progress while the claim is held', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const pending = deferredPublish(world);
      const running = world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });
      await flush();

      const state = await world.get.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
      });

      expect(state.destination).toEqual({ status: 'publishing' });
      expect(state.playlist).not.toBeNull();

      pending[0].succeed();
      await running;
    });
  });

  describe('SaveSpotifyPreviewUseCase', () => {
    it('publishes exactly the stored tracks in their stored order with the requested name', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);

      const state = await world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        name: 'Late night',
        coverImageBase64: 'cover',
        persistToLibrary: false,
      });

      expect(world.publish).toHaveBeenCalledTimes(1);
      const input = world.publish.mock.calls[0][0];
      expect(input.playlist.tracks.map((track) => track.uri)).toEqual(
        preview.playlist.tracks.map((track) => track.uri),
      );
      expect(input.playlist.name.getValue()).toBe('Late night');
      expect(input.playlist.description).toBe(preview.playlist.description);
      expect(input.playlist.generation).toEqual(preview.playlist.generation);
      expect(input.coverImageBase64).toBe('cover');
      expect(input.persistToLibrary).toBe(false);
      expect(state.destination).toMatchObject({
        status: 'published',
        spotifyUrl: REMOTE.url,
        savedToLibrary: false,
        spotifyId: REMOTE.id,
        coverUploadFailed: false,
      });
      expect(SpotifyPreviewStateSchema.safeParse(state).success).toBe(true);
    });

    it('never regenerates or queries the catalog', async () => {
      const world = createPreviewWorld();
      const source = generator();
      const preview = await world
        .create(source)
        .execute({ userId: OWNER.id, request: REQUEST });
      source.execute.mockClear();

      await world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });

      expect(source.execute).not.toHaveBeenCalled();
    });

    it('records usage stats once on publication and nothing for unsaved previews', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      expect(world.usageStats.recordMix).not.toHaveBeenCalled();

      const command = {
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      };
      await world.save.execute(command);
      await world.save.execute(command);

      expect(world.usageStats.recordMix).toHaveBeenCalledTimes(1);
      expect(world.usageStats.recordMix).toHaveBeenCalledWith(
        expect.objectContaining({ userId: OWNER.id, kind: 'artist' }),
      );
    });

    it('reuses a settled outcome without calling Spotify, the quota or the user store again', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const command = {
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      };
      const first = await world.save.execute(command);
      world.users.findById.mockClear();

      const second = await world.save.execute({ ...command, name: 'Other' });

      expect(second.destination).toEqual(first.destination);
      expect(world.publish).toHaveBeenCalledTimes(1);
      expect(world.quota.consume).toHaveBeenCalledTimes(1);
      expect(world.users.findById).not.toHaveBeenCalled();
    });

    it('coordinates concurrent saves so only one reaches Spotify', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const pending = deferredPublish(world);
      const command = {
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      };

      const first = world.save.execute(command);
      await flush();
      const duplicates = await Promise.allSettled([
        world.save.execute(command),
        world.save.execute(command),
      ]);
      pending[0].succeed();
      const settled = await first;

      for (const duplicate of duplicates) {
        expect(duplicate).toMatchObject({
          status: 'rejected',
          reason: { code: 'PREVIEW_SAVE_IN_PROGRESS' },
        });
      }
      expect(world.publish).toHaveBeenCalledTimes(1);
      expect(world.quota.consume).toHaveBeenCalledTimes(1);
      expect(settled.destination?.status).toBe('published');
    });

    it('lets exactly one of many simultaneous saves publish', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const command = {
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      };

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => world.save.execute(command)),
      );

      expect(world.publish).toHaveBeenCalledTimes(1);
      expect(
        results.filter(
          (result) =>
            result.status === 'fulfilled' &&
            result.value.destination?.status === 'published',
        ).length,
      ).toBeGreaterThanOrEqual(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({
            code: 'PREVIEW_SAVE_IN_PROGRESS',
          });
        }
      }
    });

    it('answers unknown, expired and foreign previews with the same not found error and no side effects', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);

      const unknown = await world.save
        .execute({ previewId: 'B'.repeat(22), userId: OWNER.id, ...SAVE })
        .catch((e: unknown) => e);
      const foreign = await world.save
        .execute({ previewId: preview.previewId, userId: 'user-2', ...SAVE })
        .catch((e: unknown) => e);
      jest.setSystemTime(Date.now() + SPOTIFY_PREVIEW_TTL_MS + 1);
      const expired = await world.save
        .execute({ previewId: preview.previewId, userId: OWNER.id, ...SAVE })
        .catch((e: unknown) => e);

      for (const failure of [unknown, foreign, expired]) {
        expect(failure).toMatchObject({
          code: 'PREVIEW_NOT_FOUND',
          message: PreviewError.notFound().message,
        });
      }
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.quota.consume).not.toHaveBeenCalled();
    });

    it('keeps the outcome readable when the preview expires during publication', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const pending = deferredPublish(world);
      const running = world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });
      await flush();
      await pending[0].createRemote();

      jest.setSystemTime(Date.now() + SPOTIFY_PREVIEW_TTL_MS + 1);
      pending[0].succeed();
      const saved = await running;

      expect(saved.destination?.status).toBe('published');
      const afterExpiry = await world.get.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
      });
      expect(afterExpiry).toMatchObject({
        playlist: null,
        expiresAt: preview.expiresAt,
        destination: { status: 'published', spotifyUrl: REMOTE.url },
      });
      const repeat = await world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });
      expect(repeat.destination?.status).toBe('published');
      expect(world.publish).toHaveBeenCalledTimes(1);
    });

    it('does not let the outcome outlive 24 hours', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      await world.save.execute({
        previewId: preview.previewId,
        userId: OWNER.id,
        ...SAVE,
      });

      jest.setSystemTime(Date.now() + 24 * 60 * 60_000 - 1_000);
      await expect(
        world.get.execute({ previewId: preview.previewId, userId: OWNER.id }),
      ).resolves.toMatchObject({ destination: { status: 'published' } });

      jest.setSystemTime(Date.now() + 2_000);
      await expect(
        world.get.execute({ previewId: preview.previewId, userId: OWNER.id }),
      ).rejects.toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
    });

    it('does not publish when the preview expired between the first read and the claim', async () => {
      const world = createPreviewWorld();
      const preview = await createPreview(world);
      const realFind = world.repository.find.bind(world.repository);
      jest
        .spyOn(world.repository, 'find')
        .mockImplementationOnce(realFind)
        .mockResolvedValueOnce(null);

      await expect(
        world.save.execute({
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        }),
      ).rejects.toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
      expect(world.publish).not.toHaveBeenCalled();
      expect(world.quota.consume).not.toHaveBeenCalled();
    });

    describe('quota and failures', () => {
      it('leaves no destination and releases the claim when the quota rejects', async () => {
        const world = createPreviewWorld();
        const preview = await createPreview(world);
        world.quota.consume.mockRejectedValueOnce(
          Object.assign(new Error('limited'), { code: 'RATE_LIMITED' }),
        );
        const command = {
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        };

        await expect(world.save.execute(command)).rejects.toMatchObject({
          code: 'RATE_LIMITED',
        });

        expect(world.publish).not.toHaveBeenCalled();
        await expect(
          world.repository.findDestination(preview.previewId),
        ).resolves.toBeNull();
        await expect(
          world.repository.hasSaveClaim(preview.previewId),
        ).resolves.toBe(false);
        await expect(world.save.execute(command)).resolves.toMatchObject({
          destination: { status: 'published' },
        });
      });

      it('allows a retry, charging the quota again, after a confirmed pre-creation rejection', async () => {
        const world = createPreviewWorld();
        const preview = await createPreview(world);
        world.publish.mockRejectedValueOnce(
          new SpotifyProviderError('SPOTIFY_REQUEST_REJECTED', {
            operation: 'createPlaylist',
            category: 'rejected',
            status: 400,
          }),
        );
        const command = {
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        };

        await expect(world.save.execute(command)).rejects.toBeInstanceOf(
          SpotifyProviderError,
        );
        await expect(
          world.repository.findDestination(preview.previewId),
        ).resolves.toBeNull();

        await expect(world.save.execute(command)).resolves.toMatchObject({
          destination: { status: 'published' },
        });
        expect(world.quota.consume).toHaveBeenCalledTimes(2);
        expect(world.publish).toHaveBeenCalledTimes(2);
      });

      it('settles an ambiguous create as outcome_unknown and never retries it', async () => {
        const world = createPreviewWorld();
        const preview = await createPreview(world);
        world.publish.mockRejectedValueOnce(
          new ProviderOutcomeUnknownError('createPlaylist'),
        );
        const command = {
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        };

        const first = await world.save.execute(command);
        const second = await world.save.execute(command);

        expect(first.destination).toEqual({
          status: 'publish_incomplete',
          spotifyUrl: null,
          reason: 'outcome_unknown',
        });
        expect(second.destination).toEqual(first.destination);
        expect(world.publish).toHaveBeenCalledTimes(1);
        expect(world.usageStats.recordMix).not.toHaveBeenCalled();
      });

      it('settles an unexpected create error as ambiguous', async () => {
        const world = createPreviewWorld();
        const preview = await createPreview(world);
        world.publish.mockRejectedValueOnce(new TypeError('unexpected'));

        const state = await world.save.execute({
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        });

        expect(state.destination).toMatchObject({
          status: 'publish_incomplete',
          reason: 'outcome_unknown',
        });
      });

      it.each([
        ['add_tracks', 'tracks_incomplete'],
        ['save_to_library', 'library_not_saved'],
      ] as const)(
        'settles a %s failure after creation as %s with the playlist link',
        async (failedStep, reason) => {
          const world = createPreviewWorld();
          const preview = await createPreview(world);
          world.publish.mockImplementationOnce(async (input) => {
            await input.onRemotePlaylistCreated?.(REMOTE);
            throw new PlaylistPublishIncompleteError({
              spotifyId: REMOTE.id,
              spotifyUrl: REMOTE.url,
              failedStep,
              tracksAdded: failedStep === 'add_tracks' ? 'unknown' : 'all',
            });
          });
          const command = {
            previewId: preview.previewId,
            userId: OWNER.id,
            ...SAVE,
          };

          const state = await world.save.execute(command);
          const again = await world.save.execute(command);

          expect(state.destination).toEqual({
            status: 'publish_incomplete',
            spotifyUrl: REMOTE.url,
            reason,
          });
          expect(again.destination).toEqual(state.destination);
          expect(world.publish).toHaveBeenCalledTimes(1);
        },
      );

      it('keeps a cover upload failure as a published outcome', async () => {
        const world = createPreviewWorld();
        const preview = await createPreview(world);
        world.publish.mockImplementationOnce(async (input) => {
          await input.onRemotePlaylistCreated?.(REMOTE);
          return {
            spotifyId: REMOTE.id,
            spotifyUrl: REMOTE.url,
            coverUploadFailed: true,
          } as never;
        });

        const state = await world.save.execute({
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        });

        expect(state.destination).toMatchObject({
          status: 'published',
          coverUploadFailed: true,
        });
      });

      it('recovers an interrupted attempt as incomplete without creating a duplicate', async () => {
        const world = createPreviewWorld();
        const preview = await createPreview(world);
        const pending = deferredPublish(world);
        const command = {
          previewId: preview.previewId,
          userId: OWNER.id,
          ...SAVE,
        };
        const abandoned = world.save.execute(command);
        await flush();
        await pending[0].createRemote();
        jest.setSystemTime(Date.now() + DESTINATION_LEASE_MS + 1);

        const recovered = await world.save.execute(command);

        expect(recovered.destination).toEqual({
          status: 'publish_incomplete',
          spotifyUrl: REMOTE.url,
          reason: 'interrupted',
        });
        expect(world.publish).toHaveBeenCalledTimes(1);
        expect(world.quota.consume).toHaveBeenCalledTimes(1);

        pending[0].succeed();
        await abandoned;
        const final = await world.get.execute({
          previewId: preview.previewId,
          userId: OWNER.id,
        });
        expect(final.destination).toMatchObject({
          status: 'publish_incomplete',
          reason: 'interrupted',
        });
      });
    });

    describe('when the store is unavailable in production', () => {
      it('fails closed before calling Spotify', async () => {
        const live = createPreviewWorld();
        const preview = await createPreview(live);
        const world = createPreviewWorld(
          memoryPreviewRepository('fail-closed'),
        );

        await expect(
          world.save.execute({
            previewId: preview.previewId,
            userId: OWNER.id,
            ...SAVE,
          }),
        ).rejects.toBeInstanceOf(CoordinationUnavailableError);

        expect(world.publish).not.toHaveBeenCalled();
        expect(world.quota.consume).not.toHaveBeenCalled();
      });
    });
  });
});
