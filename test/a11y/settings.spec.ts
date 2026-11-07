// The settings menu, driven the way a reader drives it: open the popover,
// pick from each control, and check the page changed and the choice was
// saved. Every control here once rendered and opened fine while its choice
// went nowhere, which no axe sweep or unit test could see.

import { expect, type Page, test } from '@playwright/test'

test.use({ timezoneId: 'America/Los_Angeles', locale: 'en-US' })

const KEY = 'ft:reader-prefs'

const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), KEY)

/** The "Now reads as" sample: the clock, zone and date form in one string. */
const sample = (page: Page) => page.getByRole('group', { name: 'Settings' }).locator('.font-mono')

async function pick(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
  // Choosing in a select must not close the popover around it.
  await expect(page.getByRole('group', { name: 'Settings' })).toBeVisible()
}

test('each setting applies on the page and is saved', async ({ page }) => {
  await page.goto('/')
  await page.evaluate((key) => localStorage.removeItem(key), KEY)
  await page.reload()

  // The default is the browser's zone, applied once the page has loaded.
  await expect(page.locator('main time').first()).toContainText(/P[SD]T|ago|just now/)

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(sample(page)).toContainText(/P[SD]T/)

  await pick(page, 'Clock', '24-hour')
  await expect(sample(page)).toHaveText(/\b\d{2}:\d{2} P[SD]T$/)

  await pick(page, 'Dates', '2026-11-07')
  await expect(sample(page)).toHaveText(/^\d{4}-\d{2}-\d{2} /)

  // A searchable menu: its trigger is a button that opens a combobox.
  await page.getByRole('button', { name: 'Time zone' }).click()
  await page.keyboard.type('Tokyo')
  await page.getByRole('option', { name: 'Asia/Tokyo', exact: true }).click()
  await expect(sample(page)).toContainText('GMT+9')

  await page.getByRole('switch', { name: /recent times as ages/ }).click()
  await pick(page, 'Dollar figures', '$7,810,000,000')
  await pick(page, 'Row spacing', 'Compact')
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact')
  await page.getByRole('checkbox', { name: 'xAI' }).click()

  expect(await stored(page)).toEqual({
    zone: 'Asia/Tokyo',
    clock: '24h',
    dates: 'iso',
    relative: false,
    numbers: 'full',
    density: 'compact',
    watchlist: ['xai'],
  })

  // Starred labs lead the Labs menu.
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Labs', exact: true }).click()
  await expect(page.getByRole('menuitem').first()).toContainText('xAI')
  await page.keyboard.press('Escape')

  // Saved settings survive a reload, and Reset clears them.
  await page.reload()
  await expect(page.locator('main time').first()).toContainText('GMT+9')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Reset' }).click()
  expect(await stored(page)).toEqual({})
  await expect(page.locator('html')).not.toHaveAttribute('data-density', 'compact')
})
