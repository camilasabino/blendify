import { guestJazzPlaylist, jazzPreview, publishedDestination } from '@/test/playlist-fixtures'
import {
  hasUnsavedPreview,
  isRunBusy,
  usePlaylistRunStore,
  type PlaylistRunSpec,
} from '@/stores/playlist-run-store'

const spec: PlaylistRunSpec = {
  feature: 'mix',
  mode: 'spotify',
  request: {
    kind: 'genre_mix',
    name: 'Jazz',
    description: '',
    genreIds: ['jazz'],
    popularity: 'balanced',
    tracksPerSeed: 1,
    orderMode: 'random',
  },
}

const discoverSpec: PlaylistRunSpec = {
  feature: 'discover',
  mode: 'spotify',
  request: {
    kind: 'discover_artist',
    artistId: 'artist-1',
    artist: { id: 'artist-1', name: 'Sade', imageUrl: null },
    description: '',
    targetTrackCount: 30,
    popularity: 'balanced',
    orderMode: 'random',
  },
}

const guestSpec: PlaylistRunSpec = { ...spec, mode: 'guest' }

const outcome = { mode: 'spotify', preview: jazzPreview() } as const
const guestOutcome = { mode: 'guest', playlist: guestJazzPlaylist } as const
const progress = {
  phase: 'matching_tracks',
  current: 1,
  total: 2,
  percent: 50,
} as const

function store() {
  return usePlaylistRunStore.getState()
}

function previewReady(nextSpec: PlaylistRunSpec = spec) {
  const { id } = store().begin(nextSpec)!
  store().succeed(id, outcome)
  return id
}

function session() {
  const { run } = store()
  return run?.status.phase === 'succeeded' ? run.status.spotify : null
}

afterEach(() => {
  store().discard()
  vi.useRealTimers()
})

describe('playlist run store', () => {
  it('starts an active run with no progress and hands out a live signal', () => {
    const started = store().begin(spec)

    expect(started).not.toBeNull()
    expect(started?.signal.aborted).toBe(false)
    expect(store().run).toMatchObject({
      id: started?.id,
      spec,
      status: { phase: 'active', progress: null, previous: null },
    })
  })

  it('refuses a second run while one is active and leaves it untouched', () => {
    const first = store().begin(spec)
    const second = store().begin(discoverSpec)

    expect(second).toBeNull()
    expect(first?.signal.aborted).toBe(false)
    expect(store().run?.spec.feature).toBe('mix')
  })

  it('records progress only for the active run', () => {
    const { id } = store().begin(spec)!

    store().reportProgress(id, progress)
    expect(store().run?.status).toMatchObject({ phase: 'active', progress })

    store().reportProgress(id + 1, { ...progress, percent: 99 })
    expect(store().run?.status).toMatchObject({ phase: 'active', progress })
  })

  it('succeeds exactly once and rejects a duplicate terminal event', () => {
    const { id } = store().begin(spec)!

    expect(store().succeed(id, outcome)).toBe(true)
    expect(store().run).toMatchObject({
      status: { phase: 'succeeded', outcome },
      seen: false,
    })
    expect(store().succeed(id, outcome)).toBe(false)
    expect(store().fail(id, new Error('late'))).toBe(false)
    expect(store().run?.status.phase).toBe('succeeded')
  })

  it('starts a Spotify preview as an unsaved session titled after the playlist', () => {
    previewReady()

    expect(session()).toMatchObject({
      title: outcome.preview.playlist.name,
      coverOption: true,
      hadSaveAttempt: false,
      save: { phase: 'idle' },
    })
    expect(hasUnsavedPreview(store().run)).toBe(true)
  })

  it('keeps Guest runs free of a Spotify session', () => {
    const { id } = store().begin(guestSpec)!
    store().succeed(id, guestOutcome)

    expect(session()).toBeNull()
    expect(hasUnsavedPreview(store().run)).toBe(false)
  })

  it('allows a new run once the previous one reached a terminal state', () => {
    const first = store().begin(spec)!
    store().fail(first.id, new Error('boom'))
    expect(store().run?.status.phase).toBe('failed')

    const second = store().begin(spec)

    expect(second?.id).toBeGreaterThan(first.id)
    expect(store().run?.status.phase).toBe('active')
  })

  it('ignores results of a run that was replaced or discarded', () => {
    const first = store().begin(spec)!
    store().discard()
    const second = store().begin(spec)!

    expect(first.signal.aborted).toBe(true)
    expect(store().succeed(first.id, outcome)).toBe(false)
    expect(store().fail(first.id, new Error('late'))).toBe(false)
    expect(store().run).toMatchObject({
      id: second.id,
      status: { phase: 'active' },
    })
  })

  it('discard aborts the request and clears the run', () => {
    const { signal } = store().begin(spec)!

    store().discard()

    expect(signal.aborted).toBe(true)
    expect(store().run).toBeNull()
    expect(store().controller).toBeNull()
  })

  it('marks a terminal run as seen and re-arms it on the next transition', () => {
    const id = previewReady()

    store().markSeen(id)
    expect(store().run?.seen).toBe(true)

    store().markSeen(id + 1)
    expect(store().run?.seen).toBe(true)

    store().beginSave(id)
    store().settleSave(id, publishedDestination)
    expect(store().run?.seen).toBe(false)
  })

  it('restores a finished Guest run as already seen, only when no run exists', () => {
    expect(store().restore(guestSpec, guestOutcome, null)).toBe(true)
    expect(store().run).toMatchObject({
      spec: guestSpec,
      seen: true,
      status: { phase: 'succeeded', outcome: guestOutcome, transfer: null },
    })

    expect(store().restore(discoverSpec, guestOutcome, null)).toBe(false)
    expect(store().run?.spec.feature).toBe('mix')
  })

  it('attaches a prepared transfer only to the same finished run', () => {
    const transfer = {
      url: 'https://soundiiz.com/go/import-playlist/abcdefghijklmnop',
      expiresAt: '2099-01-01T00:00:00.000Z',
      trackCount: 1,
    }
    const { id } = store().begin(guestSpec)!

    store().attachTransfer(id, transfer)
    expect(store().run?.status.phase).toBe('active')

    store().succeed(id, guestOutcome)
    store().attachTransfer(id + 1, transfer)
    expect(store().run?.status).toMatchObject({ transfer: null })

    store().attachTransfer(id, transfer)
    expect(store().run?.status).toMatchObject({ transfer })
  })
})

