import { test, expect, Page } from '@playwright/test'
import { PRIMARY, REPLICA, instancePicker, mockWrites, resetMock } from './helpers'

// Adlists editor against the lab. Node-1 is the nebula-sync primary (set in
// global-setup): every adlist write goes there, Node-2 is a read-only replica.
// The mocks record what they receive, so "nothing reached the replica" is
// checked directly rather than inferred from the UI.

const TEST_URL_SINGLE = 'https://raw.githubusercontent.com/pihole-central-e2e-test/single/main/test.txt'
const TEST_URL_ALL = 'https://raw.githubusercontent.com/pihole-central-e2e-test/all/main/test.txt'

async function selectInstance(page: Page, value: string) {
  await instancePicker(page).selectOption(value === '__all__' ? '__all__' : { label: value })
  await page.waitForLoadState('networkidle')
}

function findRow(page: Page, url: string) {
  return page.locator('tbody tr').filter({ hasText: url })
}

function addForm(page: Page) {
  return page.locator('.surface').filter({ has: page.locator('h3:has-text("Add subscription list")') })
}

async function openAdlists(page: Page) {
  await page.goto('/settings/adlists')
  await page.waitForLoadState('networkidle')
  await expect(instancePicker(page)).toBeVisible()
}

test.beforeAll(async () => {
  await resetMock(PRIMARY.mock)
  await resetMock(REPLICA.mock)
})

// ─── Block A: the primary ────────────────────────────────────────────────────
test.describe.serial('Block A: primary (Pi-Hole-Node-1)', () => {
  test.beforeEach(async ({ page }) => {
    await openAdlists(page)
    await selectInstance(page, PRIMARY.name)
  })

  test('A1: opens on the primary; groups column shows names, not raw ids', async ({ page }) => {
    await page.goto('/settings/adlists')
    await page.waitForLoadState('networkidle')
    await expect(instancePicker(page).locator('option:checked')).toHaveText(PRIMARY.name)
    await expect(page.locator('table')).toBeVisible()
    const chip = page.locator('tbody td span[data-slot="group-chip"]').first()
    await expect(chip).toBeVisible()
    expect((await chip.innerText()).trim()).not.toMatch(/^[0-9]+$/)
  })

  test('A2: add an adlist with the group selector', async ({ page }) => {
    await page.click('button:has-text("Add Adlist")')
    await expect(addForm(page)).toBeVisible()
    await expect(addForm(page).getByRole('button', { name: 'Kids', exact: true })).toBeVisible()

    await page.fill('input[type="url"]', TEST_URL_SINGLE)
    await page.fill('input[placeholder="Optional note"]', 'playwright-test')
    await addForm(page).getByRole('button', { name: 'Add', exact: true }).click()

    await expect(addForm(page)).not.toBeVisible()
    await expect(findRow(page, TEST_URL_SINGLE)).toBeVisible()
    expect((await mockWrites(PRIMARY.mock)).some((w) => w.method === 'POST' && w.path === '/api/lists')).toBe(true)
  })

  test('A3: enabled toggle round-trips on the test row only', async ({ page }) => {
    const row = findRow(page, TEST_URL_SINGLE)
    const toggle = row.locator('[role="switch"]')
    const initial = await toggle.getAttribute('aria-checked')
    const flipped = initial === 'true' ? 'false' : 'true'
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', flipped)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', initial!)
    const puts = (await mockWrites(PRIMARY.mock)).filter((w) => w.method === 'PUT')
    expect(puts.every((w) => w.path === `/api/lists/${TEST_URL_SINGLE}`)).toBe(true)
  })

  test('A4: inline group editor opens and cancels', async ({ page }) => {
    const row = findRow(page, TEST_URL_SINGLE)
    await row.hover()
    await row.locator('button[title="Edit groups"]').click()
    await expect(row.locator('button:has-text("Save")')).toBeVisible()
    await row.locator('button:has-text("Cancel")').click()
    await expect(row.locator('button:has-text("Save")')).not.toBeVisible()
    await expect(row.locator('button[title="Edit groups"]')).toBeVisible()
  })

  test('A5: delete the test adlist', async ({ page }) => {
    page.once('dialog', (d) => d.accept())
    await findRow(page, TEST_URL_SINGLE).getByRole('button', { name: /Remove adlist/ }).click()
    await expect(findRow(page, TEST_URL_SINGLE)).toHaveCount(0)
  })

  test('A6: nothing in block A reached the replica', async () => {
    expect(await mockWrites(REPLICA.mock)).toEqual([])
  })
})

