# .acp — рабочие файлы панели в проекте

- `roles/*.md` — промпты ролей. Панель их **не сочиняет**: она запускает CLI и передаёт путь к файлу.
  Правь руками или поручи агенту. Файлы можно коммитить вместе с проектом.
- `cards/<cardId>/` — артефакты прогона по карточке (`01_spec.md`, `02_plan.md`, `04_impl_log.md`,
  `05_review_r1.md`, …) плюс структурированное состояние цикла ревью —
  `review_findings.json` (`{version, round, findings: [{id, round, severity, text, where,
  status, closedInRound}]}`). Его пишет ревьюер (см. `roles/reviewer.md`), читают панель
  (счётчик на карточке, гейт `agent_tested`) и `boardctl review`. Рядом — вердикты чекера
  `review_verdict.json` (`{version, verdicts: [{findingId, verdict: confirmed|rejected|disputed,
  reason, checker, at}]}`, append-only, действует последний по находке): пишет чекер через
  `boardctl review-check` (см. `roles/review-checker.md`), `rejected` снимает блокировку гейта,
  `disputed` блокирует и уходит человеку в список `proposed:` во вкладке Links.
  Локальные прогоны, в git не едут.

Роль описывается данными (в `roles.json` на хосте), а не кодом панели:

    { "id": "dev", "cli": "devin", "args": ["-p", "--model", "swe-2-max"],
      "promptFile": ".acp/roles/dev.md", "maxConcurrent": 2, "pollIntervalSec": 15 }

Полный набор записей конвейера (`spec → plan → dev → reviewtest`); поля —
`{id, cli, args, promptFile, maxConcurrent, pollIntervalSec, timeoutMin,
maxRetries}`:

    { "id": "orchestrator", "cli": "devin",
      "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
      "promptFile": ".acp/roles/orchestrator.md", "maxConcurrent": 1,
      "pollIntervalSec": 30, "timeoutMin": 120, "maxRetries": 1 }

    { "id": "plan-writer", "cli": "devin",
      "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
      "promptFile": ".acp/roles/plan-writer.md", "maxConcurrent": 2,
      "pollIntervalSec": 15, "timeoutMin": 30, "maxRetries": 2 }

    { "id": "dev", "cli": "devin",
      "args": ["-p", "--model", "swe-2-max", "--permission-mode", "dangerous"],
      "promptFile": ".acp/roles/dev.md", "maxConcurrent": 2,
      "pollIntervalSec": 15, "timeoutMin": 45, "maxRetries": 1 }

Привязка стадий (`stageRoles`): `spec → orchestrator`, `plan → plan-writer`,
`dev → dev`, `reviewtest → reviewer`. Оркестратор держит claim карточки и
сам двигает её по стадиям; планировщик, разработчики и ревьюеры — его
субагенты (`boardctl delegate`), карточку они не трогают. `timeoutMin`
оркестратора намеренно большой: один прогон — весь цикл карточки.

Роль ревьюера несёт и правила цикла ревью — словарь северити, какие из них
блокируют `agent_tested`, какие уходят в backlog, и лимит раундов:

    { "id": "reviewer", "cli": "hermes",
      "args": ["-z"], "promptFile": ".acp/roles/reviewer.md",
      "maxConcurrent": 1, "pollIntervalSec": 15,
      "timeoutMin": 30, "maxRetries": 1,
      "review": { "severities": ["critical","major","minor","nit"],
                  "blocking": ["critical","major"], "backlog": ["minor","nit"],
                  "maxRounds": 3 } }
