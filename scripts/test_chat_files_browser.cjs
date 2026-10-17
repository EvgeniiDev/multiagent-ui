// Chat protocol is a fixture; file reads use the real HTTP adapter. With
// UI_TEST_URL, both the frontend and file reads use the published services.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
function pdfFixture() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const n of [1, 2]) { const stream = `BT /F1 20 Tf 30 300 Td (Chat file page ${n}) Tj ET`; objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`); }
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  data += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(data + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
}
(async () => {
  let browser, staticServer, fileServer;
  const root = process.env.FILE_ROOT || path.resolve(__dirname, '../.agent-tmp/chat-file-fixtures');
  fs.mkdirSync(root, { recursive: true });
  const bytes = {
    'picture.png': fs.readFileSync(path.join(__dirname, '../public/pwa-512.png')),
    'отчёт.md': Buffer.from('# Отчёт\n\nФайл от агента.\n\n[Unsafe](javascript:alert(1)) ![Remote](https://preview-invalid.example/track.png)\n<img src=x onerror=window.previewExecuted=true>\n<script>window.previewExecuted = true</script>'),
    'sample.pdf': pdfFixture(), 'archive.zip': Buffer.from('PK\x03\x04chat-file-download'),
    'slow.txt': Buffer.from('slow old response'),
    'delayed.txt': Buffer.from('Fresh delayed text'),
    'large.txt': Buffer.from('Long report line.\n'.repeat(40000)),
  };
  for (const [name, content] of Object.entries(bytes)) fs.writeFileSync(path.join(root, name), content);
  if (process.env.PREPARE_ONLY) { console.log(root); return; }
  try {
    let base = process.env.UI_TEST_URL;
    if (!base) {
      assert(process.env.BUILD, 'Set BUILD or UI_TEST_URL');
      staticServer = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost').pathname;
        const file = path.join(process.env.BUILD, ['/', '/chat'].includes(url) ? 'index.html' : url);
        try { res.setHeader('Content-Type', { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.html': 'text/html' }[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file)); }
        catch { res.writeHead(404); res.end(); }
      });
      await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${staticServer.address().port}`;
      const { createRequestHandler } = await import(pathToFileURL(path.join(__dirname, '../server/acp-state-server.mjs')));
      fileServer = createServer(createRequestHandler({ request: async () => ({ status: 404, json: {} }) }, { chatFileRoots: [root] }));
      await new Promise(resolve => fileServer.listen(0, '127.0.0.1', resolve));
    }
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 844 }, hasTouch: width < 800, isMobile: width < 800, acceptDownloads: true });
      await context.addInitScript(root => {
        localStorage.setItem('acp-ui:agents', JSON.stringify({ agents: { E2E: { transport: 'websocket', url: 'ws://127.0.0.1:25993/' } } }));
        localStorage.setItem('acp-ui:sessions.json', JSON.stringify({ sessions: [{ id: 'files', agentName: 'E2E', sessionId: 'files', cwd: root, title: 'File preview QA', supportsLoadSession: true, lastUpdated: Date.now() }], openTabs: [{ agentName: 'E2E', sessionId: 'files' }] }));
        localStorage.setItem('acp-ui:preferences.json', JSON.stringify({ lastCwd: root, telemetryEnabled: false }));
      }, root);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const errors = [], failures = [], expectedFailures = [];
      const reads = new Map();
      let holdDelayed = true; const releaseDelayed = [], blockedSignals = [];
      let documentRequests = 0;
      await page.route('https://preview-invalid.example/**', route => { documentRequests++; return route.abort(); });
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', response => {
        if (response.status() >= 400) {
          const url = new URL(response.url());
          if (url.pathname === '/api/chat-files' && [403, 404].includes(response.status())) expectedFailures.push(response.status());
          else failures.push(`${response.status()} ${url.pathname}`);
        }
      });
      await page.route('**/health', r => r.fulfill({ json: { ok: false } }));
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/chat-files') {
          const key = url.searchParams.get('path');
          reads.set(key, (reads.get(key) || 0) + 1);
          if (key?.endsWith('/delayed.txt') && holdDelayed) {
            const response = fileServer
              ? await route.fetch({ url: `http://127.0.0.1:${fileServer.address().port}${url.pathname}${url.search}`, headers: { Origin: 'http://127.0.0.1:25808' } })
              : await route.fetch();
            if (holdDelayed) await new Promise(resolve => { releaseDelayed.push(resolve); blockedSignals.splice(0).forEach(signal => signal()); });
            return route.fulfill({ response }).catch(() => {});
          }
          if (!fileServer) return route.continue();
          const response = await route.fetch({ url: `http://127.0.0.1:${fileServer.address().port}${url.pathname}${url.search}`, headers: { Origin: 'http://127.0.0.1:25808' } });
          return route.fulfill({ response });
        }
        return route.fulfill({ json: url.pathname.includes('/api/state/') ? { rev: 1, data: {}, updatedAt: Date.now() } : { projects: [], sessions: [], cards: [] } });
      });
      const replay = ws => {
        const update = content => ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'files', update: { sessionUpdate: 'agent_message_chunk', content } } }));
        update({ type: 'text', text: `[Picture](${root}/picture.png)\n\n[Report](отчёт.md)\n\n[PDF](${root}/sample.pdf)\n\n[ZIP](${root}/archive.zip)\n\n[Missing](${root}/missing.txt)\n\n[Denied](/etc/passwd.txt)\n\n[Slow](${root}/slow.txt)\n\n[Large](${root}/large.txt)\n\n[Delayed](${root}/delayed.txt)\n\n![Inline image](${root}/picture.png)` });
        update({ type: 'resource', resource: { uri: 'attachment://notes', mimeType: 'text/markdown', text: '# MIME Markdown\n\nFormatted without a filename extension.' } });
        update({ type: 'resource', resource: { uri: 'attachment://embedded.json', mimeType: 'application/json', text: '{"preview":true}' } });
        update({ type: 'resource', resource: { uri: 'attachment://embedded.zip', mimeType: 'application/zip', blob: bytes['archive.zip'].toString('base64') } });
        update({ type: 'resource_link', uri: `${root}/sample.pdf`, name: 'Linked PDF', mimeType: 'application/pdf' });
      };
      await page.routeWebSocket(/wss?:\/\//, ws => ws.onMessage(message => {
        let q; try { q = JSON.parse(String(message)); } catch { return; }
        if (!q.method || q.id == null) return;
        let result = {};
        if (q.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] };
        if (q.method === 'session/list') result = { sessions: [] };
        if (q.method === 'session/load') replay(ws);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: q.id, result }));
      }));
      await page.goto(`${base}/chat?s=E2E%3A%3Afiles`, { waitUntil: 'domcontentloaded' });
      const dialog = page.getByRole('dialog', { name: 'File preview', exact: true });
      const link = name => page.getByRole('link', { name, exact: true });
      const close = async () => { await dialog.getByRole('button', { name: 'Close file preview' }).click(); await dialog.waitFor({ state: 'detached' }); };
      // Previews must already exist in the transcript before opening a modal.
      const cardFor = name => page.locator(`.file-card[data-file-name="${name}"]`);
      const pdfReady = async container => {
        const pdf = container.locator('.pdf-preview');
        await pdf.locator('canvas').waitFor();
        await pdf.getByRole('status').waitFor({ state: 'hidden' });
        assert.equal(await pdf.getByRole('alert').count(), 0, 'PDF renderer reports no error');
        assert(await pdf.locator('canvas').evaluate(canvas => {
          const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0 && pixels[i] + pixels[i + 1] + pixels[i + 2] < 300 && ++ink > 10) return true;
          return false;
        }), 'PDF canvas contains rendered text, not just default dimensions');
      };

      await cardFor('отчёт.md').scrollIntoViewIfNeeded();
      await cardFor('отчёт.md').locator('.markdown-document h1').waitFor();
      assert.match(await cardFor('отчёт.md').textContent(), /Файл от агента/);
      assert.equal(await dialog.count(), 0, 'text preview is inline');
      assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
      assert.equal(await cardFor('отчёт.md').locator('.markdown-document img, .markdown-document a, .markdown-document script').count(), 0);
      assert.equal(documentRequests, 0);
      await cardFor('sample.pdf').first().scrollIntoViewIfNeeded();
      await pdfReady(cardFor('sample.pdf').first());
      assert.equal(await cardFor('sample.pdf').first().getByRole('button', { name: 'Next', exact: true }).count(), 0, 'thumbnail shows first PDF page only');
      const cardOpen = cardFor('sample.pdf').first().getByRole('button', { name: 'Open', exact: true });
      await cardOpen.hover();
      assert.notEqual(await cardOpen.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)');
      await page.keyboard.press('Tab'); await cardOpen.focus();
      assert.equal(await cardOpen.evaluate(e => getComputedStyle(e).outlineWidth), '2px');
      if (width < 800) assert((await cardOpen.boundingBox()).height >= 44);
      const beforeOpen = reads.get(`${root}/sample.pdf`) || 0;
      await cardOpen.click();
      await pdfReady(dialog);
      assert.equal(reads.get(`${root}/sample.pdf`), beforeOpen, 'opening a loaded card reuses its bytes');
      const cardDownloadEvent = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Download', exact: true }).click();
      assert.deepEqual(fs.readFileSync(await (await cardDownloadEvent).path()), bytes['sample.pdf']);
      await close();
      if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await cardFor('отчёт.md').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.SHOTS, `inline-files-${width}.png`) }); }
      await cardFor('delayed.txt').scrollIntoViewIfNeeded();
      await cardFor('delayed.txt').getByRole('status').waitFor();
      if (!releaseDelayed.length) await Promise.race([new Promise(resolve => blockedSignals.push(resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('delayed request not held')), 5000))]);
      await link('Picture').scrollIntoViewIfNeeded();
      await cardFor('delayed.txt').getByRole('status').waitFor({ state: 'hidden' });
      holdDelayed = false; releaseDelayed.splice(0).forEach(resolve => resolve());
      await page.waitForTimeout(100);
      assert.equal(await cardFor('delayed.txt').locator('pre').count(), 0, 'late response cannot repopulate an offscreen card');
      await cardFor('delayed.txt').scrollIntoViewIfNeeded();
      await cardFor('delayed.txt').locator('pre').waitFor();
      assert.match(await cardFor('delayed.txt').locator('pre').textContent(), /Fresh delayed text/);
      await cardFor('notes').scrollIntoViewIfNeeded();
      await cardFor('notes').locator('.markdown-document h1').waitFor();
      await cardFor('notes').getByRole('button', { name: 'Open', exact: true }).click();
      await dialog.locator('.markdown-document h1').waitFor(); await close();
      await cardFor('embedded.json').scrollIntoViewIfNeeded();
      await cardFor('embedded.json').locator('pre').waitFor();
      assert.match(await cardFor('embedded.json').locator('pre').textContent(), /preview/);
      assert.equal(await cardFor('archive.zip').count(), 0, 'archives keep download links');
      await link('Picture').click();
      await dialog.waitFor();
      await page.waitForFunction(() => document.querySelector('dialog.file-preview img')?.naturalWidth === 512);
      assert(await dialog.evaluate(e => e.matches(':modal')));
      const download = async (name, expected) => {
        const event = page.waitForEvent('download');
        await dialog.getByRole('button', { name: 'Download', exact: true }).click();
        const file = await event;
        assert.equal(file.suggestedFilename(), name);
        assert.deepEqual(fs.readFileSync(await file.path()), expected);
      };
      await download('picture.png', bytes['picture.png']);
      for (const scheme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: scheme });
        const box = await dialog.boundingBox(); assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= 845, JSON.stringify({ width, box, viewport: await page.evaluate(() => ({ w: innerWidth, h: innerHeight })) }));
        const tokenStyles = await dialog.evaluate(e => { const css = getComputedStyle(e); return { background: css.backgroundColor, token: css.getPropertyValue('--bg-main').trim(), color: css.color }; });
        assert(tokenStyles.background !== 'rgba(0, 0, 0, 0)' && tokenStyles.token, 'viewer uses theme surface tokens');
        const downloadButton = dialog.getByRole('button', { name: 'Download', exact: true });
        await downloadButton.hover();
        assert.notEqual(await downloadButton.evaluate(e => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'shared hover style visible');
        const button = dialog.getByRole('button', { name: 'Close file preview' });
        if (width < 800) assert((await button.boundingBox()).height >= 44);
        await page.keyboard.press('Tab');
        await button.focus(); assert.equal(await button.evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
      }
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      assert(await link('Picture').evaluate(e => e === document.activeElement));
      await link('Report').click(); await dialog.locator('.markdown-document h1').waitFor();
      assert.match(await dialog.locator('.markdown-document').textContent(), /Файл от агента/);
      assert.equal(await page.evaluate(() => window.previewExecuted), undefined, 'file text cannot execute HTML');
      assert.equal(await dialog.locator('.markdown-document img, .markdown-document a, .markdown-document script').count(), 0);
      assert.equal(documentRequests, 0);
      await download('отчёт.md', bytes['отчёт.md']); await close();
      await link('Large').click(); await dialog.locator('pre').waitFor();
      assert.match(await dialog.locator('pre').textContent(), /Preview limited to 512 KB/);
      await download('large.txt', bytes['large.txt']); await close();
      await link('PDF').click();
      await pdfReady(dialog);
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await dialog.getByText('Page 2 / 2', { exact: true }).waitFor();
      assert(await dialog.getByRole('button', { name: 'Next', exact: true }).isDisabled());
      await dialog.getByRole('button', { name: 'Previous', exact: true }).click();
      await dialog.getByText('Page 1 / 2', { exact: true }).waitFor();
      await download('sample.pdf', bytes['sample.pdf']);
      if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, `file-preview-pdf-${width}.png`) }); }
      await close();
      await link('ZIP').click(); await dialog.getByText('Preview is unavailable for this format. You can download the file.').waitFor();
      await download('archive.zip', bytes['archive.zip']); await close();
      for (const name of ['Missing', 'Denied']) { await link(name).click(); await dialog.getByRole('alert').waitFor(); assert(await dialog.getByRole('button', { name: 'Download', exact: true }).isDisabled()); assert.equal(await dialog.getByRole('button', { name: 'Download', exact: true }).evaluate(e => getComputedStyle(e).opacity), '0.5'); await close(); }
      const attachment = name => page.locator('.attachment-block').filter({ hasText: name });
      await attachment('embedded.json').getByRole('button', { name: 'Open', exact: true }).click(); await dialog.locator('pre').waitFor(); assert.match(await dialog.locator('pre').textContent(), /"preview":true/); await close();
      await attachment('embedded.zip').getByRole('button', { name: 'View file' }).click(); await dialog.getByText('Preview is unavailable for this format. You can download the file.').waitFor(); await download('embedded.zip', bytes['archive.zip']); await close();
      await page.locator('.attachment-block').filter({ has: page.locator('.file-card[data-file-name="sample.pdf"]') }).getByRole('button', { name: 'Open', exact: true }).click(); await pdfReady(dialog); await close();
      await page.route('**/api/chat-files?*', async route => {
        if (!new URL(route.request().url()).searchParams.get('path')?.endsWith('/slow.txt')) return route.fallback();
        await new Promise(resolve => setTimeout(resolve, 500));
        await route.fulfill({ contentType: 'text/plain', body: 'slow old response' }).catch(() => {});
      });
      await link('Slow').click(); await dialog.getByRole('status').waitFor();
      assert(await dialog.getByRole('button', { name: 'Download', exact: true }).isDisabled());
      await close(); await link('Report').click(); await dialog.locator('.markdown-document h1').waitFor();
      await page.waitForTimeout(600);
      assert.match(await dialog.locator('.markdown-document').textContent(), /Файл от агента/, 'old response cannot replace a newer preview');
      await close();
      const current = page.url(); await page.reload();
      await link('Report').click(); await dialog.locator('.markdown-document h1').waitFor(); assert.equal(page.url(), current); await close();
      assert(expectedFailures.includes(403) && expectedFailures.includes(404));
      assert.deepEqual(errors, []); assert.deepEqual(failures, []);
      console.log(`PASS ${width}px: actual file HTTP adapter, image/PDF/text/ZIP, Unicode/relative links, embedded resources, resource links, download bytes, modal/focus/Escape, themes/touch, errors, replay/reload`);
      await context.close();
    }
  } finally { await browser?.close(); for (const server of [staticServer, fileServer]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
