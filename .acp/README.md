# .acp — рабочие файлы панели в проекте

- `roles/*.md` — промпты ролей. Панель их **не сочиняет**: она запускает CLI и передаёт путь к файлу.
  Правь руками или поручи агенту. Файлы можно коммитить вместе с проектом.
- `cards/<cardId>/` — артефакты прогона по карточке (`01_spec.md`, `02_plan.md`, `04_impl_log.md`,
  `05_review_r1.md`, …) плюс структурированное состояние цикла ревью —
  `review_findings.json` (`{version, round, findings: [{id, round, severity, text, where,
  status, closedInRound}]}`). Его пишет ревьюер (см. `roles/reviewer.md`), читают панель
  (счётчик на карточке, гейт `agent_tested`) и `boardctl review`. Локальные прогоны, в git не едут.

Роль описывается данными (в `roles.json` на хосте), а не кодом панели:

    { "id": "dev", "cli": "devin", "args": ["-p", "--model", "swe-2-max"],
      "promptFile": ".acp/roles/dev.md", "maxConcurrent": 2, "pollIntervalSec": 15 }

Роль ревьюера несёт и правила цикла ревью — словарь северити, какие из них
блокируют `agent_tested`, какие уходят в backlog, и лимит раундов:

    { "id": "reviewer", "cli": "hermes", "promptFile": ".acp/roles/reviewer.md",
      "review": { "severities": ["critical","major","minor","nit"],
                  "blocking": ["critical","major"], "backlog": ["minor","nit"],
                  "maxRounds": 3 } }
