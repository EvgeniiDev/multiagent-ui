// Lazy mermaid loader + DOM hydrator for diagram fences in chat messages.
// The library weighs ~1 MB, so it ships as a separate chunk and loads only
// when a `mermaid`/`flowchart`/`graph` fence (or a bare fence opening with
// a diagram keyword) actually appears. renderMarkdown emits
// `<pre class="mermaid-src">` placeholders; hydrateMermaid swaps each for
// the rendered SVG, leaving the code block in place when mermaid rejects
// the source. Results cache by source text because a streaming message
// rebuilds its v-html on every token.

type MermaidApi = typeof import('mermaid').default;

let mermaid: MermaidApi | null = null;
let mermaidTheme = '';
const renderCache = new Map<string, Promise<string | null>>();

async function getMermaid(): Promise<MermaidApi> {
  mermaid ??= (await import('mermaid')).default;
  const theme =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'default';
  if (mermaidTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      themeVariables: { fontFamily: 'var(--font-ui, sans-serif)' },
    });
    mermaidTheme = theme;
  }
  return mermaid;
}

async function renderOnce(source: string): Promise<string | null> {
  const m = await getMermaid();
  // parse() validates first: render() leaves scratch nodes in <body> on
  // bad input even when it throws.
  await m.parse(source);
  const id = `mmd-${Math.random().toString(36).slice(2)}`;
  try {
    const { svg } = await m.render(id, source);
    return svg;
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

function renderCached(source: string): Promise<string | null> {
  let p = renderCache.get(source);
  if (!p) {
    p = renderOnce(source).catch(() => null);
    renderCache.set(source, p);
    // Unbounded streams would grow this; a diagram per message is the
    // realistic ceiling, but keep it from pinning a whole session's worth.
    if (renderCache.size > 100) renderCache.delete(renderCache.keys().next().value!);
  }
  return p;
}

/** Replace every not-yet-rendered `.mermaid-src` placeholder under `el`
 *  with its SVG. Async and idempotent — safe to call from directive
 *  mounted/updated hooks. */
export function hydrateMermaid(el: HTMLElement): void {
  for (const pre of el.querySelectorAll('pre.mermaid-src:not([data-md-done])')) {
    pre.setAttribute('data-md-done', '1');
    const source = pre.textContent ?? '';
    void renderCached(source).then((svg) => {
      if (!svg || !pre.isConnected) return;
      const div = document.createElement('div');
      div.className = 'mermaid';
      div.innerHTML = svg;
      pre.replaceWith(div);
    });
  }
}
