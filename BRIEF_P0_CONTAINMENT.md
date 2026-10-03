# P0 hardening — close document-workspace symlink escape before P0 acceptance

Repo: `/home/hermes/projects/acp-ui-agent-modes`, branch `feat/agent-modes`. You are the sole writer. Preserve the 98 pre-existing dirty/untracked entries; do not clean/stash/reset/commit/push. Do not touch production or upstream skills. This is a narrowly scoped continuation of Idea Preparation P0, not P1.

## Verified defect (reproduce first)

`node scripts/preparation_binding_probe.mjs` registered policy uses `server/execution/preparation/skills/registry.mjs::checkToolCall`; live Pi extension uses equivalent `resolve()` + lexical `underRoot()` in `server/execution/preparation/skills/pi-ext/preparation-bridge.ts`.

I independently created `/tmp/p0-containment-*/workspace/escape` symlink pointing to `../outside`. Current policy returns `allow:true` for both read and write on relative `escape`, and also for absolute `/tmp/.../workspace/escape`, because checks canonicalize lexically and do not resolve symlink targets. This permits read/write through an in-workspace symlink to escape the private workspace and violates the P0 containment contract. The agent's probe evidence reports no violations only because these path cases were absent.

Exact reproduction:

```js
const roots = resolveRoots({skillDirs:[], extraResources:[], readOnlyRoots:[]}, ws, {scratch:false});
checkToolCall('write', {path:'escape'}, roots) // currently {allow:true,...}
checkToolCall('read', {path:'escape'}, roots)  // currently {allow:true,...}
```

## Required work — strict RED→GREEN

1. Add minimal regression tests first. Demonstrate RED for: relative `..` traversal, existing symlink-to-outside target, symlinked parent with nonexistent destination, read through symlink, write/edit through symlink, and a symlink that resolves within an allowed root (must retain intended safe behavior if supported). Use temp dirs only. Run the new tests and capture the expected failure before changing production code.
2. Fix both central `checkToolCall` and the Pi extension pre-execution hook consistently. Resolve real filesystem targets including existing symlink components and nearest-existing-parent for non-existent write targets; fail closed on resolution errors. Preserve supported workspace-relative paths. Apply equivalent policy to bash path auditing if feasible, with tests for `ln -s`/path redirection that prove an escape cannot be created/read/written. Do not weaken existing deny rules.
3. Re-run RED tests GREEN, all `node --test scripts/test_preparation_binding.mjs`, `node scripts/preparation_binding_probe.mjs verify all`, `node scripts/preparation_binding_probe.mjs audit all`, and `npm run build:web`. Audit every evidence verdict; previous transcript tests are not enough to prove new guard behavior.
4. Run a bounded real Pi extension smoke that attempts the symlink escape in a private throwaway workspace and proves the hook BLOCKS before the write/read tool executes. Save transcript, extension audit, and exact blocked reason under the existing P0 evidence root. Do not access the target project writable.
5. Update `docs/reports/agent-idea-preparation-p0.md` with the defect, red/green evidence, exact cases/counts, and revised verdict. Compare final `git status --short` against `/tmp/p0-git-status-initial.txt` plus the expected P0 implementation/report paths; preserve unrelated files. No commit/push.
6. Do not start P1. End with exact command outputs and paths; state DONE only when extension-level containment is independently demonstrated, else PARTIAL with blocker.

No user questions. Keep the fix focused and use test-first development.
