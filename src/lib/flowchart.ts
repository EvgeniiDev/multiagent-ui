// Minimal dependency-free renderer for the `flowchart`/`graph` subset of
// mermaid syntax — produces an inline SVG so a diagram fence can ride a
// message's v-html instead of shipping a chart library. Supported:
// TD/TB/BT/LR/RL headers, node shapes [x] (x) ([x]) ((x)) [[x]] [(x)] {x}
// {{x}} >x], chains `A --> B --> C`, fan-out `A & B --> C`, edge labels as
// `-->|label|` and `-- label -->`, quoted labels and `<br>` line breaks.
// `subgraph`/`end` boundaries collapse (their contents still render flat);
// style/class/click/linkStyle lines are skipped. Input that is not a
// flowchart returns null so the caller falls back to the code block.

type FlowDirection = 'TD' | 'BT' | 'LR' | 'RL';
type FlowShape = 'rect' | 'round' | 'stadium' | 'circle' | 'diamond';

interface FlowNode {
  id: string;
  lines: string[];
  shape: FlowShape;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  arrow: boolean;
}

// Splits a statement into alternating node / edge-operator tokens. The
// `-- text -->` form is one operator (mermaid reads `A -- B --> C` as
// A->C labelled B), so it is listed before the bare arrows.
const EDGE_RE =
  /\s*((?:--\s+[^|]+?\s+(?:-->|-\.->|==>)|-->|-\.->|==>|---)\s*(?:\|[^|]*\|)?)\s*/;

// id + optional bracketed label. Shape groups are ordered longest-first:
// ([x]) before (x), ((x)) before (x), [[x]] and [(x)] before [x], {{x}}
// before {x}.
const NODE_RE =
  /^([\p{L}\p{N}_][\p{L}\p{N}_$.]*)\s*(?:\(\[\s*(.+?)\s*\]\)|\(\(\s*(.+?)\s*\)\)|\(\s*(.+?)\s*\)|\[\[\s*(.+?)\s*\]\]|\[\(\s*(.+?)\s*\)\]|\{\{\s*(.+?)\s*\}\}|\{\s*(.+?)\s*\}|>\s*(.+?)\s*\]|\[\s*(.+?)\s*\])?$/u;

// Shape lookup parallel to NODE_RE's bracket groups.
const GROUP_SHAPES: FlowShape[] = [
  'stadium', // ([x])
  'circle', // ((x))
  'round', // (x)
  'rect', // [[x]]
  'rect', // [(x)]
  'diamond', // {{x}}
  'diamond', // {x}
  'rect', // >x]
  'rect', // [x]
];

const SKIP_RE =
  /^(?:subgraph\b|end\b|direction\b|style\b|class\b|classDef\b|click\b|linkStyle\b|%%)/i;

