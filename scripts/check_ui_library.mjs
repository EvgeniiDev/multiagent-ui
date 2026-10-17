// Enforce the shared-control boundary on authored Vue templates and component CSS.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse, compileStyle } from 'vue/compiler-sfc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const visual = /^(?:background(?:-|$)|border(?:-|$)|color$|font(?:-|$)|line-height$|outline(?:-|$)|box-shadow$|opacity$|cursor$|text-decoration$|padding(?:-|$))/;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function auditSource(source, filename) {
  const result = parse(source, { filename });
  const failures = result.errors.map(e => `${filename}: ${e.message ?? e}`);
  const classes = new Set();
  const add = (node, message) => failures.push(`${filename}:${node.loc.start.line}: ${message}`);
  function visit(node, insideButton = false) {
    if (node.type === 1) {
      const button = node.tag === 'button' || node.tag === 'UiButton';
      if (button && insideButton) add(node, 'Do not nest buttons; place primary and trailing actions beside each other.');
      const field = ['input', 'select', 'textarea'].includes(node.tag);
      const attrs = Object.fromEntries(node.props.filter(p => p.type === 6).map(p => [p.name, p.value?.content ?? '']));
      if (node.tag === 'button' && filename !== 'src/components/ui/UiButton.vue') add(node, 'Use UiButton; native buttons belong only inside UiButton.vue.');
      if (field && attrs.type !== 'hidden') {
        const primitive = ['checkbox', 'radio'].includes(attrs.type) ? 'ui-checkbox' : attrs.type === 'file' ? 'ui-file' : attrs.type === 'range' ? 'ui-range' : 'ui-input';
        if (!(attrs.class ?? '').split(/\s+/).includes(primitive)) add(node, `Use the shared ${primitive} field primitive.`);
      }
      if (button || field) {
        for (const name of (attrs.class ?? '').split(/\s+/)) if (name) classes.add(name);
        for (const prop of node.props) {
          if (prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'class') {
            for (const match of (prop.exp?.content ?? '').matchAll(/['"]([\w-]+)['"]|\b([\w-]+)\s*:/g)) classes.add(match[1] ?? match[2]);
          }
          const style = prop.type === 6 && prop.name === 'style' ? prop.value?.content : prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'style' ? prop.exp?.content : '';
          if (style) {
            const pattern = prop.type === 6 ? /(?:^|;)\s*([-\w]+)\s*:/g : /(?:^|[,{])\s*['"]?([-\w]+)['"]?\s*:/g;
            const properties = [...style.matchAll(pattern)].map(match => match[1].replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`));
            if (properties.some(property => visual.test(property))) add(node, 'Control appearance belongs in the shared UI library, not inline styles.');
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, insideButton || node.tag === 'button' || node.tag === 'UiButton');
  }
  if (result.descriptor.template?.ast) visit(result.descriptor.template.ast);
  // Shared primitives own appearance. Consumers may only place and size them.
  if (filename.startsWith('src/components/ui/')) return failures;
  for (const style of result.descriptor.styles) {
    const compiled = compileStyle({ source: style.content, filename, id: 'ui-policy', scoped: false });
    for (const error of compiled.errors) failures.push(`${filename}: ${error.message ?? error}`);
    compiled.rawResult?.root.walkRules(rule => {
      const hits = rule.selectors.some(selector => {
        const tail = selector.trim().split(/\s+|[>+~]/).pop();
        if (tail.includes(':not(.ds-button)')) return false;
        if (/\.ds-button(?:--[\w-]+)?(?:[.#:\[)]|$)|\.ui-(?:input|checkbox|range|file)(?:--[\w-]+)?(?:[.#:\[)]|$)/.test(tail)) return true;
        return /^(?:button|input|select|textarea)(?:[.#:\[)]|$)/.test(tail) || [...classes].some(name => new RegExp(`\\.${escape(name)}(?:[.#:\\[)]|$)`).test(tail));
      });
      if (!hits) return;
      for (const decl of rule.nodes ?? []) if (decl.type === 'decl' && visual.test(decl.prop)) {
        failures.push(`${filename}:${style.loc.start.line + decl.source.start.line - 1}: ${rule.selector}: ${decl.prop} must be owned by a shared UI primitive.`);
      }
    });
  }
  return failures;
}

export function checkProject(ref) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(f => f.endsWith('.vue'));
  const failures = [];
  for (const file of [...new Set(files)]) {
    const source = ref ? execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' }) : fs.readFileSync(path.join(root, file), 'utf8');
    failures.push(...auditSource(source, file));
  }
  return { files: files.length, failures };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const refAt = process.argv.indexOf('--ref');
  const result = checkProject(refAt === -1 ? undefined : process.argv[refAt + 1]);
  if (result.failures.length) { console.error(result.failures.join('\n')); process.exitCode = 1; }
  else console.log(`PASS shared UI policy: ${result.files} Vue files; controls use the library and local CSS keeps layout only.`);
}
