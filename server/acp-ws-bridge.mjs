#!/usr/bin/env node
// Compatibility entry point: the deployment-owned bridge implementation is
// canonical in deploy/; this path is retained for Compose and existing tests.
import '../deploy/acp-ws-bridge.mjs';
