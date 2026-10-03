# U3: выделение workspace и защищённый запуск — отчёт

Дата: 2026-09-30. Ветка `feat/agent-modes`, база `fb0a298`.
План: [agent-core-implementation-plan.md](../plans/agent-core-implementation-plan.md).
Журнал отклонений: [2026.09.30_agent-core-u3_deviations.md](../tmp/2026.09.30_agent-core-u3_deviations.md).

Отчёт покрывает **только U3**. U4–U7 (observation, stop, continue,
acceptance, review, checker), Fusion, оркестратор, swarm и подготовка
идей не реализованы и не объявлены готовыми. U1/U2 подтверждены
родителем отдельно. **U3-модуль принят родителем** (96/96 selftest +
17/17 real Compose cross-UID proof); live-деплой и интеграция — U7.

## Реализовано

| Файл | Содержание |
|---|---|
| `server/execution/workspaces.mjs` | Корень `ACP_WORKSPACE_DIR`/`ROOT_DIR/.acp-workspaces`; `ensureWorkspaceRootAccess` (создание + chown root→reader, fail-closed по foreign-uid); `validateWorkspaceRoot`; `assertInsideRoot` (лексика+realpath); `isGitWorkTree`/`resolveBaseCommit`/`sourceGitRoot`/`sourceDirtyPaths` через `gitRepo` со scoped per-command `safe.directory` (только проверенные realpaths, без `*`, без мутации конфигов); `createWorkspace` (git worktree, ветка `acp/<card>/<ws>`); `gitCommonDir` fail-closed; `verifyWorkspace` с `expectCommonDir` — чужой worktree по нужному пути отклоняется. |
| `server/execution/internal-transport.mjs` | `ensureInternalToken`: mkdir/lstat errno диагностируются (EACCES≠ENOENT), `0600`, отказ от symlink, reconcile владельца к `ACP_EXEC_TOKEN_UID/GID`, traversal-provisioning каталогов (chgrp+g+x), fail-closed `token_*` диагностика; токен не покидает auth-closure. `loadInternalToken`, `tokenMatches` (timing-safe), `createInternalClient` с нормализацией `{error,code,...details}` и envelope `{ok,internalRevision,result}`. |
| `server/execution/managed-scheduler.mjs` | Тик: `verifyInputs` (immutable hash контента) → `ensureWorkspace` (резерв/адопт/verify) → `begin_attempt` (durable до `runtime.start`) → launch → `bind_attempt`. Reconcile-матрица: registry match→bind; 2+→`registry_ambiguous`; `launcherTermination` — terminated только по durable pre-spawn rejection / observed exit / проверенной смерти PID в той же env+pidNs; всё остальное → blocked (`launcher_unproven`), никогда не dead. env-retirement (bootId): attempt+run `interrupted`, старые PID не трогаем, авто-relaunch запрещён. Ownership-bearing deterministic IDs (`bw/wr/adw/ad/bind/rs/cr/wf`) несут суффикс `-by-<instanceId>` — реплей пост-адопции не даёт `command_conflict` и не имитирует старого владельца; `ba-<attemptId>`/`ev-<run>-<seq>` ключами являются уникальные attempt/seq (конфликт на ev → refresh cursor + retry).
| `server/execution/execution-domain.mjs` | U3-команды: `begin/ready/failed_workspace`, `adopt_workspace` (structured proof, rebind только от terminal-предшественника), `begin_attempt` (готовый ws + точный cwd + глобальная уникальность attemptId + лимиты), `bind/resolve_attempt`, `heartbeat`, `adopt_attempt`, owner-гейты на complete_run/record_event. Владелец = `runnerId`+`instanceId`+pid/starttime+envKey; ambient env ≠ власть. |
| `server/execution/state-service.mjs` | `POST /api/internal/cards/:id/commands` (token-gated), managed reads внутри сериализованной очереди (repair до чтения), events route с `limit`/`cursor`/`nextCursor`, каноничная дедупликация по seq. |
| `server/execution/execution-store.mjs` | `run.events` на агрегате (authoritative) + каноничная jsonl-проекция (atomic rewrite, repair рваного хвоста, seq-dedup); `scheduler.json` лимиты; fault-seam `runs`/`runEvents`. |
| `server/execution/porch-runtime.mjs` | errno-aware `processIdentity` (ENOENT=absent, EACCES=null), launcher identity при spawn, durable `spawned:false` только для pre-spawn отказа, `launchRecord`, unreadable в reconcile. |
| `server/execution/fake-runtime.mjs` | Общий registry (runs/procs/unreadable), per-attempt behaviors, launch records с env-аттестацией, `_calls`. |
| `server/execution/legacy-guard.mjs` + `acp-runner.mjs` | `isManagedCard`/`legacyCardDispatchable` — единый барьер; legacy-диспетчер пропускает managed до stageRoles. |
| `compose.yaml` (подготовлено, НЕ развёрнуто) | `state`: `user:"1001:1001"` (= live), `ACP_WORKSPACE_DIR`, `ACP_EXEC_TOKEN_UID/GID=1001`. `runner`: `ACP_WORKSPACE_DIR`, `ACP_EXEC_DIR`. Общий абсолютный путь через mount `/home/hermes/projects`. |

