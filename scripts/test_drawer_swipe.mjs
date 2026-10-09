import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/drawerSwipe.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { createDrawerSwipe } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
function harness({ open = false, narrow = true } = {}) {
  const state = { open, narrow };
  const swipe = createDrawerSwipe({ isEnabled: () => state.narrow, isOpen: () => state.open, setOpen: value => { state.open = value; } });
  const point = (x, y, id = 1, primary = true) => ({ clientX: x, clientY: y, pointerId: id, pointerType: 'touch', isPrimary: primary, target: null });
  return { state, swipe, point };
}
test('a deliberate right swipe from the left edge opens the drawer', () => {
  const { state, swipe, point } = harness();
  swipe.start(point(12, 250)); swipe.move(point(95, 258)); swipe.end(point(100, 260));
  assert.equal(state.open, true);
});
test('scrolling, tapping and swiping within the content do not open it', () => {
  for (const [start, end] of [[[12,250],[15,350]],[[12,250],[14,251]],[[100,250],[210,255]],[[12,250],[-60,255]],[[12,250],[70,310]]]) {
    const { state, swipe, point } = harness();
    swipe.start(point(...start)); swipe.move(point(...end)); swipe.end(point(...end));
    assert.equal(state.open, false);
  }
});
test('vertical scrolling stays vertical even if the finger later moves sideways', () => {
  const { state, swipe, point } = harness();
  swipe.start(point(12,250)); swipe.move(point(14,290)); swipe.end(point(130,300));
  assert.equal(state.open, false);
});
test('a left swipe closes the drawer; vertical scrolling keeps it open', () => {
  const { state, swipe, point } = harness({ open: true });
  swipe.start(point(200,250)); swipe.move(point(195,350)); swipe.end(point(195,350));
  assert.equal(state.open, true);
  swipe.start(point(200,250)); swipe.move(point(100,255)); swipe.end(point(95,256));
  assert.equal(state.open, false);
});
test('desktop, mouse, cancelled and multi-touch gestures do not toggle it', () => {
  const a = harness({ narrow:false });a.swipe.start(a.point(5,200));a.swipe.end(a.point(100,200));assert.equal(a.state.open,false);
  const b = harness();b.swipe.start({...b.point(5,200),pointerType:'mouse'});b.swipe.end(b.point(100,200));assert.equal(b.state.open,false);
  const c = harness();c.swipe.start(c.point(5,200));c.swipe.cancel();c.swipe.end(c.point(100,200));assert.equal(c.state.open,false);
  const d = harness();d.swipe.start(d.point(5,200));d.swipe.start(d.point(10,200,2,false));d.swipe.end(d.point(100,200));assert.equal(d.state.open,false);
});
test('another pointer and a layout change cannot complete an earlier gesture', () => {
  const { state, swipe, point } = harness();
  swipe.start(point(5,200)); swipe.end(point(100,200,2)); assert.equal(state.open,false);
  swipe.start(point(5,200)); state.narrow=false; swipe.end(point(100,200)); assert.equal(state.open,false);
});