const CHAR_W = 7.6; // px per char at 13px — latin and cyrillic average out
const LINE_H = 19;
const NODE_PAD_X = 16;
const NODE_PAD_Y = 11;
const PAD = 20;
const GAP_CROSS = 26;
const GAP_MAIN = 64;
const FONT = 13;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function unquote(s: string): string {
  const t = s.trim();
  return t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

// Statements split on newlines and on `;` — but a `;` inside a bracketed
// label (`&amp;`, `A[a;b]`) is label text, not a separator.
function splitStatements(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  const push = (end: number) => {
    const s = src.slice(start, end).trim();
    if (s) out.push(s);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') quote = !quote;
    else if (!quote && '([{'.includes(c)) depth++;
    else if (!quote && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (!quote && (c === '\n' || (c === ';' && depth === 0))) {
      push(i);
      start = i + 1;
    }
  }
  push(src.length);
  return out;
}

// Fan-out `A & B` splits on top-level `&` only — an `&` inside a quoted or
// bracketed label belongs to the label.
function splitFan(tok: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < tok.length; i++) {
    const c = tok[i];
    if (c === '"') quote = !quote;
    else if (!quote && '([{'.includes(c)) depth++;
    else if (!quote && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (!quote && c === '&' && depth === 0) {
      out.push(tok.slice(start, i));
      start = i + 1;
    }
  }
  out.push(tok.slice(start));
  return out;
}

let diagramSeq = 0;

export function renderFlowchart(source: string): string | null {
  const stmts = splitStatements(source);
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  let dir: FlowDirection = 'TD';
  let headerSeen = false;
  let anonSeq = 0;

  const addNode = (raw: string): string => {
    const tok = raw.trim();
    if (!tok) return '';
    const m = NODE_RE.exec(tok);
    let id: string;
    let label: string | undefined;
    let shape: FlowShape = 'rect';
    if (m) {
      id = m[1];
      for (let i = 0; i < GROUP_SHAPES.length; i++) {
        if (m[i + 2] !== undefined) {
          label = m[i + 2];
          shape = GROUP_SHAPES[i];
          break;
        }
      }
    } else {
      // Unparseable token (e.g. a stray shape): keep it as a labelled node
      // rather than bailing on the whole diagram.
      id = `n${anonSeq++}`;
      label = tok;
    }
    const existing = nodes.get(id);
    if (existing) {
      // First explicit label/shape wins; a bare id reuse upgrades nothing.
      if (label !== undefined && existing.lines.join('\n') === existing.id) {
        existing.lines = unquote(label).split(/<br\s*\/?>/i).map((l) => l.trim());
        existing.shape = shape;
      }
      return id;
    }
    nodes.set(id, {
      id,
      lines: unquote(label ?? id).split(/<br\s*\/?>/i).map((l) => l.trim()),
      shape,
      x: 0, y: 0, w: 0, h: 0,
    });
    return id;
  };

  const parseEdge = (tok: string): { label: string; arrow: boolean } => {
    let t = tok;
    let label = '';
    const pipe = /\|([^|]*)\|\s*$/.exec(t);
    if (pipe) {
      label = pipe[1].trim();
      t = t.slice(0, pipe.index);
    }
    const textual = /--\s+(.+?)\s+(?:-->|-\.->|==>)\s*$/.exec(t);
    if (textual) label = label || textual[1].trim();
    return { label, arrow: !/^---\s*$/.test(t) };
  };

  for (const stmt of stmts) {
    if (!headerSeen) {
      const h = /^(?:flowchart|graph)\b\s*(.*)$/i.exec(stmt);
      if (!h) return null;
      headerSeen = true;
      const d = (h[1] ?? '').trim().toUpperCase();
      dir = d === 'BT' || d === 'LR' || d === 'RL' ? d : 'TD';
      continue;
    }
    if (SKIP_RE.test(stmt)) continue;
    const parts = stmt.split(EDGE_RE);
    const nodeToks: string[] = [];
    const edgeToks: string[] = [];
    parts.forEach((p, i) => (i % 2 === 0 ? nodeToks : edgeToks).push(p));
    if (edgeToks.length === 0) {
      for (const t of splitFan(nodeToks[0])) addNode(t);
      continue;
    }
    const ids = nodeToks.map((t) => splitFan(t).map(addNode).filter(Boolean));
    edgeToks.forEach((eTok, i) => {
      const { label, arrow } = parseEdge(eTok);
      for (const a of ids[i]) {
        for (const b of ids[i + 1] ?? []) {
          edges.push({ from: a, to: b, label, arrow });
        }
      }
    });
  }
  if (!headerSeen || edges.length === 0 || nodes.size < 2) return null;

  // --- layout -------------------------------------------------------------
  for (const n of nodes.values()) {
    let w = Math.max(...n.lines.map((l) => l.length), 1) * CHAR_W + NODE_PAD_X * 2;
    let h = n.lines.length * LINE_H + NODE_PAD_Y * 2;
    if (n.shape === 'diamond') {
      w *= 1.5;
      h += 14;
    }
    if (n.shape === 'circle') {
      w = h = Math.max(w, h) + 12;
    }
    n.w = Math.ceil(Math.min(Math.max(w, 56), 340));
    n.h = Math.ceil(h);
  }

  // Longest-path layering over the acyclic part (Kahn); nodes locked in a
  // cycle take whatever their settled predecessors allow.
  const layer = new Map<string, number>([...nodes.keys()].map((id) => [id, 0]));
  const indeg = new Map<string, number>([...nodes.keys()].map((id) => [id, 0]));
  const succ = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to) continue;
    (succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...nodes.keys()].filter((id) => indeg.get(id) === 0);
  const settled = new Set<string>();
  while (queue.length) {
    const u = queue.shift()!;
    settled.add(u);
    for (const v of succ.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      if (indeg.set(v, indeg.get(v)! - 1).get(v) === 0) queue.push(v);
    }
  }
  for (const id of nodes.keys()) {
    if (settled.has(id)) continue;
    let d = 0;
    for (const e of edges) {
      if (e.to === id && e.from !== id) d = Math.max(d, layer.get(e.from)! + 1);
    }
    layer.set(id, d);
  }
  const ranks = new Map([...new Set(layer.values())].sort((a, b) => a - b).map((v, i) => [v, i]));
  const layers: FlowNode[][] = [];
  for (const n of nodes.values()) {
    const r = ranks.get(layer.get(n.id)!)!;
    (layers[r] ??= []).push(n);
  }

  const horiz = dir === 'LR' || dir === 'RL';
  const main = (n: FlowNode) => (horiz ? n.w : n.h);
  const cross = (n: FlowNode) => (horiz ? n.h : n.w);
  const mainOf: number[] = [];
  const crossOf: number[] = [];
  let totalMain = PAD;
  layers.forEach((row, i) => {
    mainOf[i] = Math.max(...row.map(main));
    crossOf[i] = row.reduce((s, n) => s + cross(n), 0) + GAP_CROSS * (row.length - 1);
    totalMain += i === 0 ? 0 : GAP_MAIN;
    totalMain += mainOf[i];
  });
  totalMain += PAD;
  const totalCross = Math.max(...crossOf) + PAD * 2;

  let mainCursor = PAD;
  layers.forEach((row, i) => {
    if (i > 0) mainCursor += mainOf[i - 1] + GAP_MAIN;
    let crossCursor = PAD + (totalCross - PAD * 2 - crossOf[i]) / 2;
    for (const n of row) {
      let m = mainCursor + (mainOf[i] - main(n)) / 2;
      if (dir === 'BT' || dir === 'RL') m = totalMain - m - main(n);
      n.x = horiz ? m : crossCursor;
      n.y = horiz ? crossCursor : m;
      crossCursor += cross(n) + GAP_CROSS;
    }
  });
  const svgW = Math.ceil(horiz ? totalMain : totalCross);
  const svgH = Math.ceil(horiz ? totalCross : totalMain);

  // --- paint ---------------------------------------------------------------
  const markerId = `fc-arrow-${++diagramSeq}`;
  const out: string[] = [
    `<div class="flowchart"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="${svgW}" height="${svgH}" role="img">`,
    `<defs><marker id="${markerId}" class="fc-arrow" viewBox="0 0 8 8" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z"/></marker></defs>`,
  ];
  for (const e of edges) {
    const a = nodes.get(e.from)!;
    const b = nodes.get(e.to)!;
    if (a === b) continue;
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    let x1: number, y1: number, x2: number, y2: number, vert: boolean;
    if (Math.abs(bcy - acy) >= Math.abs(bcx - acx)) {
      vert = true;
      const down = bcy > acy;
      x1 = acx; y1 = down ? a.y + a.h : a.y;
      x2 = bcx; y2 = down ? b.y : b.y + b.h;
    } else {
      vert = false;
      const right = bcx > acx;
      x1 = right ? a.x + a.w : a.x; y1 = acy;
      x2 = right ? b.x : b.x + b.w; y2 = bcy;
    }
    const c1 = vert ? `${x1} ${(y1 + y2) / 2}` : `${(x1 + x2) / 2} ${y1}`;
    const c2 = vert ? `${x2} ${(y1 + y2) / 2}` : `${(x1 + x2) / 2} ${y2}`;
    out.push(
      `<path class="fc-edge" d="M${x1} ${y1}C${c1},${c2},${x2} ${y2}"${e.arrow ? ` marker-end="url(#${markerId})"` : ''}/>`,
    );
    if (e.label) {
      const lx = (x1 + x2) / 2;
      const ly = (y1 + y2) / 2 - 5;
      out.push(`<text class="fc-elabel" x="${lx}" y="${ly}" text-anchor="middle">${esc(e.label)}</text>`);
    }
  }
  for (const n of nodes.values()) {
    const cx = n.x + n.w / 2;
    const cy = n.y + n.h / 2;
    switch (n.shape) {
      case 'circle':
        out.push(`<circle class="fc-node" cx="${cx}" cy="${cy}" r="${n.w / 2}"/>`);
        break;
      case 'diamond':
        out.push(`<polygon class="fc-node" points="${cx} ${n.y} ${n.x + n.w} ${cy} ${cx} ${n.y + n.h} ${n.x} ${cy}"/>`);
        break;
      case 'stadium':
        out.push(`<rect class="fc-node" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${n.h / 2}"/>`);
        break;
      case 'round':
        out.push(`<rect class="fc-node" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10"/>`);
        break;
      default:
        out.push(`<rect class="fc-node" x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6"/>`);
    }
    const blockH = n.lines.length * LINE_H;
    const ty = cy - blockH / 2 + FONT + 1;
    const spans = n.lines
      .map((l, i) => `<tspan x="${cx}"${i === 0 ? '' : ` dy="${LINE_H}"`}>${esc(l)}</tspan>`)
      .join('');
    out.push(`<text class="fc-text" x="${cx}" y="${ty}" text-anchor="middle">${spans}</text>`);
  }
  out.push('</svg></div>');
  return out.join('\n');
}
