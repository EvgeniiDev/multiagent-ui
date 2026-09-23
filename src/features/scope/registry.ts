// The single seam through which the scope feature (selector, session list,
// Projects view) reaches the projects registry.
//
// The real store lives at `src/stores/projects.ts` (W1) — same Pinia id
// (`projects`), same KV document (`projects.json`). Every scope consumer
// imports through this file so the seam stays one line wide.
export { useProjectsStore } from '../../stores/projects';
export type { Project } from '../../stores/projects';