describe('Spotify preview session', () => {
  it('edits the title and the cover option only while the preview is unsaved', () => {
    const id = previewReady()

    store().setTitle(id, 'Evening jazz')
    store().setCoverOption(id, false)
    expect(session()).toMatchObject({ title: 'Evening jazz', coverOption: false })

    store().beginSave(id)
    store().setTitle(id, 'Changed while saving')
    store().setCoverOption(id, true)
    expect(session()).toMatchObject({ title: 'Evening jazz', coverOption: false })
  })

  it('starts a save exactly once and hands out the stored identifier and final title', () => {
    const id = previewReady()
    store().setTitle(id, 'Evening jazz')

    const first = store().beginSave(id)
    const second = store().beginSave(id)

    expect(first).toMatchObject({
      previewId: outcome.preview.previewId,
      title: 'Evening jazz',
      coverOption: true,
    })
    expect(second).toBeNull()
    expect(session()?.save).toEqual({ phase: 'saving' })
    expect(isRunBusy(store().run)).toBe(true)
  })

  it('refuses to save an invalid title', () => {
    const id = previewReady()

    store().setTitle(id, '   ')
    expect(store().beginSave(id)).toBeNull()

    store().setTitle(id, 'x'.repeat(101))
    expect(store().beginSave(id)).toBeNull()
    expect(session()?.save).toEqual({ phase: 'idle' })
  })

  it('refuses to save once the preview expired', () => {
    const id = previewReady()
    store().expireUnsaved(id)

    expect(store().beginSave(id)).toBeNull()
    expect(session()?.save).toEqual({ phase: 'expired', mayHaveSaved: false })
  })

  it('returns to an unsaved preview after a confirmed failure and allows saving again', () => {
    const id = previewReady()
    store().beginSave(id)
    const error = new Error('rejected')

    expect(store().failSave(id, error, null)).toBe(true)

    expect(session()?.save).toEqual({ phase: 'failed', error, retryAt: null })
    expect(hasUnsavedPreview(store().run)).toBe(true)
    expect(store().beginSave(id)).not.toBeNull()
  })

  it('settles a save once and ignores later outcomes', () => {
    const id = previewReady()
    store().beginSave(id)

    expect(store().settleSave(id, publishedDestination)).toBe(true)
    expect(store().settleSave(id, { status: 'publish_incomplete', spotifyUrl: null, reason: 'outcome_unknown' })).toBe(false)
    expect(store().failSave(id, new Error('late'), null)).toBe(false)

    expect(session()?.save).toMatchObject({
      phase: 'settled',
      destination: { status: 'published' },
    })
  })

  it('moves between saving and reconciling and can pause the polling', () => {
    const id = previewReady()
    store().beginSave(id)

    const signal = store().beginReconcile(id)
    expect(signal?.aborted).toBe(false)
    expect(session()?.save).toEqual({ phase: 'reconciling', exhausted: false })

    store().pauseReconcile(id)
    expect(session()?.save).toEqual({ phase: 'reconciling', exhausted: true })

    const resumed = store().beginReconcile(id)
    expect(signal?.aborted).toBe(true)
    expect(resumed?.aborted).toBe(false)
    expect(session()?.save).toEqual({ phase: 'reconciling', exhausted: false })
  })

  it('does not reconcile a preview that has no save in flight', () => {
    const id = previewReady()

    expect(store().beginReconcile(id)).toBeNull()
    expect(session()?.save).toEqual({ phase: 'idle' })
  })

  it('expires only an unsaved preview when the timer fires', () => {
    const idle = previewReady()
    store().expireUnsaved(idle)
    expect(session()?.save).toEqual({ phase: 'expired', mayHaveSaved: false })
    store().discard()

    const saving = previewReady()
    store().beginSave(saving)
    store().expireUnsaved(saving)
    expect(session()?.save).toEqual({ phase: 'saving' })

    store().settleSave(saving, publishedDestination)
    store().expireUnsaved(saving)
    expect(session()?.save).toMatchObject({ phase: 'settled' })
  })

  it('marks a preview unavailable on a 404 even while saving, but never after settling', () => {
    const id = previewReady()
    store().beginSave(id)
    store().markUnavailable(id, true)
    expect(session()?.save).toEqual({ phase: 'expired', mayHaveSaved: true })
    store().discard()

    const settled = previewReady()
    store().beginSave(settled)
    store().settleSave(settled, publishedDestination)
    store().markUnavailable(settled, true)
    expect(session()?.save).toMatchObject({ phase: 'settled' })
  })

  it('aborts the save controller when the run is discarded', () => {
    const id = previewReady()
    const started = store().beginSave(id)!

    store().discard()

    expect(started.signal.aborted).toBe(true)
    expect(store().saveController).toBeNull()
  })
})

