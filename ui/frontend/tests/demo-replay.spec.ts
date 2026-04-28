import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from '@playwright/test'

test.skip(!process.env.DEMO_REPLAY_HTML, 'Set DEMO_REPLAY_HTML to the exported demo-replay HTML file.')

test('exported demo replay renders and completes', async ({ page }) => {
  const replayPath = process.env.DEMO_REPLAY_HTML
  const absolutePath = resolve(replayPath!)
  expect(existsSync(absolutePath), `Replay file does not exist: ${absolutePath}`).toBe(true)

  await page.goto(pathToFileURL(absolutePath).toString())
  await expect(page.locator('#root')).not.toBeEmpty()
  await expect(page.locator('.demo-replay-controls')).toBeVisible()
  await expect(page.locator('#demo-replay-status')).toContainText(/Replay/)

  await page.waitForFunction(() => document.querySelector('#demo-replay-status')?.textContent === 'Replay complete', null, {
    timeout: 120_000,
  })
})
