import { chromium, type FullConfig } from '@playwright/test'
import path from 'path'
import { PRIMARY, REPLICA, login, resetMock } from './helpers'

// Logs in once and saves the session for every spec. Against the local lab it
// also makes the lab DB match what the specs expect (the DB is recreated on
// every start-lab.sh): two instances pointing at the mocks, Node-1 as the
// nebula-sync primary, and both mocks reset.
export default async function globalSetup(config: FullConfig) {
  const use = config.projects[0].use
  const baseURL = use.baseURL as string
  const isLab = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(baseURL)

  const browser = await chromium.launch(use.launchOptions)
  const page = await browser.newPage()
  await login(page, baseURL, 'admin', 'admin')

  if (isLab) {
    const req = page.request
    const rows: { id: string; name: string }[] = await (await req.get(`${baseURL}/api/instances`)).json()
    for (const inst of [PRIMARY, REPLICA]) {
      if (!rows.some((r) => r.name === inst.name)) {
        const res = await req.post(`${baseURL}/api/instances`, {
          data: { name: inst.name, url: inst.mock, password: 'lab', sshUsername: 'pi', sshPassword: 'lab' },
        })
        if (!res.ok()) throw new Error(`creating ${inst.name} failed: ${res.status()} ${await res.text()}`)
      }
    }
    const all: { id: string; name: string }[] = await (await req.get(`${baseURL}/api/instances`)).json()
    const primaryId = all.find((r) => r.name === PRIMARY.name)!.id
    const put = await req.put(`${baseURL}/api/settings`, { data: { primaryInstanceId: primaryId } })
    if (!put.ok()) throw new Error(`setting primary failed: ${put.status()}`)
    await resetMock(PRIMARY.mock)
    await resetMock(REPLICA.mock)
  }

  await page.context().storageState({ path: path.join(__dirname, '.auth.json') })
  await browser.close()
}
