import test from 'node:test';
import assert from 'node:assert/strict';
import { auditSource } from './check_ui_library.mjs';
const audit = source => auditSource(source, 'src/components/Example.vue');
test('reject native controls outside shared primitives', () => {
  assert(audit('<template><button>Save</button></template>').some(s => s.includes('Use UiButton')));
  for (const tag of ['input', 'select', 'textarea']) assert(audit(`<template><${tag} /></template>`).some(s => s.includes('ui-input')));
  assert(audit('<template><input type="checkbox" /></template>').some(s => s.includes('ui-checkbox')));
});
test('accept library controls, field semantics and layout CSS', () => {
  assert.deepEqual(audit('<template><UiButton class="save" :disabled="busy">Save</UiButton><select class="ui-input" /><input type="checkbox" class="ui-checkbox" /></template><style scoped>.save { margin-left: auto; flex: 1; width: 100%; }</style>'), []);
  assert.deepEqual(auditSource('<template><button /></template>', 'src/components/ui/UiButton.vue'), []);
});
test('reject page appearance overrides and inline styles', () => {
  for (const property of ['background', 'color', 'border', 'font-size', 'outline', 'padding']) assert(audit(`<template><UiButton class="save">Save</UiButton></template><style scoped>.save:hover { ${property}: red; }</style>`).some(s => s.includes('must be owned')));
  assert(audit('<template><UiButton :style="{ color: red }" /></template>').some(s => s.includes('inline styles')));
});
test('ignore comments, strings and descendant content styles', () => {
  assert.deepEqual(audit('<script setup>const example = "<button>";</script><template><!-- <button> --><UiButton class="save"><span>Save</span></UiButton></template><style scoped>.save span { color: var(--text-muted); }</style>'), []);
});

test('reject nested shared buttons and internal-class appearance overrides', () => {
  assert(audit('<template><UiButton><UiButton>Close</UiButton></UiButton></template>').some(s => s.includes('Do not nest')));
  assert(audit('<template><UiButton variant="primary">Save</UiButton></template><style scoped>.ds-button--primary { background: red; }</style>').some(s => s.includes('must be owned')));
  assert(audit('<template><UiButton /></template><style scoped>.ui-input { color: red; }</style>').some(s => s.includes('must be owned')));
});
test('reject kebab-case and object-style appearance, permit inline layout', () => {
  for (const property of ['font-size', 'border-radius', 'box-shadow']) {
    assert(audit(`<template><UiButton style="${property}: 60px" /></template>`).some(s => s.includes('inline styles')));
    assert(audit(`<template><UiButton :style="{ '${property}': value }" /></template>`).some(s => s.includes('inline styles')));
  }
  assert(audit('<template><UiButton :style="{ borderWidth: size, opacity: 0 }" /></template>').some(s => s.includes('inline styles')));
  assert.deepEqual(audit('<template><UiButton style="margin: 0; width: 100%" /></template>'), []);
});
