#!/usr/bin/env bash
# Provision host Pi ACP with the exact versions used by Docker. This changes
# packages under the hermes user only; it does not start or stop any bridge.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM="$(command -v npm)"
"$NPM" install --global --prefix "$HOME/.local" \
  @earendil-works/pi-coding-agent@0.85.1 pi-acp@0.0.33
node "$REPO_DIR/deploy/patch-pi-acp-multisession.mjs" "$HOME/.local/lib/node_modules/pi-acp"
node "$REPO_DIR/deploy/patch-pi-acp-steering.mjs" "$HOME/.local/lib/node_modules/pi-acp"
node --input-type=module - "$HOME/.local/lib/node_modules/pi-acp" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const code = fs.readFileSync(path.join(root, 'dist/index.js'), 'utf8');
if (pkg.version !== '0.0.33' || !code.includes('acp-ui shared bridge: retain independent Pi sessions (v2)') ||
    !code.includes('acp-ui: native non-interrupting Pi steering (v1)')) {
  throw new Error('host pi-acp provisioning verification failed');
}
console.log(`PASS pi-acp ${pkg.version}: multisession and steering patches verified`);
NODE
pi --version
pi-acp --version
