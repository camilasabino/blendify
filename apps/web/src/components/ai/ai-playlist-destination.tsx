import { useEffect, useRef, useState } from 'react'
import type {
  AiIntentSummary,
  AiSessionDestinationDto,
  PlaylistTransferDto,
  PublishAiPlaylistRequest,
} from '@blendify/contracts'
import { SoundiizTransfer } from '@/components/playlist/transfer-action'
import { SpotifyDestinationOutcome } from '@/components/spotify-destination/spotify-destination-outcome'
import { SpotifySavePanel } from '@/components/spotify-destination/spotify-save-panel'
import { isSpotifyDestination } from './ai-destination-state'
import type { AppMode } from '@/lib/capabilities'
import { readPersistToLibraryPreference } from '@/lib/persist-to-library-preference'
import { renderPlaylistCoverBase64, type PlaylistCoverKind } from '@/lib/playlist-cover'

type AiPlaylistDestinationProps = Readonly<{
  mode: AppMode
  intentKind: AiIntentSummary['kind']
  title: string
  destination: AiSessionDestinationDto | null
  transferAvailable: boolean
  isPublishing: boolean
  publishError: unknown
  onPublish: (input: PublishAiPlaylistRequest) => void
  onPrepareTransfer: (name: string) => Promise<PlaylistTransferDto>
}>

export function AiPlaylistDestination({
  mode,
  intentKind,
  title,
  destination,
  transferAvailable,
  isPublishing,
  publishError,
  onPublish,
  onPrepareTransfer,
}: AiPlaylistDestinationProps) {
  const [publishRequested, setPublishRequested] = useState(false)

  if (isSpotifyDestination(destination)) {
    return (
      <SpotifyDestinationOutcome destination={destination} focusOnSettle={publishRequested} />
    )
  }
  if (mode === 'spotify') {
    return (
      <AiSpotifyPublish
        intentKind={intentKind}
        title={title}
        isPublishing={isPublishing}
        error={publishError}
        onPublish={(input) => {
          setPublishRequested(true)
          onPublish(input)
        }}
      />
    )
  }
  if (!transferAvailable) {
    return null
  }
  return (
    <SoundiizTransfer
      prepare={() => onPrepareTransfer(title)}
      preparedTransfer={destination?.transfer ?? null}
    />
  )
}

function coverKind(kind: AiIntentSummary['kind']): PlaylistCoverKind {
  return kind === 'artist_mix' || kind === 'genre_mix' ? 'mix' : 'discover'
}

function AiSpotifyPublish({
  intentKind,
  title,
  isPublishing,
  error,
  onPublish,
}: Readonly<{
  intentKind: AiIntentSummary['kind']
  title: string
  isPublishing: boolean
  error: unknown
  onPublish: (input: PublishAiPlaylistRequest) => void
}>) {
  const [isPreparing, setIsPreparing] = useState(false)
  const isRequesting = useRef(false)
  const persistToLibrary = readPersistToLibraryPreference()
  const isBusy = isPreparing || isPublishing

  useEffect(() => {
    if (!isPublishing) {
      isRequesting.current = false
    }
  }, [isPublishing])

  async function save() {
    if (isBusy || isRequesting.current) {
      return
    }
    isRequesting.current = true
    setIsPreparing(true)
    let coverImageBase64: string | undefined
    try {
      coverImageBase64 = await renderPlaylistCoverBase64({ title, kind: coverKind(intentKind) })
    } catch {
      coverImageBase64 = undefined
    }
    setIsPreparing(false)
    onPublish({ name: title, persistToLibrary, coverImageBase64 })
  }

  return (
    <SpotifySavePanel
      isBusy={isBusy}
      failure={error ? { error } : null}
      persistToLibrary={persistToLibrary}
      onSave={() => void save()}
    />
  )
}
