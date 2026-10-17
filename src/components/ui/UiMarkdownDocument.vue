<script setup lang="ts">
import { computed } from 'vue';
import { marked, Renderer } from 'marked';
const props = defineProps<{ text: string }>();
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// File contents are untrusted. Keep formatting, but no HTML, image fetches or
// active links from a generated document in the panel's origin.
const renderer = new Renderer();
renderer.html = token => escapeHtml(token.text);
renderer.image = token => escapeHtml(token.text);
renderer.link = function (token) { return this.parser.parseInline(token.tokens); };
const html = computed(() => marked.parse(props.text, { renderer, async: false }) as string);
</script>

<template><div class="markdown-document" v-html="html" /></template>

<style scoped>
.markdown-document { color: var(--text-primary); text-align: left; font: 0.8125rem/1.6 var(--font-ui); overflow-wrap: anywhere; min-width: 0; overflow-x: auto; }
.markdown-document :deep(h1) { font-size: 1.25rem; line-height: 1.3; }
.markdown-document :deep(h2) { font-size: 1.0625rem; line-height: 1.4; }
.markdown-document :deep(h3) { font-size: 0.9375rem; }
.markdown-document :deep(h1), .markdown-document :deep(h2), .markdown-document :deep(h3) { margin: 0.75rem 0 0.5rem; }
.markdown-document :deep(p), .markdown-document :deep(ul), .markdown-document :deep(ol) { margin: 0.5rem 0; }
.markdown-document :deep(ul), .markdown-document :deep(ol) { padding-left: 1.25rem; }
.markdown-document :deep(pre) { padding: 0.75rem; background: var(--bg-code); border-radius: var(--radius-md); white-space: pre-wrap; font: 0.75rem/1.5 var(--font-mono); }
.markdown-document :deep(code) { font-family: var(--font-mono); }
.markdown-document :deep(table) { width: 100%; border-collapse: collapse; font-size: 0.75rem; }
.markdown-document :deep(th), .markdown-document :deep(td) { padding: 0.375rem 0.5rem; border: 1px solid var(--border-color); text-align: left; }
.markdown-document :deep(blockquote) { margin: 0.5rem 0; padding-left: 0.75rem; border-left: 2px solid var(--border-strong); color: var(--text-secondary); }
</style>
