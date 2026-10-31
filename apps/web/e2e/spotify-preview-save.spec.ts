import type { Page, Request, Route } from '@playwright/test'
import type {
  SpotifyDestinationDto,
  SpotifyPreviewStateDto,
} from '@blendify/contracts'
import { expect, test } from './fixtures/test'
import {
  mockAuthenticatedSession,
  mockEmptyLibrary,
  mockGenerationStream,
  mockGenres,
} from './fixtures/api-mocks'
import {
  generationProgress,
  jazzPreview,
  PREVIEW_ID,
  previewState,
  publishedDestination,
} from './fixtures/playlists'

const SAVE_URL = `**/api/previews/${PREVIEW_ID}/save`
const STATE_URL = `**/api/previews/${PREVIEW_ID}`
const MIX_URL = '**/api/previews/mix'
const DISCOVER_URL = '**/api/previews/discover'
const STORAGE_KEY = 'blendify.spotifyPreview'

function envelope(statusCode: number, code: string, details?: object) {
  return { statusCode, code, message: code, ...(details ? { details } : {}) }
}

function trackRequests(page: Page) {
  const saves: Request[] = []
  const generations: Request[] = []
  page.on('request', (request) => {
    const { pathname } = new URL(request.url())
    if (request.method() === 'POST' && pathname.endsWith('/save')) {
      saves.push(request)
    }
    if (
      request.method() === 'POST' &&
      /\/api\/previews\/(mix|discover)$/.test(pathname)
    ) {
      generations.push(request)
    }
  })
  return { saves, generations }
}

function previewStream(page: Page, url = MIX_URL, previewId = PREVIEW_ID) {
  return mockGenerationStream(page, url, [
    generationProgress,
    { type: 'result', playlist: jazzPreview({ previewId }) },
  ])
}

async function chooseJazz(page: Page) {
  await page.goto('/app/mix')
  await page
    .getByRole('group', { name: 'Artists or genres' })
    .getByText('Genres', { exact: true })
    .click()
  await page.getByRole('button', { name: /Jazz/ }).click()
}

async function generateJazzPreview(page: Page) {
  const stream = previewStream(page)
  await chooseJazz(page)
  await page.getByRole('button', { name: 'Generate preview' }).click()
  await expect(page.getByText('Generating your preview')).toBeVisible()
  stream.release()
  await expect(page.getByText('Preview · not saved yet')).toBeVisible()
}

async function fulfillState(
  route: Route,
  destination: SpotifyDestinationDto | null,
  overrides: Partial<SpotifyPreviewStateDto> = {},
) {
  await route.fulfill({ json: previewState(destination, overrides) })
}

function saveButton(page: Page) {
  return page.getByRole('button', { name: 'Save to Spotify' })
}

