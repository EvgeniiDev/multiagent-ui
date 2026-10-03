# U7: реальная интеграция managed execution — Compose-стек, живой Pi, браузер, сбои — отчёт

Дата: 2026-10-01. Ветка `feat/agent-modes`.
План: [agent-core-implementation-plan.md](../plans/agent-core-implementation-plan.md).
Журнал отклонений: [2026.10.01_agent-core-u7_deviations.md](../tmp/2026.10.01_agent-core-u7_deviations.md).

Отчёт покрывает **U7**: реальный Compose-прогон managed execution на
фиксированных портах — изолированный переход OFF→ON, фактический solo-flow
(Pi implementer/reviewer/checker) до verified accept, SHA-bound артефакты,
кросс-процессная identity, и контролируемое восстановление прод-стека.
Браузерные/crash/вторые-CLI прогоны задокументированы по факту статуса —
U7 не заявлен завершённым до их реальных проходов.

## Реализовано (U7-owned артефакты)

| Файл | Содержание |
|---|---|
| `compose.u7.yaml` | OFF-оверлей изолированного стека на тех же портах/именах (`-p acp-ui`, только scoped services). STATE_DIR `acp-ui-state-u7`, EXEC_DIR `…/execution`, WS `…/.acp-workspaces-u7`, test ops `~/.acp-ops-u7` (state-only RO, вне runner mounts). Явные `ACP_EXEC_START/VALIDATION=0`. |
| `compose.u7-on.yaml` | ON-оверлей: `ACP_EXEC_START=1` + `ACP_EXEC_VALIDATION=1` на state+runner; `ACP_PORCH_CLI=/repo/deploy/porch-pi-boundary.sh` — trusted wiring pi-boundary (см. ниже). |
| `scripts/u7_transition.py` | Единственная точка перехода: preflight (compose ps, ss, claims, porch active, live docs), fail-closed `pin_restore_images()` (каждый captured image → тег `acp-ui-u7-restore-<svc>:u7baseline` + digest-verify ПЕРЕД любой мутацией), записывает restore-оверлей 0600, marker-seed, sandbox repos, ops dir, `up -d --no-deps` только scoped services, cron stop/start. |
| `scripts/u7_restore_override.py` | Генератор restore-compose по ЗАХВАЧЕННОМУ actual spec (image→pinned tag, `pull_policy: never`, env/mounts byte-exact) — live stack возвращается в точное до-тестовое состояние. |
| `scripts/u7_run.py` | Фазовый драйвер: `apply → off-smoke → acp → on → api-flow-{pi,codex,devin} → browser → crash`, `finally` restore+verify, per-phase timeouts, own-pgid cleanup, `--self-run-id` для проверки единственного активного porch run. |
| `scripts/u7_api_flow.py` | Реальный solo flow через HTTP: enable→requirements→plan(+check)→preset→start→полный lifecycle до `awaiting_acceptance`→`accept_result` с verified SHA. |
| `scripts/u7_pi_boundary_selftest.py` + `scripts/fixtures/u7_pi_run_stony_pine_upstream.jsonl` | 42-check регрессия boundary: реплей реального сбойного потока + живой `PiAdapter` (completes/cancel/crash/empty/steer/identity). |
| `deploy/pi-rpc-boundary.mjs`, `deploy/porch-pi-boundary.sh` | Same-process RPC boundary (ниже). |
| `scripts/u7_browser.py`, `scripts/u7_crash.py`, `scripts/u5_incident.py` | Browser (Playwright)/crash-recovery/U5-инцидент сьюты — написаны, компилируются, ждут ON-окна. |
| `scripts/u7_off_smoke.py`, `u7_acp_bridge.mjs`, `u7_mock_acp.mjs`, `u7_orphan_probe.py`, `u7_runner_recovery.py` | OFF-гейты (31 check), ACP bridge replay-изоляция (15 checks, mock-only protocol), orphan/recovery пробы. |

## Pi boundary — реальный дефект и in-scope решение

