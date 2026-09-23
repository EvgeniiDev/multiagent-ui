// The single seam through which the scope feature (selector, session list,
// Projects view) reaches the projects registry.
//
// W1 (branch cc/v2-projects) owns the real store at `src/stores/projects.ts`
// — frozen contract recorded in the W2 brief. Until it merges, the local
// stub stands in: same Pinia id (`projects`), same KV document
// (`projects.json`), same API, so the flip below is the ONLY change needed
// after the merge.
//
// TODO(w1-merge): use the real store and delete __local-projects-stub.ts.
// export { useProjectsStore } from '../../stores/projects';
// export type { Project } from '../../stores/projects';
export { useProjectsStore } from './__local-projects-stub';
export type { Project } from './__local-projects-stub';
