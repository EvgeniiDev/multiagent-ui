/**
 * Shared types for the Projects view and its detail pane.
 *
 * `ProjectRow` is the aggregated view-model the list renders: one row per
 * working directory, rolled up from the sessions the agents reported.
 */
export interface ProjectRow {
  cwd: string;
  name: string;
  sessions: number;
  lastActivity: number;
  agents: string[];
  live: boolean;
  tokens: number;
  cost: number;
  turns: number;
}
