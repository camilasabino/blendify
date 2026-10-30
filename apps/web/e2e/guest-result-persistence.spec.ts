import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import {
  mockGenerationStream,
  mockGenres,
  mockGuestSession,
  mockPendingGeneration,
} from './fixtures/api-mocks'
import {
  generationProgress,
  guestJazzPlaylistWithTransfer,
} from './fixtures/playlists'

const STORAGE_KEY = 'blendify.guestResult'
const SOUNDIIZ_URL = 'https://app.soundiiz.com/e2e-mock-transfer'

async function startJazzMix(page: Page, { navigate = true } = {}) {
  if (navigate) {
    await page.goto('/app/mix')
  }
  await page
    .getByRole('group', { name: 'Artists or genres' })
    .getByText('Genres', { exact: true })
    .click()
  await page.getByRole('button', { name: /Jazz/ }).click()
  await page.getByRole('button', { name: 'Generate playlist' }).click()
  await expect(page.getByText('Generating your playlist')).toBeVisible()
}

function countRequests(page: Page, path: string): () => number {
  let count = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === path) {
      count += 1
    }
  })
  return () => count
}

function storedResult(page: Page) {
  return page.evaluate((key) => sessionStorage.getItem(key), STORAGE_KEY)
}

function mainMenuLink(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Main menu' })
    .first()
    .getByRole('link', { name })
}

test.describe('Guest result persistence', () => {
  test.beforeEach(async ({ page }) => {
    await mockGuestSession(page)
    await mockGenres(page)
  })

  test('restores the result and a prepared transfer after a reload without requesting them again', async ({
    page,
  }) => {
    const generations = countRequests(page, '/api/generate/mix')
    const transfers = countRequests(page, '/api/transfers')
    const generation = mockGenerationStream(page, '**/api/generate/mix', [
      generationProgress,
      { type: 'result', playlist: guestJazzPlaylistWithTransfer },
    ])
    await page.route('**/api/transfers', (route) =>
      route.fulfill({
        json: { url: SOUNDIIZ_URL, expiresAt: '2099-01-01T00:00:00.000Z', trackCount: 1 },
      }),
    )

    await startJazzMix(page)
    generation.release()
    await expect(
      page.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Prepare transfer' }).click()
    await expect(
      page.getByRole('link', { name: /Continue on Soundiiz/ }),
    ).toHaveAttribute('href', SOUNDIIZ_URL)

    await page.reload()
    await expect(
      page.getByRole('link', { name: /Continue on Soundiiz/ }),
    ).toHaveAttribute('href', SOUNDIIZ_URL)
    await expect(page.getByRole('button', { name: 'Prepare transfer' })).toHaveCount(0)

    expect(generations()).toBe(1)
    expect(transfers()).toBe(1)
  })

  test('keeps the result across in-app navigation without asking to leave', async ({
    page,
  }) => {
    const generation = mockGenerationStream(page, '**/api/generate/mix', [
      { type: 'result', playlist: guestJazzPlaylistWithTransfer },
    ])
    await startJazzMix(page)
    generation.release()
    await expect(
      page.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()

    await mainMenuLink(page, 'Discover').click()
    await expect(page).toHaveURL(/\/app\/discover$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.goBack()
    await expect(page).toHaveURL(/\/app\/mix$/)
    await expect(
      page.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
  })

  test('clears the stored result on Create another so a reload starts empty', async ({
    page,
  }) => {
    const generation = mockGenerationStream(page, '**/api/generate/mix', [
      { type: 'result', playlist: guestJazzPlaylistWithTransfer },
    ])
    await startJazzMix(page)
    generation.release()
    await page.getByRole('button', { name: 'Create another' }).click()
    expect(await storedResult(page)).toBeNull()

    await page.reload()
    await expect(page.getByRole('button', { name: 'Generate playlist' })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toHaveCount(0)
  })

  test('discards corrupted stored data and shows an empty form', async ({ page }) => {
    await page.addInitScript((key) => {
      if (!sessionStorage.getItem('e2e.seeded')) {
        sessionStorage.setItem('e2e.seeded', '1')
        sessionStorage.setItem(key, '{"version":1,"feature":"mix"')
      }
    }, STORAGE_KEY)

    await page.goto('/app/mix')

    await expect(page.getByRole('button', { name: 'Generate playlist' })).toBeVisible()
    await expect.poll(() => storedResult(page)).toBeNull()
  })
})

test.describe('Guest leave protection', () => {
  test.beforeEach(async ({ page }) => {
    await mockGuestSession(page)
    await mockGenres(page)
  })

  test('asks before leaving an active generation through the app or the back button', async ({
    page,
  }) => {
    mockPendingGeneration(page, '**/api/generate/mix')
    await page.goto('/app')
    await mainMenuLink(page, 'Mix').click()
    await expect(page).toHaveURL(/\/app\/mix$/)
    await startJazzMix(page, { navigate: false })

    const dialog = page.getByRole('dialog', {
      name: 'Leave while your playlist is being generated?',
    })
    await mainMenuLink(page, 'Discover').click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Stay on this page' }).click()
    await expect(dialog).toBeHidden()
    await expect(page).toHaveURL(/\/app\/mix$/)
    await expect(page.getByText('Generating your playlist')).toBeVisible()

    await page.goBack()
    await expect(dialog).toBeVisible()
    await expect(page).toHaveURL(/\/app\/mix$/)
    await dialog.getByRole('button', { name: 'Leave' }).click()
    await expect(page).toHaveURL(/\/app$/)

    await mainMenuLink(page, 'Mix').click()
    await expect(page.getByRole('button', { name: 'Generate playlist' })).toBeVisible()
    await expect(page.getByText('Generating your playlist')).toHaveCount(0)
  })

  test('uses the browser confirmation before closing the tab during a generation', async ({
    page,
  }) => {
    mockPendingGeneration(page, '**/api/generate/mix')
    await startJazzMix(page)

    const dialog = page.waitForEvent('dialog')
    await page.close({ runBeforeUnload: true })
    const prompt = await dialog
    expect(prompt.type()).toBe('beforeunload')
    await prompt.dismiss()
    expect(page.isClosed()).toBe(false)
  })

  test('closes without a confirmation once the result is safely stored', async ({
    page,
  }) => {
    const generation = mockGenerationStream(page, '**/api/generate/mix', [
      { type: 'result', playlist: guestJazzPlaylistWithTransfer },
    ])
    await startJazzMix(page)
    generation.release()
    await expect(
      page.getByRole('heading', { name: 'Blendify · Mix · Jazz' }),
    ).toBeVisible()
    expect(await storedResult(page)).not.toBeNull()

    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.type())
      void dialog.dismiss()
    })
    await page.close({ runBeforeUnload: true })

    await expect.poll(() => page.isClosed()).toBe(true)
    expect(dialogs).toEqual([])
  })
})
