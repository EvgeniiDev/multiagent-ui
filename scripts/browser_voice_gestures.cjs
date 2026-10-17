// Real pointer input for both touchscreen and mouse composer tests.
async function voicePointer(page, button) {
  await page.waitForFunction(el => !el.disabled, await button.elementHandle());
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  const touch = page.viewportSize().width < 800;
  const cdp = touch ? await page.context().newCDPSession(page) : null;
  if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  else { await page.mouse.move(x, y); await page.mouse.down(); }
  let ended = false;
  return {
    x, y,
    async moveTo(nextX, nextY) {
      if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: nextX, y: nextY }] });
      else await page.mouse.move(nextX, nextY, { steps: 5 });
    },
    async release() {
      if (ended) return;
      ended = true;
      if (touch) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); }
      else await page.mouse.up();
    },
    async cancel() {
      if (ended) return;
      ended = true;
      if (touch) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await cdp.detach(); }
      else { await button.dispatchEvent('pointercancel'); await page.mouse.up(); }
    },
  };
}
async function voicePress(page, button, { lock = true, waitForListening = true } = {}) {
  const pointer = await voicePointer(page, button);
  await page.waitForTimeout(420);
  if (waitForListening) await page.waitForFunction(() => document.querySelector('.chat-view:not([style*="display: none"]) .voice-btn.listening'), {}, { timeout: 10000 });
  if (lock) {
    await pointer.moveTo(pointer.x, pointer.y - 64);
    await page.waitForTimeout(60);
    await pointer.release();
  }
  return pointer;
}
module.exports = { voicePress, voicePointer };