## Факты деплоя (записаны отдельно, не смешаны с синтетическим proof)

- **Live state**: uid1001/gid1001 (`docker compose exec state id -u`, мной).
- **Live runner**: родитель сообщает uid0/gid0 для *работающего* контейнера
  (Up 3 days — предшествует `user:` в спеке); `compose run` oneoff по
  текущей спеке → uid1001. Оба значения реальны — разные объекты.
- **Live state image**: нет `git` (`exit127`) — `Dockerfile.node` уже ставит
  git, требуется rebuild (U7).
- Родительский root-git oneoff был **гипотетический prepared-root**, не
  диагноз live-владения.
- Подготовленные env-vars в `compose.yaml` не активны до деплоя.

## Скрипты для родителя (ничего не развёрнуто, нет listeners)

`scripts/u3_compose_preflight.sh` — read-only probes + эфемерный
`compose run --no-deps` контейнер. Различает live uid / spec uid,
PASS/FAIL/GAP; GAP ≠ приёмка.

```sh
scripts/u3_compose_preflight.sh /home/hermes/projects/acp-ui        # live
scripts/u3_compose_preflight.sh /home/hermes/projects/acp-ui-agent-modes  # prepared spec
```

`scripts/u3_crossuid_proof.mjs` — **реальный** cross-UID proof на
изолированных temp-путях под `/home/hermes/projects/.acp-u3-xuid-*`:
root-фаза (production `createStateService`+`ensureInternalToken` → token
1001:1001:0600; enable/import/start сервисом на uid1001-репе через scoped
`safe.directory`; workspace-root chown; reconcile root-owned 0700/0600
token) → uid1001-child через `spawn{uid,gid}` (читает оба токена, w+x под
корнем, production `createWorkspace`+`verifyWorkspace` на uid1001-репе,
assert `v.ok`+branch+head+commonDir). Токен не печатается. Cleanup своих
путей.

Точная родительская команда (MAIN compose, образ runner, абсолютный
путь скрипта через mount `/home/hermes/projects` — отдельный compose
проект не создаётся):

```sh
cd /home/hermes/projects/acp-ui && docker compose run --rm --no-deps \
  --user 0:0 --entrypoint /usr/local/bin/node runner \
  /home/hermes/projects/acp-ui-agent-modes/scripts/u3_crossuid_proof.mjs
```

Родительский запуск (третий): **17/17 pass, exit 0** — root: token
provisioning (new + pre-existing root-owned, value preserved),
enable/import/start на uid1001-репе; child uid1001: read both tokens,
w+x под wsroot, production worktree create+verify. Одноразовый контейнер
удалён, temp-BASE зачищен, live-записей не было.

Это синтетический module-proof, **не** интеграционная приёмка U7.

## Регрессия (node --test, без listeners)

`u1_runtime_selftest` 19/19 + `u2_state_selftest` 34/34 +
`u3_core_selftest` **43/43** = **96/96 pass, exit 0, ~10s**.

U3-матрица (43 теста): start-gate, happy path real-git, ordering
durable-before-start, dirty-refuse, concurrent schedulers, foreign/live
instance, dead-owner+live-supervisor adopt-observe, late supervisor
bind, environment_lost→run interrupted+no relaunch, foreign-env≠dead,
forged adoption proofs, adopt_workspace rebind, ws collision cross-card,
one-run-one-ws, ready-ws+canonical-cwd для begin_attempt, global
attemptId уникальность, global+role лимиты (вкл. slots≥2 оба running),
uncertain+match/dead/alive, missing/corrupt record, unreadable registry,
no-env-attestation, EACCES probe, input-hash mismatch, launch_failed
observed-exit retry, budget exhaustion→failed, record_event
owner-gate+seq+cursor+paging, torn jsonl repair, run/runEvents
projection fault→intent→repair, token route 401/403/200, symlink escape,
ws owner-instance гейты, stageRoles barrier, start dedup+run_active,
crash-after-durable-attempt → conservative block, scheduler seq envelope,
root-access fail-closed, common-dir fail-closed, token EACCES/ENOTDIR.

## Известные ограничения

- Compose-интеграция U2/U3 отложена к U7 (родительский чеклист).
- Листинг событий ограничен (limit/nextCursor); live-observation — U4.
- Interrupted run не перезапускается — explicit continue — U4.