**Дефект (подтверждён прод-прогоном):** `run_stony-pine-8669` /
`att-run_3d8bc803-9c3a-4d57-9b43-b56d37e47c7d-1` — реальный bash
(`pwd`, `git`, `cat main.py` → `VALUE = 1`) выполнился; первый `turn_end`
`stopReason: toolUse`; установленный адаптер
`steer/adapters/pi.py` трактует `turn_end` И `agent_end` как завершение
(`done_turns >= prompts_sent`), завершил run `exit 1 "empty final text"`
и послал `abort` в уже начавшийся turn 2.

**Решение:** `pi-rpc-boundary.mjs` — same-process bootstrap (porch запускает
его как pi binary через `PORCH_BIN_PI`; wrapper ставит переменную ниже
`PORCH_*`-scrub; `ACP_PORCH_CLI` на runner в ON-оверлее). Патчит
`process.stdout.write` ДО `import()` реального `cli.js` — тот же PID,
та же группа, реальный stdin/abort/killpg. Held `turn_end`:
`turn_start` → emit as `turn_boundary` (payload полный); `agent_end`/
`agent_settled` → verbatim flush, затем agent frame; exit без
agent_end → только `turn_boundary` (success НЕ фабрикуется). Ограничения:
`turn_boundary` в porch-логе — progress event с полным payload (честная
эвиденция); version guard `==0.85.1` (проверенный пин), outQ cap 32MB.

**Доказательства:** selftest 42/42 (реплей реального стрима + живой
PiAdapter: exit 0 с реальным текстом, cancel→130, crash→честный fail,
empty-final→exit 1, abort достигает stdin, child_pid=сам процесс).
Реальный прогон — ниже.

## Реальные прогоны (точные команды/результаты)

```
python3 scripts/u7_run.py --self-run-id run_gentle-birch-88a7 --phases off-smoke,acp
# window 0f96bc66232aa221 (parent-executed): apply/off-smoke/acp/restore/verify ALL 0
#   31 OFF assertions + 15 ACP assertions; live board/claims/projects byte-SHA unchanged

python3 scripts/u7_run.py --self-run-id run_gentle-birch-88a7 --phases on,api-flow-pi
# window 1 (dfbf…): реальный Pi implementer FAILED empty-final — upstream adapter bug
# window 2 (eff3fb8594618abf): ALL 0 — {apply:0,on:0,api-flow-pi:0,restore:0,verify:0}
```

**api-flow-pi green window (eff3fb8594618abf), 43/43 assertions:**
`run_99a1a363-8a4c-4e55-bd9a-641bdec3aed9`, card `u7-flow-pi-764879f0`:

| Проверка | Результат |
|---|---|
| 3 roles complete (implement/review/check) через реальный pi-cli | `att-run_…-1/2/3`, own porchRunId each, model `zen-relay/muse-spark-1.3-contributor-free`, uid 1001, cwd внутри тестовых WS-roots |
| Meta — applied, не requested | steer `meta.json` backend/model/effort сверены с run; porch-config snapshot совпадает |
| Артефакты | n=8, каждый sha256+bytes проверен против fetched contentBase64 |
| Валидация | `status=settled`, `checks.status=done`, `verdict=pass`, report exit0 + log SHA-bound, proc group dead |
| Rounds | findings/verdicts raw-artifact `{round,resultSha256}` совпадают с `acceptance.resultSha256`; normalized docs `{version,round,*}` |
| Workspace | `ws-run_…` ready/owned by run, `envKey{uid:1001,gid,hostname,bootId,pidNs}`, path под WS_DIR, git HEAD at-or-descended-from `baseCommit=dfba66b5642a` |
| События | 240 events, 6 bounded pages, строгий monotonic seq + nextCursor |
| Accept | wrong SHA → `409 stale_result`; verified SHA → `200` → `succeeded` |

Остановка/восстановление окна: restore+verify exit 0, scoped services на
captured spec, cron перезапущен, live docs hashes `a382c6…/18bc60…/
291232…` неизменны, `porch delegate list --active` — только
`run_gentle-birch-88a7`.

## U5 0501 incident — honest status

Probe `U5 incident probe: fixed-sleep check stopped mid-run` (точная
оригинальная форма sleep 60/timeout 90) + forensics dump (journal tail,
pgid liveness, report exitCodes, run/validation state при сбое).
`u5_incident.py --iters 3 --load`: 3/3 clean + gate-held green.
**Не воспроизведён** — причина run→failed/verify за 10.56s до stop не
доказана; статус UNREPRODUCED остаётся открытым.

