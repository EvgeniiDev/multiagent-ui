<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
// Agents tab (F9.9): who is holding what, right now — per executor (the
// CLI a role runs on), which roles it serves, how many of their
// maxConcurrent slots are busy, the card titles held, and the last ledger
// activity/error per role.
//
// Facts only: "in work" comes from live claims in claims.json
// (leaseUntil > now — an expired lease is not live), and last activity /
// last error come from the `card` rows the dispatcher writes to
// activity.json (each carries `role`). A card's own status is an
// intention and is never shown as work in flight.
//
// Release / stop controls write the same documents the runner and
// boardctl use: the claim is dropped from claims.json (rev-checked) and a
// `card` row is appended to activity.json. The panel cannot signal a
// process it does not own — the UI says so instead of pretending.
import { computed, ref } from 'vue';
import { useConfigStore } from '../../stores/config';
import { useRolesStore, type Role } from '../../stores/roles';
import { useBoardStore } from '../../stores/board';
import { useClaimsStore, type CardClaim } from '../../stores/claims';
import { useActivityStore, type ActivityEntry } from '../../stores/activity';
import { fmtStamp, fmtDur } from './format';

const configStore = useConfigStore();
const rolesStore = useRolesStore();
const board = useBoardStore();
const claimsStore = useClaimsStore();
const activity = useActivityStore();

interface HeldCard {
  cardId: string;
  title: string;
  claim: CardClaim;
}

interface RoleRow {
  id: string;
  label: string;
  stages: string[];
  busy: number;
  max: number;
  held: HeldCard[];
  hasRunner: boolean;
  lastAt: number | null;
  lastText: string;
  lastFailed: boolean;
}

interface ExecRow {
  key: string;
  /** '' = the synthetic group for claims that resolve to no known role. */
  cli: string;
  runnerNames: string[];
  runnerIds: string[];
  hasRunner: boolean;
  busy: number;
  max: number;
  roles: RoleRow[];
  /** Claims with no resolvable role (role deleted, claimed via boardctl). */
  orphanHeld: HeldCard[];
}

/** The role a claim was taken under: explicit `roleId`, else the
 * `runner:role` agentName suffix the runner writes. */
function claimRoleId(claim: CardClaim): string {
  if (claim.roleId) return claim.roleId;
  const n = claim.agentName || '';
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : '';
}

function titleOf(cardId: string): string {
  return board.cards.find((c) => c.id === cardId)?.title || cardId;
}

/** Same word-matching rule as roles.ts cliHasRunner: which configured
 * agents can run this CLI (`Hermes Agent` -> hermes, `OpenCode` ->
 * opencode). */
function agentsForCli(cli: string): string[] {
  const c = cli.trim().toLowerCase();
  if (!c) return [];
  return configStore.allAgentNames.filter((name) =>
    name.toLowerCase().split(/[^a-z0-9]+/).includes(c)
  );
}

/** The newest `card` ledger row per role — the dispatcher writes `role`
 * on every claim/start/exit/retry/sweep/cancel entry. */
const lastByRole = computed(() => {
  const m = new Map<string, ActivityEntry>();
  for (const e of activity.entries) {
    if (e.kind !== 'card' || !e.role) continue;
    const cur = m.get(e.role);
    if (!cur || e.at >= cur.at) m.set(e.role, e);
  }
  return m;
});

/** The ledger's failure vocabulary, as the runner writes it: a non-zero
 * `exit=`, a timeout kill, a watchdog idle kill, a maxRetries exhaustion,
 * a lease-expiry sweep. Operator releases/cancels are deliberate, not
 * errors. */
function isFailureEntry(e: ActivityEntry): boolean {
  const d = e.detail || '';
  if (/maxRetries \d+ exhausted|lease expired|idle [\d.]+m — terminated/.test(d)) {
    return true;
  }
  const m = /exit=(\d+)/.exec(d);
  if (m) return Number(m[1]) !== 0 || /\btimeout\b/.test(d);
  return false;
}

