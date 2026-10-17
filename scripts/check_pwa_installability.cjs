// Separate from UI emulation: use a regular profile with strict certificate
// validation. A passing UI/worker test with TLS bypass is insufficient.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

(async () => {
  if (!process.env.UI_TEST_URL) throw new Error('Set UI_TEST_URL to the device-facing HTTPS origin.');
  const target = new URL('/chat', process.env.UI_TEST_URL);
  if (target.protocol !== 'https:') throw new Error('Installability must be checked on HTTPS.');
  const profile = mkdtempSync(join(tmpdir(), 'acp-pwa-installability-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
      ignoreHTTPSErrors: false, args: ['--no-sandbox'],
    });
    // Avoid restoring user chats; app assets, manifest, icons, TLS and worker
    // are fetched from the actual deployment.
    await context.addInitScript(() => localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: {} })));
    await context.route('**/api/**', route => route.fulfill({ json: { rev: 1, data: {}, projects: [], sessions: [], cards: [] } }));
    const page = await context.newPage();
    try { await page.goto(target.href, { waitUntil: 'networkidle', timeout: 20000 }); }
    catch (error) {
      console.error(JSON.stringify({ installable: false, origin: target.origin, stage: 'navigation', error: error.message.split('\n')[0] }));
      process.exitCode = 1;
      return;
    }
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    const { errors: manifestErrors } = await cdp.send('Page.getAppManifest');
    const installable = !installabilityErrors.length && !manifestErrors.length;
    console.log(JSON.stringify({ installable, origin: target.origin, installabilityErrors, manifestErrors }));
    if (!installable) process.exitCode = 1;
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
