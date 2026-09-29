<script setup lang="ts">
// Workflow view — a top-level mode (like Chat/Board) that triggers a porch
// pipeline run and visualizes it as a live stepper: one node per pipeline
// stage, each expandable to its streamed output (text / reasoning / tool
// calls). Ported from Paseo's workflow panel; the porch run-dir reader is
// adapted to THIS host's format (audit.jsonl + turns/, not normalized/).
//
// SKELETON PLACEHOLDER — the workflow workstream (cc/workflow) replaces the
// body below with the real stepper. This stub only proves the view is wired
// into the shell and builds green. Do not ship it as-is.
//
// Data path: the browser cannot read ~/.cache/pragmatic-orchestration/steer
// directly. Read porch runs through the state server's read-only porch
// endpoint (GET /api/porch/runs, GET /api/porch/runs/:id) — see
// server/acp-state-server.mjs. The store lib for it lands under
// src/lib/porch/ in the workflow workstream.
</script>

<template>
  <div class="workflow-view">
    <div class="workflow-empty">
      <p class="workflow-title">Workflow</p>
      <p class="workflow-hint">
        Pipeline visualization is being wired up.
      </p>
    </div>
  </div>
</template>

<style scoped>
.workflow-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.workflow-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted, #888);
}
.workflow-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text, #ddd);
}
.workflow-hint {
  font-size: 13px;
}
</style>