const executors = computed<ExecRow[]>(() => {
  const now = claimsStore.now;
  const roleById = new Map(rolesStore.roles.map((r) => [r.id, r]));

  // Live claims only — lease-aware, so a stale claim stops counting on
  // the claims store's own `now` tick without any manual refresh.
  const byRole = new Map<string, [string, CardClaim][]>();
  const orphan: [string, CardClaim][] = [];
  for (const [cid, claim] of Object.entries(claimsStore.claims)) {
    if (!(Number(claim?.leaseUntil) > now)) continue;
    const rid = claimRoleId(claim);
    if (rid && roleById.has(rid)) {
      const list = byRole.get(rid) ?? [];
      list.push([cid, claim]);
      byRole.set(rid, list);
    } else {
      orphan.push([cid, claim]);
    }
  }

  // Every role the panel knows about groups under its executor (cli) —
  // including roles with all slots free and roles that have never run.
  const byCli = new Map<string, Role[]>();
  for (const r of rolesStore.roles) {
    const list = byCli.get(r.cli) ?? [];
    list.push(r);
    byCli.set(r.cli, list);
  }

  const heldOf = (pairs: [string, CardClaim][]): HeldCard[] =>
    pairs.map(([cardId, claim]) => ({ cardId, title: titleOf(cardId), claim }));

  const rows: ExecRow[] = [];
  for (const [cli, roles] of byCli) {
    const roleRows: RoleRow[] = roles.map((r) => {
      const held = heldOf(byRole.get(r.id) ?? []);
      const last = lastByRole.value.get(r.id);
      return {
        id: r.id,
        label: r.label,
        stages: rolesStore.stagesForRole(r.id),
        busy: held.length,
        max: r.maxConcurrent,
        held,
        hasRunner: rolesStore.roleHasRunner(r),
        lastAt: last?.at ?? null,
        lastText: last ? [last.title, last.detail].filter(Boolean).join(' — ') : '',
        lastFailed: !!last && isFailureEntry(last),
      };
    });
    roleRows.sort((a, b) => b.busy - a.busy || a.id.localeCompare(b.id));
    const runnerIds = [
      ...new Set(
        roleRows.flatMap((r) => r.held.map((h) => h.claim.runnerId || ''))
      ),
    ].filter(Boolean);
    const runnerNames = agentsForCli(cli);
    rows.push({
      key: `cli:${cli}`,
      cli,
      runnerNames,
      runnerIds,
      hasRunner: runnerNames.length > 0,
      busy: roleRows.reduce((n, r) => n + r.busy, 0),
      max: roleRows.reduce((n, r) => n + r.max, 0),
      roles: roleRows,
      orphanHeld: [],
    });
  }

  // Live claims that resolve to no known role are still facts — they get
  // their own honest group instead of disappearing.
  if (orphan.length) {
    rows.push({
      key: 'unassigned',
      cli: '',
      runnerNames: [],
      runnerIds: [...new Set(orphan.map(([, c]) => c.runnerId || ''))].filter(Boolean),
      hasRunner: true,
      busy: orphan.length,
      max: orphan.length,
      roles: [],
      orphanHeld: heldOf(orphan),
    });
  }

  rows.sort((a, b) => {
    if (a.key === 'unassigned') return 1;
    if (b.key === 'unassigned') return -1;
    return b.busy - a.busy || a.cli.localeCompare(b.cli);
  });
  return rows;
});

// ---- release / stop -----------------------------------------------------
// The controls mutate the same state documents the runner and boardctl
// use: claims.json drops the claim (rev-checked), activity.json gets a
// `card` audit row. Killing the child process belongs to the runner that
// owns it — the panel says so plainly in the note under the executor.

const notes = ref<Record<string, string>>({});
const pending = ref(false);

function audit(
  released: [string, CardClaim][],
  detail: (cardId: string, c: CardClaim) => string,
): void {
  for (const [cid, c] of released) {
    activity.recordEntry({
      kind: 'card',
      agentName: 'panel',
      title: titleOf(cid),
      detail: detail(cid, c),
      role: c.roleId || '',
      sessionId: c.sessionId || '',
    });
  }
}

function pidText(released: [string, CardClaim][]): string {
  const pids = released.map(([, c]) => c.pid).filter((p): p is number => !!p);
  return pids.length ? `pids ${pids.join(', ')}` : 'any live process';
}

async function releaseHeld(ex: ExecRow, held: HeldCard): Promise<void> {
  if (pending.value) return;
  pending.value = true;
  try {
    const released = await claimsStore.releaseClaims([held.cardId]);
    audit(released, (cid) =>
      `claim released by panel (Agents tab) card=${cid} — child pid not signalled`
    );
    notes.value = {
      ...notes.value,
      [ex.key]: released.length
        ? `Released "${held.title}" — the claim is gone from claims.json. ` +
          `The panel cannot signal its process: ${pidText(released)} keeps ` +
          `running until the runner that owns it exits.`
        : `"${held.title}" — the claim was already gone.`,
    };
  } finally {
    pending.value = false;
  }
}