describe('replacement rules (D4)', () => {
  it('blocks any new generation while a save is in flight', () => {
    const id = previewReady()
    store().beginSave(id)

    expect(store().begin(spec)).toBeNull()
    expect(store().begin(discoverSpec)).toBeNull()

    store().beginReconcile(id)
    expect(store().begin(spec)).toBeNull()
  })

  it('keeps the previous preview while the same feature regenerates, then replaces it', () => {
    const id = previewReady()
    store().setTitle(id, 'My edit')

    const next = store().begin(spec)!

    expect(store().run?.status).toMatchObject({
      phase: 'active',
      previous: { outcome, spotify: { title: 'My edit' } },
    })

    const replacement = { mode: 'spotify', preview: jazzPreview({ previewId: 'BBBBBBBBBBBBBBBBBBBBBB' }) } as const
    expect(store().succeed(next.id, replacement)).toBe(true)
    expect(store().run?.status).toMatchObject({
      phase: 'succeeded',
      outcome: replacement,
      spotify: { save: { phase: 'idle' } },
    })
  })

  it('restores the previous preview with its title draft when regeneration fails', () => {
    const id = previewReady()
    store().setTitle(id, 'My edit')
    const next = store().begin(spec)!
    const error = new Error('provider down')

    expect(store().fail(next.id, error)).toBe(true)

    expect(store().run?.status).toMatchObject({
      phase: 'succeeded',
      outcome,
      spotify: { title: 'My edit', generationError: error, save: { phase: 'idle' } },
    })
  })

  it('does not restore a previous preview that expired while regenerating', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const expiring = {
      mode: 'spotify',
      preview: jazzPreview({ expiresAt: '2026-01-01T00:10:00.000Z' }),
    } as const
    const first = store().begin(spec)!
    store().succeed(first.id, expiring)
    const next = store().begin(spec)!

    vi.setSystemTime(new Date('2026-01-01T00:11:00.000Z'))
    store().fail(next.id, new Error('late'))

    expect(store().run?.status.phase).toBe('failed')
  })

  it('does not keep a previous preview across features or after it was saved', () => {
    const id = previewReady()
    store().beginSave(id)
    store().settleSave(id, publishedDestination)
    expect(store().begin(spec)?.id).toBeDefined()
    expect(store().run?.status).toMatchObject({ phase: 'active', previous: null })
    store().discard()

    previewReady()
    store().begin(discoverSpec)
    expect(store().run?.status).toMatchObject({ phase: 'active', previous: null })
  })
})

describe('restoring a Spotify preview', () => {
  it('restores an unsaved, reconciling or expired preview as already seen, only when no run exists', () => {
    const restored = store().restoreSpotify(spec, outcome, {
      title: 'Restored title',
      coverOption: false,
      coverRenderFailed: false,
      hadSaveAttempt: true,
      generationError: null,
      save: { phase: 'reconciling', exhausted: false },
    })

    expect(restored).toBe(true)
    expect(store().run).toMatchObject({ seen: true, spec })
    expect(session()).toMatchObject({ title: 'Restored title', coverOption: false })
    expect(store().restoreSpotify(discoverSpec, outcome, session()!)).toBe(false)
  })
})