// ─── Block B: the replica and the merged view ────────────────────────────────
test.describe.serial('Block B: replica (Pi-Hole-Node-2) and All Instances', () => {
  test('B1: replica is read-only: banner, no Add, disabled switch, lock instead of delete', async ({ page }) => {
    await openAdlists(page)
    await selectInstance(page, REPLICA.name)
    await expect(page.getByText('Read-only replica.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Adlist' })).toHaveCount(0)
    await expect(page.locator('tbody [role="switch"]').first()).toBeDisabled()
    await expect(page.locator('button[title="Edit groups"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Remove adlist/ })).toHaveCount(0)
  })

  test('B2: "Edit on Pi-Hole-Node-1" switches back to the primary', async ({ page }) => {
    await openAdlists(page)
    await selectInstance(page, REPLICA.name)
    await page.getByRole('button', { name: `Edit on ${PRIMARY.name}` }).click()
    await expect(instancePicker(page).locator('option:checked')).toHaveText(PRIMARY.name)
  })

  test('B3: All view has no pencil, and the add form has no per-node targets', async ({ page }) => {
    await openAdlists(page)
    await selectInstance(page, '__all__')
    await expect(page.locator('table')).toBeVisible()
    await expect(page.locator('button[title="Edit groups"]')).toHaveCount(0)
    await page.click('button:has-text("Add Adlist")')
    await expect(addForm(page)).toBeVisible()
    await expect(page.getByText('Add to instances')).toHaveCount(0)
  })

  test('B4: adding from the All view writes to the primary only', async ({ page }) => {
    await resetMock(REPLICA.mock)
    await openAdlists(page)
    await selectInstance(page, '__all__')
    await page.click('button:has-text("Add Adlist")')
    await page.fill('input[type="url"]', TEST_URL_ALL)
    await page.fill('input[placeholder="Optional note"]', 'playwright-test-all')
    await addForm(page).getByRole('button', { name: 'Add', exact: true }).click()
    await expect(addForm(page)).not.toBeVisible()

    const rows = findRow(page, TEST_URL_ALL)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(PRIMARY.name)
    expect(await mockWrites(REPLICA.mock)).toEqual([])
  })

  test('B5: cleanup from the All view', async ({ page }) => {
    await openAdlists(page)
    await selectInstance(page, '__all__')
    page.once('dialog', (d) => d.accept())
    await findRow(page, TEST_URL_ALL).getByRole('button', { name: /Remove adlist/ }).click()
    await expect(findRow(page, TEST_URL_ALL)).toHaveCount(0)
  })
})

// ─── Block C: gravity (allowed on every node, one at a time) ─────────────────
test.describe.serial('Block C: gravity panel', () => {
  test('C1: replica note is shown and gravity runs on the replica alone', async ({ page }) => {
    await openAdlists(page)
    const panel = page.locator('.surface').filter({ has: page.locator('h3:has-text("Update Gravity")') })
    await expect(panel.getByText('does not rebuild its gravity')).toBeVisible()

    // Opening on the primary preselects only it; switch the target to the replica.
    const primaryBtn = panel.getByRole('button', { name: PRIMARY.name, exact: true })
    const replicaBtn = panel.getByRole('button', { name: REPLICA.name, exact: true })
    if ((await primaryBtn.getAttribute('aria-pressed')) === 'true') await primaryBtn.click()
    if ((await replicaBtn.getAttribute('aria-pressed')) !== 'true') await replicaBtn.click()

    await resetMock(PRIMARY.mock)
    await resetMock(REPLICA.mock)
    await panel.getByRole('button', { name: 'Update Gravity' }).click()
    await expect(panel.locator('span').filter({ hasText: 'Done' })).toHaveCount(1, { timeout: 60_000 })

    expect((await mockWrites(REPLICA.mock)).map((w) => w.path)).toEqual(['/api/action/gravity'])
    expect(await mockWrites(PRIMARY.mock)).toEqual([])
  })
})