## Оставшееся до полного U7 DoD — ЗАКРЫТО (2026-10-01, self-run run_noble-island-0011)

Все оставшиеся фазы прогнаны в реальных изолированных окнах и приняты.
Журнал отклонений: `docs/tmp/2026.10.01_agent-core-u7_deviations.md`,
`docs/tmp/2026.10.01_agent-core-u7b_deviations.md`.

**api-flow-codex** — window accepted, run дошёл до `awaiting_acceptance`,
accept по verified `resultSha256` → `succeeded` (SHA-bound).

**api-flow-devin** — window completed (Devin API-flow leg green).

**u7_browser.py** — `--phase off` **12/12** (server-side 501-gate на
`exec-start` при ACP_EXEC_START=0 доказан реальным отказом, не client
gate); `--phase on` **40/40** (window d7b016e9b21293d3): полный путь
через реальный браузер — enable→docs→approvals→preset→start→run1 live
attempt→stop→`cancelled`→continue→run2 (3 role attempts)→
`awaiting_acceptance`→accept→`succeeded`; 8 artifact rows byte-exact vs
server; 225 events drained пейджингом; session {agentName,sessionId} ≠
porchRunId; tab2/nav конвергенция; zero pageerrors.

**u7_crash.py** — **40/40 GREEN** (window 88b7d9120dd0ffed):
реальный SIGKILL pid-1 runner'а из ancestor pid-ns (in-namespace kill к
pid-ns init молча игнорируется ядром — pid_namespaces(7); `docker kill`
— daemon-initiated, restart не файрит) → init identity сменился
(starttime 36845954→36818800) → restart policy поднял контейнер → новая
ledger generation/instance (g42→g43) bound к новому /proc/1 → recovery
snapshot нового инстанса с `tracked` → foreign attempt нетронут на слабых
доказательствах + reservation dead-владельца сохранена → adopt по
позитивному `process_dead`-на-init доказательству → `interrupted` drain
(run + attempt) → ops-retirement `ret_d679cb3c` записан в
`retirements[]` (compose_lifecycle, state=removed) → force-recreate по ON
file set: новый container Id, ON-флаги сохранены, новый instance,
ретайр старого env → durable-write fault (chmod 0000, uid 1001) →
честный отказ + точное восстановление mode 775→775.

**Продуктовые баги, найденные и исправленные в ходе U7** (см. журналы —
все с файлом/строкой/причиной, ни один не был обойдён в сьюте):

- `src/stores/execution.ts` `stateFor()` возвращал сырой (не-reactive)
  объект на пути создания → `computed` в ExecutionPanel кешировал его →
  `run`/`view` зависимости не отслеживались → `v-if="run"` никогда не
  перерендеривал run-status. FIXED — `stateFor` всегда отдаёт reactive
  proxy; регрессионный тест в `test_execution_ui.mjs`.
- `managed-scheduler.mjs` `send()` CAS-retry starvation: `send` и 300ms
  validation-heartbeat шарили `card.internalRevision` с нулевым backoff →
  lockstep → `revision_conflict` ×4 → validation `unproven` → drained →
  run failed. FIXED — jittered backoff + pollBusy de-stack guard.
- `managed-scheduler.mjs` envGone-drain hole: `process_dead`-adoption на
  init-владельце (owner.pidStarttime === envInstance.initStarttime) не
  считалась env-death → adopted attempt держал supervisor-identity из
  мёртвого pid-ns → `cancel_pending:child_ns_unproven` навсегда → run
  wedged `stopping`, reservation утекла. FIXED — init-death теперь
  in-band env-death proof → `interrupted` drain.
- `compose.yaml` host-networked runner наследовал hostname хоста →
  `envInstance.containerId` неуникален → `retire-environment.mjs` мог
  отказать всегда (latent U4 gap). FIXED — `hostname: acp-ui-runner`.

Selftests после всех продуктовых фиксов: U4 61/61, U5 core 31/31,
U5 domain 29/29. Restore+verify после КАЖДОГО окна: exit 0, scoped
services на captured spec, cron перезапущен, live state dir нетронут.

Независимая верификация Pi manager'ом — единственный оставшийся пункт
(вне скоупа самого исполнения).
