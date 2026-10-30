import { guestJazzPlaylist } from '@/test/playlist-fixtures'
import {
  clearStoredGuestResult,
  readStoredGuestResult,
  writeStoredGuestResult,
  type StoredGuestResult,
} from '@/lib/guest-result-storage'

const STORAGE_KEY = 'blendify.guestResult'
const NOW = Date.parse('2026-10-30T12:00:00.000Z')

const result: StoredGuestResult = {
  feature: 'mix',
  request: {
    kind: 'genre_mix',
    name: 'Blendify · Mix · Jazz',
    description: '',
    genreIds: ['jazz'],
    popularity: 'balanced',
    tracksPerSeed: 25,
    orderMode: 'random',
  },
  playlist: guestJazzPlaylist,
  transfer: {
    url: 'https://soundiiz.com/go/import-playlist/abcdefghijklmnop',
    expiresAt: '2026-10-30T13:00:00.000Z',
    trackCount: 1,
  },
}

describe('guest result storage', () => {
  it('round-trips a versioned result', () => {
    expect(writeStoredGuestResult(result)).toBe(true)

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      version: 1,
      feature: 'mix',
    })
    expect(readStoredGuestResult(NOW)).toMatchObject(result)
  })

  it('drops a prepared transfer whose link has expired but keeps the playlist', () => {
    writeStoredGuestResult(result)

    const restored = readStoredGuestResult(Date.parse('2026-10-30T13:00:00.000Z'))

    expect(restored?.transfer).toBeNull()
    expect(restored?.playlist).toEqual(guestJazzPlaylist)
  })

  it('drops a prepared transfer with an unreadable expiry', () => {
    writeStoredGuestResult({
      ...result,
      transfer: { ...result.transfer!, expiresAt: 'soon' },
    })

    expect(readStoredGuestResult(NOW)?.transfer).toBeNull()
  })

  it.each([
    ['corrupted JSON', '{'],
    ['another version', JSON.stringify({ ...result, version: 2 })],
    ['a request for another feature', JSON.stringify({ ...result, version: 1, feature: 'discover' })],
    ['extra fields', JSON.stringify({ ...result, version: 1, token: 'secret' })],
  ])('removes %s', (_case, raw) => {
    sessionStorage.setItem(STORAGE_KEY, raw)

    expect(readStoredGuestResult(NOW)).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('reports a failed write and leaves no stale result behind', () => {
    writeStoredGuestResult(result)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError')
    })

    expect(writeStoredGuestResult({ ...result, transfer: null })).toBe(false)
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    vi.restoreAllMocks()
  })

  it('treats blocked storage as empty', () => {
    const blocked = () => {
      throw new DOMException('Blocked', 'SecurityError')
    }
    vi.stubGlobal('sessionStorage', {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked,
    })

    expect(readStoredGuestResult(NOW)).toBeNull()
    expect(writeStoredGuestResult(result)).toBe(false)
    expect(() => clearStoredGuestResult()).not.toThrow()
    vi.unstubAllGlobals()
  })
})
