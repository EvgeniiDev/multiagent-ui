// Test-only ESM hooks: resolve the repo's bundler-style imports
// (extensionless + .vue SFCs) so node can run real components.
//
// - extensionless relative specifier → tries .ts / .vue / .mjs / .js / /index.ts
// - *.vue → @vue/compiler-sfc compile (script setup + inlineTemplate) so the
//   emitted module is self-contained erasable TS.
// - .ts → node's built-in type stripping handles it (erasable only).
//
// Registered from the test file via module.register(); nothing here runs in
// the product build.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, extname } from 'node:path';
import { parse, compileScript } from '@vue/compiler-sfc';
import { stripTypeScriptTypes } from 'node:module';

const EXTENSIONS = ['.ts', '.vue', '.mjs', '.js'];
const INDEXES = ['/index.ts', '/index.mjs', '/index.js'];

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      (e.code === 'ERR_MODULE_NOT_FOUND' ||
        e.code === 'ERR_UNKNOWN_FILE_EXTENSION' ||
        e.code === 'ERR_UNSUPPORTED_DIR_IMPORT')
    ) {
      const parentDir = dirname(fileURLToPath(context.parentURL));
      if (!extname(specifier)) {
        for (const ext of EXTENSIONS) {
          const candidate = resolvePath(parentDir, specifier + ext);
          if (existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
      // Bundler-style directory import → index.*
      for (const idx of INDEXES) {
        const candidate = resolvePath(parentDir, specifier + idx);
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    throw e;
  }
}

let sfcSeq = 0;

export async function load(url, context, next) {
  if (!url.endsWith('.vue')) return next(url, context);
  const filename = fileURLToPath(url);
  const sfcSource = readFileSync(filename, 'utf8');
  const { descriptor, errors } = parse(sfcSource, { filename });
  if (errors.length) {
    throw new Error(`SFC parse errors in ${filename}: ${errors.map((e) => e.message).join('; ')}`);
  }
  const id = `test_sfc_${sfcSeq++}`;
  const compiled = compileScript(descriptor, {
    id,
    inlineTemplate: true,
    templateOptions: { ssr: true },
  });
  // inlineTemplate embeds the SSR render function — the module still carries
  // TS annotations (compileScript does not strip them), so run the same
  // erasable-syntax strip the node runtime applies to .ts files.
  let moduleSource = compiled.content;
  if (descriptor.script?.lang === 'ts' || descriptor.scriptSetup?.lang === 'ts') {
    moduleSource = stripTypeScriptTypes(moduleSource, { mode: 'strip' });
  }
  return { format: 'module', source: moduleSource, shortCircuit: true };
}
