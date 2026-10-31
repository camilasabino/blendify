import { z } from 'zod'
import {
  GenerateDiscoverRequestSchema,
  GenerateMixRequestSchema,
  PLAYLIST_NAME_MAX_LENGTH,
  SpotifyPreviewIdSchema,
  type GenerateDiscoverRequest,
  type GenerateMixRequest,
} from '@blendify/contracts'

const STORAGE_KEY = 'blendify.spotifyPreview'
const STORAGE_VERSION = 2

const StoredReferenceBaseSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  previewId: SpotifyPreviewIdSchema,
  expiresAt: z.iso.datetime(),
  title: z.string().max(PLAYLIST_NAME_MAX_LENGTH),
  coverOption: z.boolean(),
  saveAttempted: z.boolean(),
})

const StoredSpotifyPreviewSchema = z.discriminatedUnion('feature', [
  StoredReferenceBaseSchema.extend({
    feature: z.literal('mix'),
    request: GenerateMixRequestSchema,
  }).strict(),
  StoredReferenceBaseSchema.extend({
    feature: z.literal('discover'),
    request: GenerateDiscoverRequestSchema,
  }).strict(),
])

export type StoredSpotifyPreview = Readonly<
  {
    previewId: string
    expiresAt: string
    title: string
    coverOption: boolean
    saveAttempted: boolean
  } & (
    | { feature: 'mix'; request: GenerateMixRequest }
    | { feature: 'discover'; request: GenerateDiscoverRequest }
  )
>

export function readStoredSpotifyPreview(): StoredSpotifyPreview | null {
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
    clearStoredSpotifyPreview()
    return null
  }
  const result = StoredSpotifyPreviewSchema.safeParse(parsed)
  if (!result.success) {
    clearStoredSpotifyPreview()
    return null
  }

  const stored = result.data
  const reference = {
    previewId: stored.previewId,
    expiresAt: stored.expiresAt,
    title: stored.title,
    coverOption: stored.coverOption,
    saveAttempted: stored.saveAttempted,
  }
  return stored.feature === 'mix'
    ? { ...reference, feature: 'mix', request: stored.request }
    : { ...reference, feature: 'discover', request: stored.request }
}

export function writeStoredSpotifyPreview(preview: StoredSpotifyPreview): boolean {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: STORAGE_VERSION,
        feature: preview.feature,
        request: preview.request,
        previewId: preview.previewId,
        expiresAt: preview.expiresAt,
        title: preview.title,
        coverOption: preview.coverOption,
        saveAttempted: preview.saveAttempted,
      }),
    )
    return true
  } catch {
    clearStoredSpotifyPreview()
    return false
  }
}

export function clearStoredSpotifyPreview(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    return
  }
}