async function stopExecutor(ex: ExecRow): Promise<void> {
  if (pending.value) return;
  const all = [...ex.roles.flatMap((r) => r.held), ...ex.orphanHeld];
  if (!all.length) return;
  pending.value = true;
  try {
    const cardIds = all.map((h) => h.cardId);
    const released = await claimsStore.releaseClaims(cardIds);
    audit(released, (cid, c) =>
      `stop-all card=${cid} released by panel; pid ${c.pid ?? '-'} not ` +
      `signalled (panel cannot kill) role=${c.roleId || '-'}`
    );
    notes.value = {
      ...notes.value,
      [ex.key]: released.length
        ? `Released ${released.length} claim(s) — slots are free and the ` +
          `cards can be picked up again. The panel cannot signal ` +
          `processes it does not own: ${pidText(released)} keep running ` +
          `until their runner exits them; run \`node server/acp-runner.mjs ` +
          `stop-all\` on the runner host to kill now.`
        : 'No live claims to release.',
    };
  } finally {
    pending.value = false;
  }
}

function leaseLeft(claim: CardClaim): string {
  return `${fmtDur(Math.max(0, claim.leaseUntil - claimsStore.now))} left`;
}

function heldTitle(h: HeldCard): string {
  const c = h.claim;
  return [
    `card ${h.cardId}`,
    c.runnerId ? `runner ${c.runnerId}` : '',
    c.pid ? `pid ${c.pid}` : '',
    c.sessionId ? `session ${c.sessionId}` : '',
    c.stage ? `claimed in ${c.stage}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}
</script>

<template>
  <div class="agents-tab">
    <div v-if="executors.length === 0" class="tab-empty" aria-live="polite">
      No roles or claims yet — roles are bound to stages in Settings →
      Roles, and runners pick cards up from there.
    </div>

    <section
      v-for="ex in executors"
      :key="ex.key"
      class="exec"
      :data-exec="ex.cli || 'unassigned'"
      data-testid="exec-row"
    >
      <div class="exec-head">
        <span class="dot" :class="{ live: ex.busy > 0 }" aria-hidden="true" />
        <span class="exec-name">{{ ex.cli || 'unassigned claims' }}</span>
        <span
          class="chip mono slots"
          :class="{ busy: ex.busy > 0 }"
          data-testid="exec-slots"
          :data-busy="ex.busy"
          :data-max="ex.max"
          :title="`${ex.busy} of ${ex.max} slot(s) busy (live claims vs maxConcurrent)`"
        >{{ ex.busy }}/{{ ex.max }}</span>
        <span
          v-for="rn in ex.runnerNames"
          :key="rn"
          class="chip mono runner"
          :title="`Configured agent running '${ex.cli}'`"
        >{{ rn }}</span>
        <span
          v-for="rid in ex.runnerIds"
          :key="rid"
          class="chip mono runner-id"
          :title="`Runner holding a claim: ${rid}`"
        >via {{ rid }}</span>
        <span v-if="!ex.hasRunner" class="chip warn" title="No configured agent runs this CLI">no runner</span>
        <span class="spacer" />
        <UiButton variant="secondary"
          class="ctl-btn"
          data-testid="stop-exec"
          :disabled="ex.busy === 0 || pending"
          :title="`Release every live claim of ${ex.cli || 'this group'} — the panel cannot kill processes it does not own`"
          @click="stopExecutor(ex)"
        >Stop all</UiButton>
      </div>

      <ul v-if="ex.roles.length" class="role-list">
        <li
          v-for="r in ex.roles"
          :key="r.id"
          class="role-row"
          :data-role="r.id"
          data-testid="role-row"
        >
          <div class="role-line">
            <span class="role-name">{{ r.label }}</span>
            <span class="role-id mono">{{ r.id }}</span>
            <span
              v-for="s in r.stages"
              :key="s"
              class="chip mono stage"
              :title="`Bound to stage ${s}`"
            >{{ s }}</span>
            <span
              class="chip mono"
              :class="{ busy: r.busy > 0 }"
              data-testid="role-slots"
            >{{ r.busy }}/{{ r.max }}</span>
            <span v-if="!r.hasRunner" class="chip warn" title="No configured agent runs this role's CLI">no runner</span>
            <span class="spacer" />
            <span v-if="r.lastAt" class="mono stamp">{{ fmtStamp(r.lastAt) }}</span>
          </div>

          <ul v-if="r.held.length" class="hold-list">
            <li
              v-for="h in r.held"
              :key="h.cardId"
              class="held"
              data-testid="held-card"
              :title="heldTitle(h)"
            >
              <span class="held-title">{{ h.title }}</span>
              <span class="chip mono lease">{{ leaseLeft(h.claim) }}</span>
              <UiButton variant="secondary"
                class="ctl-btn release"
                data-testid="release-btn"
                :disabled="pending"
                :title="`Drop the claim on ${h.cardId} — the process, if any, is not signalled`"
                @click="releaseHeld(ex, h)"
              >Release</UiButton>
            </li>
          </ul>

          <div class="role-activity">
            <span
              v-if="!r.lastAt"
              class="mono none"
              data-testid="role-no-activity"
            >no activity yet</span>
            <span
              v-else
              class="last-text"
              :class="{ bad: r.lastFailed }"
              :title="r.lastText"
              data-testid="role-last"
            >{{ r.lastText }}</span>
          </div>
        </li>
      </ul>

      <ul v-if="ex.orphanHeld.length" class="hold-list orphan">
        <li
          v-for="h in ex.orphanHeld"
          :key="h.cardId"
          class="held"
          data-testid="held-card"
          :title="heldTitle(h)"
        >
          <span class="held-title">{{ h.title }}</span>
          <span class="chip mono">{{ h.claim.agentName }}</span>
          <span class="chip mono lease">{{ leaseLeft(h.claim) }}</span>
          <UiButton variant="secondary"
            class="ctl-btn release"
            data-testid="release-btn"
            :disabled="pending"
            :title="`Drop the claim on ${h.cardId} — the process, if any, is not signalled`"
            @click="releaseHeld(ex, h)"
          >Release</UiButton>
        </li>
      </ul>

      <div v-if="notes[ex.key]" class="ctl-note" data-testid="ctl-note" role="status">
        {{ notes[ex.key] }}
      </div>
    </section>
  </div>
</template>

<style scoped>
.agents-tab {
  height: 100%;
  overflow-y: auto;
}

.tab-empty {
  padding: 2rem;
  font-size: 0.8125rem;
  color: var(--text-muted, #a39a8e);
  text-align: center;
}

.exec {
  border-bottom: 1px solid var(--border-color, #e3dbcf);
}

.exec-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  min-height: 30px;
  background: var(--tint-hover, rgba(43, 39, 35, 0.045));
}

.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted, #a39a8e);
}

.dot.live {
  background: var(--bg-success, #5a7d4f);
}

.exec-name {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-primary, #2b2723);
  font-family: var(--font-mono, monospace);
}

.mono {
  font-family: var(--font-mono, monospace);
}

.chip {
  font-size: 0.625rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-secondary, #6b6259);
  background: var(--bg-main, #fbf8f3);
  border-radius: var(--radius-sm, 4px);
  padding: 0.0625rem 0.3rem;
  white-space: nowrap;
}

.chip.busy {
  color: var(--text-accent, #c2532f);
}

.chip.runner-id {
  color: var(--text-secondary, #6b6259);
}

.chip.warn {
  color: var(--bg-danger, #b3402e);
  border: 1px solid var(--bg-danger, #b3402e);
  background: transparent;
}

.chip.stage {
  text-transform: none;
}

.chip.lease {
  text-transform: none;
}

.spacer {
  flex: 1;
}

.ctl-btn {
  white-space: nowrap;
}

.role-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.role-row {
  padding: 0.3rem 0.75rem 0.3rem 1.25rem;
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
}

.role-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  min-width: 0;
}

.role-name {
  font-size: 0.75rem;
  font-weight: 550;
  color: var(--text-primary, #2b2723);
}

.role-id {
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.stamp {
  flex: 0 0 auto;
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
}

.hold-list {
  list-style: none;
  margin: 0.125rem 0 0;
  padding: 0;
}

.hold-list.orphan {
  border-top: 1px solid var(--border-faint, rgba(43, 39, 35, 0.09));
  padding: 0.25rem 0.75rem 0.5rem 1.25rem;
}

.held {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.375rem;
  min-width: 0;
  min-height: 26px;
}

.held-title {
  font-size: 0.75rem;
  color: var(--text-primary, #2b2723);
  overflow-wrap: anywhere;
}

.release {
  margin-left: auto;
}

.role-activity {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
  margin-top: 0.0625rem;
}

.none {
  font-size: 0.625rem;
  color: var(--text-muted, #a39a8e);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.last-text {
  font-size: 0.6875rem;
  color: var(--text-muted, #a39a8e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.last-text.bad {
  color: var(--bg-danger, #b3402e);
}

.ctl-note {
  margin: 0 0.75rem 0.5rem 1.25rem;
  padding: 0.375rem 0.5rem;
  border-left: 2px solid var(--text-accent, #c2532f);
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--text-secondary, #6b6259);
}

@media (max-width: 800px) {
  .exec-head,
  .role-line,
  .held {
    row-gap: 0.25rem;
  }

  .held .release {
    flex-basis: 100%;
    margin-left: 0;
  }

  .role-activity .last-text {
    white-space: normal;
  }
}
</style>
