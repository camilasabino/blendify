import type { GenerateDiscoverRequest, GenerateMixRequest } from '@/lib/api'
import { api } from '@/lib/api'
import {
  outcomeRequestedTrackCount,
  outcomeTrackCount,
  runDiscoverGeneration,
  runMixGeneration,
} from '@/lib/playlist-generation'
import { guestJazzPlaylist as guestPlaylist, jazzPreview } from '@/test/playlist-fixtures'

const discoverRequest: GenerateDiscoverRequest = {
  kind: 'discover_artist',
  artistId: 'artist-1',
  targetTrackCount: 30,
  popularity: 'balanced',
  orderMode: 'random',
}

afterEach(() => vi.restoreAllMocks())

describe('runDiscoverGeneration', () => {
  it('uses Guest generation', async () => {
    const generate = vi.spyOn(api, 'generateDiscover').mockResolvedValue(guestPlaylist)
    const preview = vi.spyOn(api, 'createDiscoverPreview')

    const outcome = await runDiscoverGeneration({
      mode: 'guest',
      request: discoverRequest,
    })

    expect(outcome).toEqual({ mode: 'guest', playlist: guestPlaylist })
    expect(generate).toHaveBeenCalledWith(discoverRequest, { onProgress: undefined })
    expect(preview).not.toHaveBeenCalled()
  })

  it('requests a Spotify preview with the generation request only', async () => {
    const stored = jazzPreview()
    const preview = vi.spyOn(api, 'createDiscoverPreview').mockResolvedValue(stored)
    const generate = vi.spyOn(api, 'generateDiscover')

    const outcome = await runDiscoverGeneration({
      mode: 'spotify',
      request: discoverRequest,
    })

    expect(outcome).toEqual({ mode: 'spotify', preview: stored })
    expect(preview).toHaveBeenCalledWith(discoverRequest, { onProgress: undefined })
    expect(generate).not.toHaveBeenCalled()
  })
})

describe('runMixGeneration', () => {
  it('chooses the endpoint from the submitted mode', async () => {
    const generate = vi.spyOn(api, 'generateMix').mockResolvedValue(guestPlaylist)
    const preview = vi.spyOn(api, 'createMixPreview').mockResolvedValue(jazzPreview())
    const request: GenerateMixRequest = {
      kind: 'genre_mix',
      genreIds: ['jazz'],
      tracksPerSeed: 5,
      popularity: 'balanced',
      orderMode: 'random',
    }

    await runMixGeneration({ mode: 'guest', request })
    await runMixGeneration({ mode: 'spotify', request })

    expect(generate).toHaveBeenCalledWith(request, { onProgress: undefined })
    expect(preview).toHaveBeenCalledWith(request, { onProgress: undefined })
  })
})

describe('outcome helpers', () => {
  it('counts the tracks of a preview and of a preview whose content expired', () => {
    const withContent = { mode: 'spotify', preview: jazzPreview() } as const
    const withoutContent = {
      mode: 'spotify',
      preview: { ...jazzPreview(), playlist: null },
    } as const

    expect(outcomeTrackCount(withContent)).toBe(1)
    expect(outcomeRequestedTrackCount(withContent)).toBe(1)
    expect(outcomeTrackCount(withoutContent)).toBe(0)
    expect(outcomeRequestedTrackCount(withoutContent)).toBe(0)
  })
})
