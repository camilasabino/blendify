import { z } from 'zod'
import {
  GenerateDiscoverRequestSchema,
  GenerateMixRequestSchema,
  GeneratedPlaylistSchema,
  PlaylistTransferSchema,
  type GenerateDiscoverRequest,
  type GenerateMixRequest,
  type GeneratedPlaylistDto,
  type PlaylistTransferDto,
} from '@blendify/contracts'

const STORAGE_KEY = 'blendify.guestResult'
const STORAGE_VERSION = 1

const StoredResultBaseSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  playlist: GeneratedPlaylistSchema,
  transfer: PlaylistTransferSchema.nullable(),
})

const StoredGuestResultSchema = z.discriminatedUnion('feature', [
  StoredResultBaseSchema.extend({
    feature: z.literal('mix'),
    request: GenerateMixRequestSchema,
  }).strict(),
  StoredResultBaseSchema.extend({
    feature: z.literal('discover'),
    request: GenerateDiscoverRequestSchema,
  }).strict(),
])

export type StoredGuestResult = Readonly<
  {
    playlist: GeneratedPlaylistDto
    transfer: PlaylistTransferDto | null
  } & (
    | { feature: 'mix'; request: GenerateMixRequest }
    | { feature: 'discover'; request: GenerateDiscoverRequest }
  )
>

function isTransferUsable(transfer: PlaylistTransferDto, now: number): boolean {
  const expiresAt = Date.parse(transfer.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > now
}

export function readStoredGuestResult(now = Date.now()): StoredGuestResult | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearStoredGuestResult()
    return null
  }
  const result = StoredGuestResultSchema.safeParse(parsed)
  if (!result.success) {
    clearStoredGuestResult()
    return null
  }

  const stored = result.data
  const transfer =
    stored.transfer && isTransferUsable(stored.transfer, now)
      ? stored.transfer
      : null
  return stored.feature === 'mix'
    ? { feature: 'mix', request: stored.request, playlist: stored.playlist, transfer }
    : { feature: 'discover', request: stored.request, playlist: stored.playlist, transfer }
}

export function writeStoredGuestResult(result: StoredGuestResult): boolean {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        feature: result.feature,
        request: result.request,
        playlist: result.playlist,
        transfer: result.transfer,
      }),
    )
    return true
  } catch {
    clearStoredGuestResult()
    return false
  }
}

export function clearStoredGuestResult(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    return
  }
}