test.describe('Spotify Mix preview and save', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedSession(page)
    await mockGenres(page)
    await mockEmptyLibrary(page)
  })

  test('generates a preview without saving, then saves once with the edited title', async ({
    page,
  }) => {
    const { saves, generations } = trackRequests(page)
    await page.route(SAVE_URL, (route) => fulfillState(route, publishedDestination))

    await generateJazzPreview(page)

    expect(saves).toHaveLength(0)
    expect(generations).toHaveLength(1)
    expect(generations[0].postDataJSON()).not.toHaveProperty('persistToLibrary')
    await expect(page.getByText('This preview is temporary and isn’t saved yet', { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: /Open in Spotify/ })).toHaveCount(0)

    await page.getByRole('button', { name: 'Edit title' }).click()
    await page.getByRole('textbox', { name: 'Playlist title' }).fill('Late night jazz')
    await page.getByRole('button', { name: 'Done' }).click()
    await saveButton(page).click()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    await expect(page.getByRole('link', { name: /Open in Spotify/ })).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(saves[0].postDataJSON()).toMatchObject({
      name: 'Late night jazz',
      persistToLibrary: true,
    })
    expect(saves[0].postDataJSON().coverImageBase64).toEqual(expect.any(String))
  })

  test('sends one save request on a double click and on Enter', async ({ page }) => {
    const { saves } = trackRequests(page)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(SAVE_URL, async (route) => {
      await gate
      await fulfillState(route, publishedDestination)
    })
    await generateJazzPreview(page)

    await saveButton(page).dblclick()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: 'Saving to Spotify…' })).toBeDisabled()
    release()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(saves).toHaveLength(1)
  })

  test('restores an unsaved preview, its title draft and cover option after a reload', async ({
    page,
  }) => {
    const { saves } = trackRequests(page)
    await page.route(STATE_URL, (route) => fulfillState(route, null))
    await page.route(SAVE_URL, (route) => fulfillState(route, publishedDestination))
    await generateJazzPreview(page)
    await page.getByRole('button', { name: 'Edit title' }).click()
    await page.getByRole('textbox', { name: 'Playlist title' }).fill('Kept across reload')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('switch', { name: 'Add a cover image' }).click()

    const stored = await page.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY)
    expect(JSON.parse(stored ?? 'null')).toMatchObject({
      previewId: PREVIEW_ID,
      title: 'Kept across reload',
      coverOption: false,
    })
    expect(stored).not.toContain('So What')

    await page.reload()

    await expect(page.getByRole('heading', { name: 'Kept across reload' })).toBeVisible()
    await expect(page.getByRole('switch', { name: 'Add a cover image' })).not.toBeChecked()
    await saveButton(page).click()
    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(saves).toHaveLength(1)
    expect(saves[0].postDataJSON()).not.toHaveProperty('coverImageBase64')
  })

  test('reconciles a publication that was running at reload without posting again', async ({
    page,
  }) => {
    const { saves } = trackRequests(page)
    await page.route(SAVE_URL, () => new Promise(() => undefined))
    await generateJazzPreview(page)
    await saveButton(page).click()
    await expect(page.getByRole('button', { name: 'Saving to Spotify…' })).toBeVisible()
    expect(saves).toHaveLength(1)

    let reads = 0
    await page.route(STATE_URL, (route) => {
      reads += 1
      return fulfillState(route, reads === 1 ? { status: 'publishing' } : publishedDestination)
    })
    await page.reload()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible({ timeout: 10_000 })
    expect(saves).toHaveLength(1)
  })

  test('reconciles a 409 through status reads and never repeats the save', async ({ page }) => {
    const { saves } = trackRequests(page)
    await page.route(SAVE_URL, (route) =>
      route.fulfill({ status: 409, json: envelope(409, 'PREVIEW_SAVE_IN_PROGRESS') }),
    )
    let reads = 0
    await page.route(STATE_URL, (route) => {
      reads += 1
      return fulfillState(route, reads < 2 ? { status: 'publishing' } : publishedDestination)
    })
    await generateJazzPreview(page)

    await saveButton(page).click()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible({ timeout: 10_000 })
    expect(saves).toHaveLength(1)
  })

  test('returns to the unsaved preview when a dropped save never reached the server', async ({
    page,
  }) => {
    const { saves } = trackRequests(page)
    await page.route(SAVE_URL, (route) => route.abort('connectionreset'))
    await page.route(STATE_URL, (route) => fulfillState(route, null))
    await generateJazzPreview(page)

    await saveButton(page).click()

    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 })
    await expect(saveButton(page)).toBeEnabled()
    expect(saves).toHaveLength(1)
  })

  test('waits out a rate limit and then saves', async ({ page }) => {
    const { saves } = trackRequests(page)
    let attempts = 0
    await page.route(SAVE_URL, (route) => {
      attempts += 1
      return attempts === 1
        ? route.fulfill({
            status: 429,
            json: envelope(429, 'RATE_LIMITED', { retryAfterSeconds: 2 }),
          })
        : fulfillState(route, publishedDestination)
    })
    await generateJazzPreview(page)

    await saveButton(page).click()
    await expect(page.getByRole('alert')).toContainText(/wait|later|try again/i)
    await expect(saveButton(page)).toBeDisabled()
    await expect(saveButton(page)).toBeEnabled({ timeout: 5_000 })
    await saveButton(page).click()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(saves).toHaveLength(2)
  })

  test('keeps the preview after a confirmed rejection and saves on a retry', async ({ page }) => {
    const { saves } = trackRequests(page)
    let attempts = 0
    await page.route(SAVE_URL, (route) => {
      attempts += 1
      return attempts === 1
        ? route.fulfill({ status: 502, json: envelope(502, 'SPOTIFY_REQUEST_REJECTED') })
        : fulfillState(route, publishedDestination)
    })
    await generateJazzPreview(page)

    await saveButton(page).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Blendify · Mix · Jazz' })).toBeVisible()
    await saveButton(page).click()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(saves).toHaveLength(2)
  })

  for (const [reason, url, copy] of [
    ['outcome_unknown', null, /may exist in your account/],
    ['tracks_incomplete', 'https://open.spotify.com/playlist/p1', /some songs may be missing/],
    ['library_not_saved', 'https://open.spotify.com/playlist/p1', /couldn’t add it to your Library/],
    ['interrupted', null, /Saving was interrupted/],
  ] as const) {
    test(`explains an incomplete save (${reason}) and offers no new save`, async ({ page }) => {
      const { saves } = trackRequests(page)
      await page.route(SAVE_URL, (route) =>
        fulfillState(route, { status: 'publish_incomplete', spotifyUrl: url, reason }),
      )
      await generateJazzPreview(page)

      await saveButton(page).click()

      await expect(page.getByRole('alert').filter({ hasText: copy })).toBeVisible()
      await expect(saveButton(page)).toHaveCount(0)
      await expect(page.getByRole('link', { name: /Open in Spotify/ })).toHaveCount(url ? 1 : 0)
      expect(saves).toHaveLength(1)
    })
  }

  test('asks to reconnect on a Spotify authorization error and keeps the preview', async ({
    page,
  }) => {
    await page.route(SAVE_URL, (route) =>
      route.fulfill({ status: 401, json: envelope(401, 'SPOTIFY_REAUTH_REQUIRED') }),
    )
    await page.route(STATE_URL, (route) => fulfillState(route, null))
    await generateJazzPreview(page)

    await saveButton(page).click()

    await expect(page.getByRole('button', { name: 'Connect Spotify' })).toBeVisible()
    await page.reload()
    await expect(page.getByText('Preview · not saved yet')).toBeVisible()
  })

  test('navigating away during generation and during a save keeps the run in the shell', async ({
    page,
  }) => {
    const { saves } = trackRequests(page)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(SAVE_URL, async (route) => {
      await gate
      await fulfillState(route, publishedDestination)
    })
    const stream = previewStream(page)
    await chooseJazz(page)
    await page.getByRole('button', { name: 'Generate preview' }).click()
    await page
      .getByRole('navigation', { name: 'Main menu' })
      .first()
      .getByRole('link', { name: 'Library' })
      .click()
    const status = page.getByRole('region', { name: 'Playlist creation' })
    await expect(status.getByText('Creating your Mix')).toBeVisible()

    stream.release()
    await expect(status.getByText('Your Mix preview is ready · not saved')).toBeVisible()
    await status.getByRole('link', { name: 'View preview' }).click()
    await saveButton(page).click()
    await page
      .getByRole('navigation', { name: 'Main menu' })
      .first()
      .getByRole('link', { name: 'Stats' })
      .click()
    await expect(status.getByText('Saving your Mix to Spotify')).toBeVisible()

    release()
    await expect(status.getByText('Your Mix is saved to Spotify')).toBeVisible()
    await status.getByRole('link', { name: 'View playlist' }).click()
    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
    expect(saves).toHaveLength(1)
  })

  test('asks before another feature replaces an unsaved preview, and keeps it on cancel', async ({
    page,
  }) => {
    const { generations } = trackRequests(page)
    await page.route('**/api/artists/search**', (route) =>
      route.fulfill({
        json: { artists: [{ id: 'artist-1', name: 'Sade', imageUrl: null }] },
      }),
    )
    await generateJazzPreview(page)

    await page
      .getByRole('navigation', { name: 'Main menu' })
      .first()
      .getByRole('link', { name: 'Discover' })
      .click()
    await page.getByRole('combobox').fill('sade')
    await page.getByRole('option', { name: 'Sade' }).click()
    await page.getByRole('button', { name: 'Generate preview' }).click()

    const dialog = page.getByRole('dialog', { name: 'Replace the unsaved preview?' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Keep preview' }).click()
    await expect(dialog).toHaveCount(0)
    expect(generations).toHaveLength(1)

    await page
      .getByRole('navigation', { name: 'Main menu' })
      .first()
      .getByRole('link', { name: 'Mix' })
      .click()
    await expect(page.getByText('Preview · not saved yet')).toBeVisible()
  })

  test('keeps the previous preview when a same-feature regeneration fails', async ({ page }) => {
    await generateJazzPreview(page)
    await page.unroute(MIX_URL)
    await page.route(MIX_URL, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ type: 'error', ...envelope(502, 'CATALOG_UNAVAILABLE') })}\n`,
      }),
    )

    await page.getByRole('button', { name: 'Try different settings' }).click()
    await page.getByRole('button', { name: 'Generate new preview' }).click()

    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(
      page.getByText('Couldn’t generate a new preview. This one is still available.'),
    ).toBeVisible()
    await expect(saveButton(page)).toBeEnabled()
  })

  test('does not ask when navigating between pages with an unsaved preview', async ({ page }) => {
    await generateJazzPreview(page)

    for (const name of ['Library', 'Stats', 'Mix']) {
      await page
        .getByRole('navigation', { name: 'Main menu' })
        .first()
        .getByRole('link', { name })
        .click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    await expect(page.getByText('Preview · not saved yet')).toBeVisible()
  })
})

test.describe('Spotify preview expiry', () => {
  const START = new Date('2026-10-30T12:00:00.000Z')
  const EXPIRES_AT = '2026-10-30T12:30:00.000Z'

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: START })
    await mockAuthenticatedSession(page)
    await mockGenres(page)
    await mockEmptyLibrary(page)
  })

  async function previewWithExpiry(page: Page) {
    const stream = mockGenerationStream(page, MIX_URL, [
      generationProgress,
      { type: 'result', playlist: jazzPreview({ expiresAt: EXPIRES_AT }) },
    ])
    await chooseJazz(page)
    await page.getByRole('button', { name: 'Generate preview' }).click()
    stream.release()
    await expect(page.getByText('Preview · not saved yet')).toBeVisible()
  }

  test('expires an unsaved preview and generates it again from the stored settings', async ({
    page,
  }) => {
    const { saves, generations } = trackRequests(page)
    await previewWithExpiry(page)
    const firstBody = generations[0].postDataJSON()

    await page.clock.fastForward('31:00')

    await expect(page.getByRole('heading', { name: 'This preview expired' })).toBeVisible()
    await expect(page.getByText(/the songs may be different/).first()).toBeVisible()
    await expect(saveButton(page)).toHaveCount(0)

    await page.getByRole('button', { name: 'Generate again' }).click()
    await expect.poll(() => generations.length).toBe(2)
    expect(generations[1].postDataJSON()).toEqual(firstBody)
    expect(saves).toHaveLength(0)
  })

  test('reports the outcome of a save that finishes after the preview expired', async ({ page }) => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(SAVE_URL, async (route) => {
      await gate
      await fulfillState(route, publishedDestination, { playlist: null })
    })
    await previewWithExpiry(page)

    await saveButton(page).click()
    await page.clock.fastForward('31:00')
    await expect(page.getByRole('button', { name: 'Saving to Spotify…' })).toBeVisible()
    release()

    await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
  })
})

test.describe('Spotify Discover preview and save', () => {
  test.beforeEach(async ({ page }) => {
    await mockAuthenticatedSession(page)
    await mockGenres(page)
    await mockEmptyLibrary(page)
    await page.route('**/api/artists/search**', (route) =>
      route.fulfill({
        json: { artists: [{ id: 'artist-1', name: 'Sade', imageUrl: null }] },
      }),
    )
    await page.route('**/api/tracks/search**', (route) =>
      route.fulfill({
        json: {
          tracks: [
            {
              id: 'track-9',
              name: 'Smooth Operator',
              artistId: 'artist-1',
              artistName: 'Sade',
              artists: [{ id: 'artist-1', name: 'Sade' }],
              albumName: 'Diamond Life',
              albumImageUrl: null,
              durationMs: 258_000,
              popularity: 70,
              uri: 'spotify:track:track-9',
              externalUrl: 'https://open.spotify.com/track/track-9',
            },
          ],
        },
      }),
    )
  })

  for (const seed of ['artist', 'track'] as const) {
    test(`previews and saves a Discover ${seed} playlist`, async ({ page }) => {
      const { saves, generations } = trackRequests(page)
      const stream = previewStream(page, DISCOVER_URL)
      await page.route(SAVE_URL, (route) => fulfillState(route, publishedDestination))
      await page.goto('/app/discover')
      if (seed === 'track') {
        await page.getByRole('radio', { name: 'Song', exact: true }).check({ force: true })
      }
      await page.getByRole('combobox').fill(seed === 'artist' ? 'sade' : 'smooth')
      await page
        .getByRole('option', { name: seed === 'artist' ? 'Sade' : /Smooth Operator/ })
        .click()
      await page.getByRole('button', { name: 'Generate preview' }).click()
      stream.release()

      await expect(page.getByText('Preview · not saved yet')).toBeVisible()
      expect(saves).toHaveLength(0)
      expect(generations[0].postDataJSON()).toMatchObject({
        kind: seed === 'artist' ? 'discover_artist' : 'discover_track',
      })
      expect(generations[0].postDataJSON()).not.toHaveProperty('persistToLibrary')

      await saveButton(page).click()
      await expect(page.getByRole('heading', { name: 'Saved to Spotify' })).toBeVisible()
      expect(saves).toHaveLength(1)
    })
  }
})
