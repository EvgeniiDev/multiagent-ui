# Reddit: как люди строят «доска + ро́ли + автозабор задач» для coding-агентов

Выжимка из четырёх дампов поиска по Reddit (прод: `/tmp/rd_roles_1..4.json`):

| файл | запрос | постов |
|---|---|---|
| `rd_roles_1.json` | `agent orchestration kanban board` | 175 |
| `rd_roles_2.json` | `multi agent roles dashboard` | 168 |
| `rd_roles_3.json` | `task board for coding agents` | 425 |
| `rd_roles_4.json` | `AI agent control center` | 505 |

Все ссылки ниже — только то, что реально есть в дампах: сабреддит, заголовок, ⬆score, 💬comments, URL.
Использовано **39 тредов и 93 комментария**; полный список тредов с метаданными — в приложении в конце.
Сниппеты в дампах обрезаны (~120 символов), поэтому цитаты короткие — такими, какими они лежат в файле.
Наш черновик требований — `docs/control-center-roles-requirements.md` (F9.1–F9.10, N11–N15), на него и ссылаюсь
в пометках «покрыто / расширить / противоречит».

---

## 1. Что люди реально строили

- **Hermes как kanban-контроллер над четырьмя рантаймами (560+ диспатчей за 3 месяца).**
  r/hermesagent · «Three months of running Hermes as a kanban controller over Claude Code, OpenCode, Codex and MiMo - 560+ agent dispatches, here's what broke» · ⬆17 · 💬7 ·
  /r/hermesagent/comments/1vwgt9i/three_months_of_running_hermes_as_a_kanban/
  Механизм: доска + «lane executor» — в комментариях автор описывает второй демо-кейс как «Claude Code as the lane executor» (`p5hdspp`), т.е. дорожка = CLI-исполнитель, а не общий пул.
- **Terminal kanban с оркестратором-агентом.** r/VibeCodeDevs · «Terminal kanban for managing multiple AI coding sessions in parallel - with orchestrator agent» · ⬆165 · 💬31 ·
  /r/VibeCodeDevs/comments/1s5xh5a/terminal_kanban_for_managing_multiple_ai_coding/ (то же в r/AskVibecoders ⬆117 💬13 · /r/AskVibecoders/comments/1rzp5p9/terminal_kanban_for_managing_multiple_ai_coding/).
  Механизм: сессии под tmux, доска как визуализация + оркестратор; в комментариях сразу спрашивают про конфликт: «Are these agents modifying the same project folder at the same time?» (`odlfb9r`).
- **BatonBot — local-first kanban для coding-агентов.** r/LocalLLaMA · «Built an open source local first Kanban workflow for running AI coding agents without babysitting every step» · ⬆20 · 💬40 ·
  /r/LocalLLaMA/comments/1ufq3cz/built_an_open_source_local_first_kanban_workflow/ (дубли: r/LocalLLM ⬆2 💬15 `/1ugit8h/…`, r/opensource ⬆0 💬15 `/1uxlfbj/…`).
  Механизм: «One card is one agent session» (`otuym5i`), harness проверяет заявку «готово» (`ou0h9t0`), выбирать агента можно **на карточке** в UI, а не в YAML (`ou8h0zn`), роль-роутинг описан как «some form of shared progress tracking, some way of differen…» (`ou3psh1`).
- **Chorus — командная доска с audit trail.** r/ClaudeCode · «I built Chorus — an open-source SaaS for teams to coordinate Claude Code agents on the same repo, with a shared Kanban, traceable audit trail, and pixel boss view» · ⬆43 · 💬32 ·
  /r/ClaudeCode/comments/1rbphir/i_built_chorus_an_opensource_saas_for_teams_to/
  Механизм: **claim с доски** — «Each Agent … gets its own Session and claims tasks from the…» (`o6sxzyi`); аудит честно назван «an action log: who (human or agent) did what, on which task, when» (`o6vuarh`), а не полноценной трассировкой.
- **Kanban, где тикет = markdown + YAML на файловой системе.** r/ClaudeAI · «Kanban Board for Claude Code - no paywalls, no sign ups, no subscriptions» · ⬆136 · 💬98 ·
  /r/ClaudeAI/comments/1v3aky6/kanban_board_for_claude_code_no_paywalls_no_sign/
  Механизм: файловая доска вместо облака; в комментариях тот же приём описан через внешний трекер-очередь: «I am already using Trello with Claude Code to queue tasks … and sync across agents» (`oz1okea`).
- **vibe-kanban fork с постоянной памятью (mem0 + Qdrant) — против потери контекста между сессиями.** r/SideProject · ⬆1 · 💬2 · /r/SideProject/comments/1vt3c7p/i_built_a_vibekanban_fork_with_persistent_agent/ (дубли: r/selfhosted ⬆0 💬5 `/1vt3l7f/…`, r/devtools ⬆2 `/1vt3hf0/…`).
  Механизм: детерминированная инъекция памяти — «deterministic memory injection is implemented directly in the Rust backend. When any workspace launches, the backen…» (`p4q92dh`).
- **Kanban как память самого агента, а не человека (MCP + JSON + web UI).** r/mcp · «I gave my terminal AI agent a Kanban board. Not for me for its own memory.» · ⬆11 · 💬29 ·
  /r/mcp/comments/1tmoyl7/i_gave_my_terminal_ai_agent_a_kanban_board_not/
  Механизм: «memory layer for the mcp (less token usage for new session)» (`onrgxla`), карточки в одном JSON-файле (`onr2ymo`).
- **pi-hive — иерархия агентов как расширение Pi, плюс «Model Roles».** r/PiCodingAgent · «Made a Pi extension for hierarchical multi-agent orchestration — is this useful to anyone, or does it already exist?» · ⬆33 · 💬18 ·
  /r/PiCodingAgent/comments/1uo2waf/made_a_pi_extension_for_hierarchical_multiagent/
  Механизм: в комментариях указывают на готовый role-роутинг — «This sounds like the Model "Roles" function oh-my-pi has» (`ovqcqco`), настройка через `/models` в TUI (`ozxzwss`); сам автор делает «mission control»-обзор.
- **Kanban в VS Code с упором на стоимость и постоянное состояние (LoopBoard) и стадии агентов + git worktrees (Kangentic).**
  r/ClaudeWorkflows · «[Workflow] LoopBoard: Orchestrate AI Agent Loops with a TODO.md Kanban Board in VS Code for Cost Efficiency and Persistent State» · ⬆1 · 💬0 · /r/ClaudeWorkflows/comments/1vjrxmb/workflow_loopboard_or… ;
  r/ClaudeWorkflows · «[Workflow] Kangentic: Kanban Board for Claude Code with Git Worktrees and Configurable Agent Stages» · ⬆1 · 💬0 · /r/ClaudeWorkflows/comments/1wl347x/workflow_kangentic_kanban_board_for_claude_code/
  Механизм: TODO.md-доска как источник истины; конфигурируемые стадии агентов, каждая карточка в отдельном worktree.
- **Hermes-профили как «команда ролей».** r/hermesagent · «Multi-Agent & Profiles Megathread — Hermes Agent (June 2026)» · ⬆109 · 💬35 · /r/hermesagent/comments/1ucmvi8/multiagent_profiles_megathread_hermes_agent_june/ ;
  r/hermesagent · «Kanban Setups Megathread — Hermes Agent (June 2026)» · ⬆85 · 💬15 · /r/hermesagent/comments/1ugkihk/kanban_setups_megathread_hermes_agent_june_2026/
  Механизм: профиль — это своя модель, свои скиллы и ограничения инструментов: «Each profile has its own soul, memory, skills and tool restrictions» (`oqm3qbu`) и «You can switch back and forth the models, its what i do. Also, set more than one profile…» (`oqljxi3`) — оба комментария из r/hermesagent · «Looking for a Cost-Effective AI Setup for Hermes Agent (Coding + General Tasks)» · ⬆60 · 💬70 · /r/hermesagent/comments/1u0xpb6/looking_for_a_costeffective_ai_setup_for_hermes/ ; профилю можно задать отдельную модель и под задачу (`ot5pj4e`, megathread 1ucmvi8); воркеру — свой `AGENTS.md` в рабочем каталоге («a worker specific AGENTS.md in its wor…», `ou56gtf`); профилирование оправдывают durability: «Why Kanban beats delegate_task for durable work» (`ot5jlj9`).
- **Driver + reviewer + «Keeper» как файловая система ролей.** r/ClaudeCode · «A humble guide to the multi-agent workflows I use every day» · ⬆215 · 💬35 · /r/ClaudeCode/comments/1vphazv/a_humble_guide_to_the_multiagent_workflows_i_use/
  Механизм: описан как «a file-base system with routing map and templates for specific agent roles» (`p3zg042`), статус живёт в index-файле (`p3zlcov`), фоновая роль Keeper «sweeps for pointers that the record has outrun» (`p42z9ew`), стоимость — фиксированные подписки, без API: «There is no API spend…» (`p437g75`).
- **ZaoFu — long-horizon harness с независимой верификацией.** r/codex · «ZaoFu: an open-source harness for long-horizon, multi-agent software delivery» · ⬆0 · 💬3 · /r/codex/comments/1vqm7h0/zaofu_an_opensource_harness_for_longhorizon/
  Механизм: «This is exactly the failure mode we want to avoid: an agent grading its own work» (`p4bym5r`) → проверяет не исполнитель.
- **claude-orgtree — мультиагентный оркестратор (CLI + API fallback).** r/ChatGPTPro · «Maurdekye/claude-orgtree: a Multi-agent Orchestrator for Claude Code (& Codex / Gemini)» · ⬆4 · 💬13 · /r/ChatGPTPro/comments/1w1v75w/maurdekyeclaudeorgtree_a_multiagent_orchestrator/
  Механизм: иерархия «орг-структуры» агентов, «it works primarily with the cli, with optional api fallback or api exclusive functionality» (`p6t8kdl`); запрос из треда — «a supported "hardened/frozen deploym…"» (`p6v3y91`).
- **Flare — graph-first IDE, показывающий blast radius правок.** r/BuildWithClaude ⬆80 💬8 · /r/BuildWithClaude/comments/1vloz92/flare_a_graphfirst_ide_for_agentic_coding_watch/ ; дубли: r/ClaudeAI ⬆12 💬9 `/1vnikab/…`, r/agenticAI ⬆52 `/1vkpxg6/…`, r/AgentsOfAI ⬆27 `/1wg1doy/…`, r/ArtificialInteligence ⬆35 💬12 `/1vwazom/…`.
  Механизм: визуализация графа зависимостей агента; поводом названо «Claude finished a task and told me it was done» (`p4en66r`), плюс «the blast-radius visualization is the part that actually matters» (r/ArtificialInteligencia, `p5r57tq`).
- **Личный процесс «kanban + lease» в r/SaaS.** r/SaaS · «My personal solution to AI context bloat: A Kanban board.» · ⬆7 · 💬15 · /r/SaaS/comments/1wc0ny9/my_personal_solution_to_ai_context_bloat_a_kanban/
  Механизм: «Every run leases a specific task, and opens its own workspace with unique ports» (`p8uc0p1`); модель назначается на тикет (`p90g9d2`); доска — источник истины вместо чата (`p8un5ei`, r/buildinpublic ⬆5 💬14 `/1wc2j8q/…`); роль-цепочка «planner / implementer / evaluator» пишет состояние в доску (`p8xv8fr`).
- **Тематизированная доска «recrew подхватывает карточки».** r/ClaudeAI · «I themed my kanban board as The Matrix - Neo orchestrates and the crew pulls cards through backlog -> doing -> review -> PR -> done on their own» · ⬆10 · 💬2 · /r/ClaudeAI/comments/1vaowu8/i_themed_my_kanban_board_as_the_matrix_neo/
  Механизм: явный статус-поток backlog → doing → review → PR → done, карточки тянут агенты.
- **«8 AI agents live and argue 24/7» — платформа наблюдения за роем.** r/LocalLLM · ⬆56 · 💬32 · /r/LocalLLM/comments/1uc9xbc/i_built_a_platform_where_8_ai_agents_li… (дамп `rd_roles_4.json`).
  Механизм: дашборд-наблюдаемость без права вмешательства (низкая релевантность для ролей, но это ровно «control center»-жанр).

---

## 2. Функциональные требования, выведенные из обсуждений

- **F-R1. Промпт роли должен задаваться файлом в рабочем каталоге проекта, а inline-строка — лишь fallback.**
  Обоснование: `p3zg042` (описание системы как «file-base system with routing map and templates for specific agent roles», r/ClaudeCode 1vphazv ⬆215), `ou56gtf` («a worker specific AGENTS.md in its wor…», r/hermesagent 1ugkihk ⬆85), `ottzms5` (боль синхронизации конфигов между 9 профилями, r/hermesagent 1ucmvi8 ⬆109).
  Покрытие: **расширить** F9.1 (там `prompt` — строка в `roles.json`) + закрыть открытый вопрос №1 черновика. Добавить путь к файлу и его хэш в карточку/леджер, чтобы видеть, какой версией промпта запущен ход.
- **F-R2. Роль должна назначаться колонке и переопределяться на уровне карточки.**
  Обоснование: `ou8h0zn` («mine picks the agent per card in the UI instead of in yaml», r/LocalLLM 1ugit8h), `p90g9d2` («assign a model to each ticket so the Orchestrator spawns the right m…», r/SaaS 1wc0ny9 ⬆7), `ou3psh1` («shared progress tracking, some way of differen…», r/LocalLLM 1ugit8h).
  Покрытие: **покрыто** F9.2 (`card.roleId` поверх роли колонки).
- **F-R3. Колонка review обязана иметь роль-ревьюера с другой моделью и промптом, изолированным от исполнителя, и авто-переход в `done` запрещён.**
  Обоснование: `obtsm5g` («I review everything before merge, no auto merge, but I let different agent review the changes before I do», r/AskVibecoders 1rzp5p9 ⬆117), `p3zfhww` («the cold reviewer is the bit i'd test hardest. if driver + reviewer share the same primer and room, they can inherit the…», r/ClaudeCode 1vphazv), `p4bym5r` («an agent grading its own work», r/codex 1vqm7h0), `oji6yhv` («human-in-the-loop gates (plan, im…», r/ClaudeCode 1t1q54w ⬆15).
  Покрытие: **расширить** F9.10: там сказано «может быть тот же агент с другой ролью» — Reddit прямо предупреждает, что общий контекст/primer ревьюера и исполнителя ломает независимость. Нужны отдельные `model` + `prompt` + чистый контекст ревьюера.
- **F-R4. Взятие карточки — это claim + lease с heartbeat; истёкший lease возвращает карточку в `ready`.**
  Обоснование: `p8uc0p1` («Every run leases a specific task, and opens its own workspace with unique ports», r/SaaS 1wc0ny9), `o6sxzyi` («Each Agent … claims tasks from the…», r/ClaudeCode 1rbphir ⬆43), `pb4j42z` («The kanban files are filed through an API that manages concurrent edits», r/buildinpublic 1wc2j8q).
  Покрытие: **покрыто** F9.5 (claim/lease + `leaseUntil` + ручные `Run now` / `Release claim`).
- **F-R5. Карточка под роль без живого исполнителя должна быть видимо помечена и не запускаться; «тишина» — это баг.**
  Обоснование: `ot398ph` («I've been having an issue with workers not reporting their work done to the orchestrator/board», r/hermesagent 1ucdlu9 ⬆2), `ok9x374` («the fleshing out of the body under Triage is not implemented at all», r/hermesagent 1t5cjlm ⬆85), `oeoyf2l` («it wraps it's agents around anything that can receive a heartbeat», r/ClaudeAI 1sdsec0 ⬆25).
  Покрытие: **расширить** F9.3 (`no agent for role`) — добавить heartbeat-watchdog исполнителя, а не только проверку конфига роли.
- **F-R6. Переход `active → review` не может опираться на заявление агента «готово»: нужен проверяемый артефакт против критериев приёмки.**
  Обоснование: `ou0h9t0` («The agent can say it's done, but BatonBot's job i…», r/LocalLLM 1ugit8h), `p4en66r` («Claude finished a task and told me it was done», r/BuildWithClaude 1vloz92 ⬆80), `p430665` («I validate it at the artifact level rather than claiming a general productivity multiplier», r/ClaudeCode 1vphazv), `ottyfti` («creating each request as a task, so there's a paper trail», r/LocalLLaMA 1ufq3cz ⬆20).
  Покрытие: **расширить** F9.4 (критерии приёмки кладутся в промпт) — добавить обязательную запись результата верификации (команда + вывод/ссылка) в историю карточки как условие перехода.
- **F-R7. Нужен жёсткий cap на «отскоки» карточки между исполнителем и ревьюером.**
  Обоснование: `p8uthna` («that cap actually makes sense. without something like that, a messy task could probably keep bouncing between implemente…», r/buildinpublic 1wc2j8q), `p8uqvd7` («the done column bloat is real, archiving regularly seems like the only sane option», r/SaaS 1wc0ny9).
  Покрытие: **покрыто частично** F9.6 (`maxRetries` → `blocked`). (вывод) Полезно хранить счётчик bounce прямо на карточке и показывать его в UI, а `done` — архивировать/сворачивать.
- **F-R8. Каждая карточка должна исполняться в изолированном рабочем пространстве (worktree / отдельный workspace + порты).**
  Обоснование: `p8uc0p1` («opens its own workspace with unique ports», r/SaaS 1wc0ny9), `oeo8477` («Claude code with worktree are good combo», r/ClaudeAI 1sdsec0), `oelb44e` («it can lunch cloud cli for each task in its work tr…», там же), `odlfb9r` (вопрос «Are these agents modifying the same project folder at the same time?», r/VibeCodeDevs 1s5xh5a ⬆165).
  Покрытие: **не покрыто** черновиком — там изоляция ограничена claim'ом на карточку. Нужен отдельный пункт (worktree на карточку или workspace-политика).
- **F-R9. Модель должна быть привязана к роли и типу задачи, включая дешёвые модели на механические шаги.**
  Обоснование: `p90g9d2` (модель на тикет, «helped me save some tokens», r/SaaS 1wc0ny9), `ot5pj4e` («when you want to have Hermes call different models for different purposes», r/hermesagent 1ucmvi8), `ovqcqco`/`ozxzwss` («Model "Roles" function oh-my-pi has»; настройка `/models`, r/PiCodingAgent 1uo2waf ⬆33), `oomlav7` («you assign whatever models you want to to it and auxiliary tasks such as vision too», r/hermesagent 1tra70h ⬆8).
  Покрытие: **покрыто** F9.1 (`role.model`) + Dashboard; расширение — пресеты «plan на дорогой, механика на дешёвой» и видимость, какая модель что сожгла.
- **F-R10. Диспетчер должен уметь останавливаться на человеке в предсказуемых точках (приёмка, запрос ввода, неоднозначность) вместо бесконечного ожидания.**
  Обоснование: `oji6yhv` (HITL gates, r/ClaudeCode 1t1q54w), `ow23umz` («I pick small checkpoints where I can observe everything the agent does», r/PiCodingAgent 1uo2waf), `ot5jlj9` (сравнение Kanban vs delegate_task по durability и участию человека, r/hermesagent 1ucmvi8), `obogr07` («Are you releasing without reviewing any of the output?», r/AskVibecoders 1rzp5p9).
  Покрытие: **покрыто** частично (человек двигает карточку, если роль на `review` не задана) — плюс см. N-R7 про permission-запросы.
- **F-R11. Роль обязана оставлять handoff-артефакт на карточке (что сделано, чем проверено, что дальше), а следующая роль — читать его первой.**
  Обоснование: `p8upea0` («I added a free-form comments section in the task file without specific instructions, and you'd be surprised how often ag…», r/buildinpublic 1wc2j8q), `p8taikx` («a persistent record of what the agent did, why it…», r/SideProject 1wbqcdn ⬆17), `p9n3snc` («The handoff is where a lot of these systems still fall apart», r/aiagents 1vui1nh ⬆31), `p5dyu9j` («A multi-agent stack only works if you define handoff contracts and shared state boundaries up front», r/AISEOInsider 1vvx9cj), `onrgxla` (доска как memory layer «less token usage for new session», r/mcp 1tmoyl7 ⬆11).
  Покрытие: **расширить** F9.4/F9.8 — сделать handoff-блок формальным полем карточки, записываемым автоматически в конце хода.
- **F-R12. Роли и доска должны быть агент- и модель-агностичными: любой bridge (Hermes / OpenCode / Devin / Pi) с любым CLI-исполнителем.**
  Обоснование: `osrr0md` («Would've loved to try this if it were model agnostic. My workspace usually has two codex terminals and one claude worki…», r/ClaudeCode 1uam4jf ⬆0 💬20), `oxwznlz` («Cline is currently missing webhooks and integrations with external tools», r/opensource 1uxlfbj), `p6qjq6j` («Did you actually extensively test this in Codex?, wherever I look in your repository it's claude this claude that», r/ChatGPTPro 1w1v75w), `p5hdspp` (lane executor = любой CLI, r/hermesagent 1vwgt9i).
  Покрытие: **покрыто** F9.1 (`agentName` = мост) — нужно только явно тестировать роль на каждом bridge, а не на одном.
- **F-R13. UI надзора должен скрывать шум и показывать только то, что требует решения человека, и позволять человеку править состояние карточки.**
  Обоснование: `p931qhs` («the board only helps if it hides everything that does not need…», r/SideProject 1wbqcdn), `p8sn9lb` («The idea of the agentic development era is to oversee and manage. This is way too much information on a screen», там же), `onrm5ue` («the ui dont allow the dev to update the kanban check check info/progress and notes left by the agent», r/mcp 1tmoyl7 ⬆11), `oz33yy4` («there is a lot of stuff in the UI that needs polishing», r/ClaudeAI 1v3aky6 ⬆136).
  Покрытие: **расширить** F9.9 — добавить ручное редактирование заметок/прогресса по карточке (это ровно та дырка, на которую жалуются в r/mcp).

---

## 3. Нефункциональные требования

- **N-R1. Состояние диспетчера (claims, lease, очередь) должно жить вне вкладки: reload или падение клиента не создаёт вторую сессию на ту же карточку.**
  Обоснование: `ot5jlj9` — «Why Kanban beats delegate_task for durable work», где durability у delegate_task описана как «Lost if parent is interrupted» (r/hermesagent 1ucmvi8 ⬆109); `p8uc0p1` — lease на задачу (r/SaaS 1wc0ny9).
  Покрытие: **покрыто** N12 (`claims/lease` в KV, восстановление после reload).
- **N-R2. Heartbeat исполнителя обязателен: «молчащий» агент/сессия должны деградировать в `blocked` с причиной, а не держать карточку вечно.**
  Обоснование: `ot398ph` (воркеры не отчитываются в доску, r/hermesagent 1ucdlu9), `otbh8vz` (причина найдена в конфиге: «cli.interface: tui … causes the workers to…», там же), `oeoyf2l` (агенты оборачиваются вокруг «anything that can receive a heartbeat», r/ClaudeAI 1sdsec0), `ok9x374` (молчащая недоделанная часть флоу, r/hermesagent 1t5cjlm).
  Покрытие: **расширить** F9.5 (heartbeat нужен и для сессии, не только для claim).
- **N-R3. Идемпотентность запуска: повторный тик диспетчера, двойной клик «Run now» или ретрай не должны порождать вторую сессию.**
  Обоснование: `p8uc0p1` (lease на задачу, r/SaaS 1wc0ny9), `pb4j42z` (API «manages concurrent edits, also accounting for things like agents not crea…», r/buildinpublic 1wc2j8q).
  Покрытие: **покрыто** F9.5 + N12, но (вывод) стоит добавить явный тест «двойной тик → одна сессия».
- **N-R4. Наблюдаемость обязана включать стоимость: карточка/роль должны показывать, сколько токенов и денег сожгла сессия.**
  Обоснование: `p5htqqu` («the honesty about agy not emitting cost telemetry is exactly the kind of…», r/hermesagent 1vwgt9i ⬆17), `p72dxs1` («How do you choose which model run in each agent? Do you have a spend limit?», r/ClaudeCode 1vphazv ⬆215), `p5hcrej` (вопрос про цену 566 диспатчей, r/hermesagent 1vwgt9i), `p437g75` (как выглядит ответ «считай подписками, а не API», r/ClaudeCode 1vphazv).
  Покрытие: **покрыто** частично (Dashboard с токенами/квотами) — расширить до разреза «по роли».
- **N-R5. Лимиты и защита от разгона: `maxConcurrent` на роль, лимит ретраев, таймаут хода, видимый стоп-кран.**
  Обоснование: `o7k1145` («it takes longer because each agent queues up to the LLM in turn», r/LocalLLaMA 1rf9891 ⬆0 💬27), `o7k1kn7` («I am running agents that consume around 1B tokens per week», там же), `ode5tcu` («rip your api bill», r/VibeCodeDevs 1s5xh5a ⬆165), `oqlmk4q` («1. Prune preloaded skills I don't use…», r/hermesagent 1u0xpb6 ⬆60 💬70).
  Покрытие: **покрыто** F9.6 + квоты в Dashboard; расширение — лимит на карточку/роль, не только на агента.
- **N-R6. Безопасность unattended-запуска: изоляция секретов/токенов по профилю и мосту, минимум прав, никаких скрытых сетевых вызовов.**
  Обоснование: `ot5l9mu` («Are you using Hermes Desktop? Because for me the bot tokens are not isolated in the GUI», r/hermesagent 1ucmvi8 ⬆109), `ooph5mf` («the default adapter-to-integration setup doesn't work at all — I had to add th…», r/hermesagent 1tra70h ⬆8), `p6v3y91` (запрос «hardened/frozen deploym…», r/ChatGPTPro 1w1v75w), «Your AI agent is already compromised and you dont even know it» · r/AI_Agents · ⬆1048 · 💬177 · /r/AI_Agents/comments/1o7xuhf/your_ai_agent_is_already_compromised_and_you_dont/.
  Покрытие: **покрыто** N14 (нет скрытых запусков/телеметрии) — усилить явным «роль не получает доступ шире, чем её мост».
- **N-R7. Permission-запросы в unattended-ходе не должны подвешивать очередь: нужна политика (auto-allow по роли / очередь для человека с таймаутом / штатный уход в `blocked`).**
  Обоснование из Reddit: `p8uo4k3` («I actually choose to kill agents after they ask for input, rather than lettin…», r/buildinpublic 1wc2j8q), `ow23umz` (чекпоинты наблюдения, r/PiCodingAgent 1uo2waf), `oji6yhv` (HITL gates, r/ClaudeCode 1t1q54w).
  Факт из нашего репозитория (не Reddit): `src/lib/acp-bridge.ts` (`requestPermission`) резолвится промисом, который ждёт человека, — без таймаута и без дефолтной политики.
  Покрытие: **не покрыто** — это открытый вопрос №3 черновика; Reddit-выборку он подтверждает как реальную боль («агент завис на запросе ввода → его убивают»).
- **N-R8. Восстановление после падения хода: ошибка/таймаут возвращают карточку в `ready` с текстом ошибки в истории, а не оставляют «занятой».**
  Обоснование: `ooph5mf` («It keeps freezing, sometimes crashes…», r/hermesagent 1tra70h), `ozf17tn` («I'm having issues with drift during the cycle. Sometimes it'll start out building something simple and convince itself i…», r/hermesagent 1v4ojlr ⬆2 💬3).
  Покрытие: **покрыто** F9.4 (`→ ready` с текстом ошибки) + N12.
- **N-R9. UX надзора: работа диспетчера должна быть видна одним индикатором, а «нет сообщений о завершении» должно выглядеть как тревога.**
  Обоснование: `ot398ph` (воркеры не отчитываются, r/hermesagent 1ucdlu9), `ok9x374` (недоделанный участок флоу молчит, r/hermesagent 1t5cjlm), `p8sn9lb` (перегруз экрана, r/SideProject 1wbqcdn), `oz25pdh` (в треде r/ClaudeAI 1v3aky6 после 80 комментариев появился авто-TL;DR — сигнал, что тред/борд нечитаемы).
  Покрытие: **покрыто** F9.4 (тумблер + индикатор) — расширить статусом «застряла N минут».
- **N-R10. Никакой обязательной внешней инфраструктуры: локальное файловое/KV-хранение, self-hosted, без телеметрии.**
  Обоснование: `oz1wtue` («Linear is a fast SaaS… but it's their cloud, their API, their subscription. KP is a folder of Markdown files on your m…», r/ClaudeAI 1v3aky6 ⬆136), `oz3ov4h` («this being closed source is fishy as fuck», там же), `ospuh2j` («the card-based approach sidesteps the whole vector db tax that kills other memory systems», r/ClaudeCode 1uam4jf), `osqvwvy` («each time dolt blew up (hundreds of gb for small projects)», там же — цена «умного» хранилища).
  Покрытие: **покрыто** N14 + архитектурой (браузер, KV) — совпадает с ожиданиями сообщества.
- **N-R11. Конфиг ролей не должен «дрейфовать»: одна версионируемая точка правды вместо N ручных конфигов.**
  Обоснование: `ottzms5` («Is there any way of keeping configs between profiles on sync? I find that having to make sure the config of 9 differen…», r/hermesagent 1ucmvi8 ⬆109), `ozf2smn` («Hermes constantly coming up with "workarounds." It is so eager to rewrite its own cod…», r/hermesagent 1v4ojlr).
  Покрытие: **покрыто** N11 (`roles.json` + `version`).

---

## 4. Failure modes и критика (с тем, что люди делали против этого)

- **Двойной забор задачи / параллельная запись в один каталог.** Прямых отчётов «карточку взяли дважды» в выборке нет; ближайшее — вопрос «Are these agents modifying the same project folder at the same time?» (r/VibeCodeDevs 1s5xh5a ⬆165, `odlfb9r`). Митигация, которую применяют: lease на задачу + отдельный workspace и порты (`p8uc0p1`, r/SaaS 1wc0ny9) и claim с доски в Chorus (`o6sxzyi`, r/ClaudeCode 1rbphir). *(Отсутствие прямых отчётов — ограничение выборки, а не доказательство, что так не бывает.)*
- **Разгон/пинг-понг карточки между ролями.** «…a messy task could probably keep bouncing between implemente…» (`p8uthna`, r/buildinpublic 1wc2j8q). Митигация — лимит на количество проходов; отдельно жалуются на забитую `done`-колонку (`p8uqvd7`, r/SaaS 1wc0ny9).
- **Тихие остановки (silent stalls).** «I've been having an issue with workers not reporting their work done to the orchestrator/board» (`ot398ph`, r/hermesagent 1ucdlu9); причина оказалась в конфиге интерфейса (`otbh8vz`, там же). Незаконченные части Kanban-флоу просто молчат: «the fleshing out of the body under Triage is not implemented at all» (`ok9x374`, r/hermesagent 1t5cjlm ⬆85). Крэши и зависания оркестратора: «It keeps freezing, sometimes crashes» (`ooph5mf`, r/hermesagent 1tra70h).
- **Агент зависает на запросе ввода — и его убивают.** «I actually choose to kill agents after they ask for input, rather than lettin…» (`p8uo4k3`, r/buildinpublic 1wc2j8q) — ровно наш кейс `session/request_permission` при unattended-прогоне. Митигация там — не держать агента живым, а пересоздавать из состояния доски.
- **Потеря контекста между прогонами.** «The context-loss problem is real — I've had the same experience where you spin up three agents, step away for 20 minutes…» (`p8w1a1i`, r/SideProject 1wbqcdn ⬆17); «The handoff is where a lot of these systems still fall apart» (`p9n3snc`, r/aiagents 1vui1nh); «One card is one agent session» (`otuym5i`, r/LocalLLaMA 1ufq3cz). Митигации: доска как источник истины (`p8un5ei`), постоянная память с детерминированной инъекцией (`p4q92dh`, r/SideProject 1vt3c7p), free-form заметки агентов (`p8upea0`), memory layer для MCP (`onrgxla`, r/mcp 1tmoyl7).
- **Ложное «готово» и самооценка.** «Claude Code finished a task, told me it was done, and left me with 14 changed files an…» (`p4en66r`, r/BuildWithClaude 1vloz92 ⬆80); «The agent can say it's done, but BatonBot's job i…» (`ou0h9t0`, r/LocalLLM 1ugit8h); «an agent grading its own work» — то, что стараются исключать (`p4bym5r`, r/codex 1vqm7h0); «I validate it at the artifact level» (`p430665`, r/ClaudeCode 1vphazv). Митигации: отдельный проверяющий, артефакт-валидация.
- **Ревью — узкое место, а «холодный» ревьюер наследует ошибки.** «the cold reviewer is the bit i'd test hardest. if driver + reviewer share the same primer and room, they can inherit the…» (`p3zfhww`, r/ClaudeCode 1vphazv); сам вопрос «Are you releasing without reviewing any of the output?» (`obogr07`, r/AskVibecoders 1rzp5p9) — и ответ «I review everything before merge, no auto merge» (`obtsm5g`, там же). Плюс отдельная боль — дрейф документов: «Broken flows you notice quite quick, doc rot you don't» (`p3zlcov`, r/ClaudeCode 1vphazv), что лечат статусом в index-файле.
- **Разрастание стоимости и отсутствие телеметрии.** «rip your api bill» (`ode5tcu`, r/VibeCodeDevs 1s5xh5a ⬆165); «each agent queues up to the LLM in turn» (`o7k1145`, r/LocalLLaMA 1rf9891); «I am running agents that consume around 1B tokens per week» (`o7k1kn7`, там же); про чужой harness: «the honesty about agy not emitting cost telemetry…» (`p5htqqu`, r/hermesagent 1vwgt9i). Личный «пояс» — прюнинг скиллов/предзагрузки (`oqlmk4q`, r/hermesagent 1u0xpb6 ⬆60 💬70) и подписочная модель вместо API (`p437g75`, r/ClaudeCode 1vphazv).
- **Дрейф задачи и «работа вокруг».** «In my experience it's fragile and doesn't work» (`ozesyba`, r/hermesagent 1v4ojlr ⬆2); «I'm having issues with drift during the cycle» (`ozf17tn`); «Hermes constantly coming up with "workarounds."» (`ozf2smn`, там же). Это главный аргумент за review-роль и за явный cap ретраев.
- **Слишком умные роли ломаются на уровне конфигов.** 9 профилей и их синхронизация (`ottzms5`, r/hermesagent 1ucmvi8), токены профилей не изолированы в GUI (`ot5l9mu`, там же), обучение на «маленьких чекпоинтах» вместо полной автономии (`ow23umz`, r/PiCodingAgent 1uo2waf).
- **Фидбек-петля и самоподтверждение.** «The key failure mode here is feedback amplification: once one agent proposes a pattern, the others can converge too fast…» (`p8395dr`, r/AISEOInsider 1w8jqhs ⬆1) — применимо к паре исполнитель↔ревьюер с общим контекстом (см. `p3zfhww`).
- **Критика самой категории «агенты сами тянут задачи».** «One agent working well and reliably is not a solved problem, and we have jokers doing crap like this» (`ovr8bh2`, r/PiCodingAgent 1uo2waf ⬆33); «Subagents only really works if you've planned out all the steps in details» (`ow1j4mm`, там же); «There doesn't seem to be any benefit to having multiple agents chat with each other…» (`o7jb47e`, r/LocalLLaMA 1rf9891); «The part that's genuinely hard to automate isn't coordination — it's organizational trust» (`oakdolh`, r/artificial 1ruae1l ⬆0 💬28).
- **Критика конкретно жанра «kanban для агентов».** «Everybody and their grandma has made their own Claude's task list» (`oz1uipv`, r/ClaudeAI 1v3aky6); «95% of your code base has telltale signs of being AI generated» (`oxx99jq`, r/opensource 1uxlfbj); «AI slop» (`p8tpdmh`, r/SideProject 1wbqcdn); «this is literally slop» (`p3z5mjm`, r/ClaudeCode 1vphazv); «Fake testimonials, gtfo» (`o6vgc5x`, r/ClaudeCode 1rbphir); «Needs vetting and testing first» (`p6rhees`, r/ChatGPTPro 1w1v75w). Плюс: «the fact it imposes a harness and rigid workflow makes it a pass for me» (`p8uzjf6`, r/SideProject 1wbqcdn) и «there is a lot of stuff in the UI that needs polishing» (`oz33yy4`, r/ClaudeAI 1v3aky6) — оба про переусложнение и «свою рамку».
- **Отдельно про «duplicate claims»: прямых репортов нет; про permission prompts: прямых обсуждений `session/request_permission` в дампах нет.** См. раздел «Ограничения данных».

---

## 5. Конкретные рекомендации для нашей фичи ролей

1. **Промпт роли — файл в рабочем каталоге (`ROLE.md` / `AGENTS.md`), inline-строка как fallback; путь и хэш файла пишем в карточку и леджер.** Опора: `p3zg042` (routing map + шаблоны ролей файлами, r/ClaudeCode 1vphazv ⬆215) и `ou56gtf` (worker-specific `AGENTS.md`, r/hermesagent 1ugkihk ⬆85). Закрывает открытый вопрос №1 черновика в сторону файла.
2. **Review-колонка получает свою роль с другой моделью и «чистым» контекстом, авто-переход в `done` запрещён.** Опора: `obtsm5g` (no auto merge + отдельный агент-ревьюер, r/AskVibecoders 1rzp5p9 ⬆117), `p3zfhww` (общий primer исполнителя и ревьюера = наследование ошибок, r/ClaudeCode 1vphazv), `p4bym5r` (r/codex 1vqm7h0). В черновике F9.10 допускает «тот же агент с другой ролью» — это стоит прямо ограничить.
3. **Политика разрешений на уровне роли: allow-list + таймаут + вынос запроса в UI как «требует человека», вместо подвешивания хода.** Опора: `p8uo4k3` (агентов убивают после запроса ввода, r/buildinpublic 1wc2j8q), `oji6yhv` (HITL gates, r/ClaudeCode 1t1q54w), `ow23umz` (контролируемые чекпоинты, r/PiCodingAgent 1uo2waf). Технически: сейчас `src/lib/acp-bridge.ts` (`requestPermission`) ждёт клик человека без таймаута — при включённом диспетчере это ровно тот отказ, о котором предупреждают в выборке.
4. **Claim + lease + heartbeat как единый механизм, и явное состояние «нет живого исполнителя под роль» вместо тишины.** Опора: `p8uc0p1` (lease на задачу + свой workspace, r/SaaS 1wc0ny9), `o6sxzyi` (claim с доски, r/ClaudeCode 1rbphir ⬆43), `ot398ph` и `otbh8vz` (воркеры не отчитываются — реальный баг конфигурации, r/hermesagent 1ucdlu9), `oeoyf2l` (heartbeat, r/ClaudeAI 1sdsec0). Покрывает F9.5 + расширяет F9.3.
5. **Переход `active → review` только с записанным handoff-блоком: что сделано, каким артефактом проверено, что осталось.** Опора: `ou0h9t0` (harness против заявки «готово», r/LocalLLM 1ugit8h), `p430665` (валидация на уровне артефакта, r/ClaudeCode 1vphazv), `p8upea0` (свободные заметки агентов работают без жёсткого формата, r/buildinpublic 1wc2j8q), `p5dyu9j` (handoff-контракты и границы состояния, r/AISEOInsider 1vvx9cj), `p9n3snc` (ломается именно на handoff, r/aiagents 1vui1nh).
6. **Стоимость и лимиты рядом с ролью: лимит на карточку/роль, дешёвая модель на механику, видимый расход по роли.** Опора: `p90g9d2` (модель на тикет экономит токены, r/SaaS 1wc0ny9), `p5htqqu` (отсутствие cost-телеметрии — отдельная боль, r/hermesagent 1vwgt9i ⬆17), `o7k1145` (агенты встают в очередь к LLM, r/LocalLLaMA 1rf9891), `ode5tcu` («rip your api bill», r/VibeCodeDevs 1s5xh5a ⬆165), `p72dxs1` (вопрос про spend limit, r/ClaudeCode 1vphazv).
7. **Изоляция рабочего пространства на карточку (worktree/отдельный workspace+порты) — добавить в черновик как явное требование и UI-поле.** Опора: `p8uc0p1` (own workspace with unique ports, r/SaaS 1wc0ny9), `oeo8477` и `oelb44e` (worktree на задачу, r/ClaudeAI 1sdsec0), `odlfb9r` (страх параллельной правки одной папки, r/VibeCodeDevs 1s5xh5a ⬆165).

---

## Ограничения данных

- **Файл `rd_roles_4.json` («AI agent control center») — почти полностью шум:** 505 постов, среди них политика (`r/InterstellarKinetics`, `r/AskTrumpSupporters`, `r/Keep_Track`), Minecraft 1.16, Sonos, Droppy, Mac Studio. Релевантного там три-четыре треда (`1vui1nh`, `1uc9xbc`, `1w1zcur`, `1o7xuhf`), и только из первых двух взяты цитаты.
- **`rd_roles_3.json` тоже наполовину свалка** (`Qwen 3.8 - 27B`, `Aussie corporate AI bloodbath`, `r/Epstein`, `r/macapps`) — оттуда взяты только доски/оркестраторы.
- **Сниппеты обрезаны примерно на 120 знаках**, поэтому полных цитат нет: всё, что процитировано, — начало фразы, как она лежит в дампе; длинные тезисы redditor'ов я пересказываю по этой первой фразе. Полные треды не читались.
- **Пост-уровневые score/comment count есть, у комментариев — только score и возраст.** Многие системы в выборке — самопромо с ⬆0–⬆5 (BatonBot, Chorus, Flare, pi-hive); доверия к ним меньше, чем к мегатредам (⬆85–⬆215).
- **r/AISEOInsider** (7 постов в `rd_roles_2.json`) выглядит как агрегатор-контент-ферма; использован один комментарий (`p8395dr`) как единственная формулировка «feedback amplification».
- **Прямых отчётов о duplicate claims, runaway-сессиях и о `session/request_permission` в выборке нет.** Я не приписываю выборке эти failure modes: про дубликаты и permission-зависания сказано честно, что опора — косвенная (`odlfb9r`, `p8uo4k3`, плюс факт из нашего кода). Ничего не додумывалось под видом цитаты; всё, что является моим выводом, помечено «(вывод)».

---

## Приложение: указатель цитат

Все 39 тредов, на которые есть ссылки в тексте (сокращения вида `1wc2j8q` — это `postId` из дампа):

| threadId | сабреддит | заголовок | score/comments | URL |
|---|---|---|---|---|
| `1w8jqhs` | r/AISEOInsider | Multi Agent AI Systems Can Copy Each Other Without Instructions | ⬆1 💬1 | https://www.reddit.com/r/AISEOInsider/comments/1w8jqhs/multi_agent_ai_systems_can_copy_each_other/ |
| `1vvx9cj` | r/AISEOInsider | Google Antigravity Multi Agent I’d Use To Build Full Apps Faster | ⬆1 💬1 | https://www.reddit.com/r/AISEOInsider/comments/1vvx9cj/google_antigravity_multi_agent_id_use_to_build/ |
| `1o7xuhf` | r/AI_Agents | Your AI agent is already compromised and you dont even know it | ⬆1048 💬177 | https://www.reddit.com/r/AI_Agents/comments/1o7xuhf/your_ai_agent_is_already_compromised_and_you_dont/ |
| `1vwazom` | r/ArtificialInteligence | Flare, a graph-first IDE for agentic coding: watch the map change while your agent works | ⬆35 💬12 | https://www.reddit.com/r/ArtificialInteligence/comments/1vwazom/flare_a_graphfirst_ide_for_agentic_coding_watch/ |
| `1rzp5p9` | r/AskVibecoders | Terminal kanban for managing multiple AI coding sessions in parallel - with orchestrator agent | ⬆117 💬13 | https://www.reddit.com/r/AskVibecoders/comments/1rzp5p9/terminal_kanban_for_managing_multiple_ai_coding/ |
| `1vloz92` | r/BuildWithClaude | Flare, a graph-first IDE for agentic coding: watch the map change while your agent works | ⬆80 💬8 | https://www.reddit.com/r/BuildWithClaude/comments/1vloz92/flare_a_graphfirst_ide_for_agentic_coding_watch/ |
| `1w1v75w` | r/ChatGPTPro | Maurdekye/claude-orgtree: a Multi-agent Orchestrator for Claude Code (& Codex / Gemini) | ⬆4 💬13 | https://www.reddit.com/r/ChatGPTPro/comments/1w1v75w/maurdekyeclaudeorgtree_a_multiagent_orchestrator/ |
| `1sdsec0` | r/ClaudeAI | I built nod, a kanban markdown based task manager for AI coding agents | ⬆25 💬24 | https://www.reddit.com/r/ClaudeAI/comments/1sdsec0/i_built_nod_a_kanban_markdown_based_task_manager/ |
| `1v3aky6` | r/ClaudeAI | Kanban Board for Claude Code - no paywalls, no sign ups, no subscriptions | ⬆136 💬98 | https://www.reddit.com/r/ClaudeAI/comments/1v3aky6/kanban_board_for_claude_code_no_paywalls_no_sign/ |
| `1vaowu8` | r/ClaudeAI | I themed my kanban board as The Matrix - Neo orchestrates and the crew pulls cards through backlog -> doing -> review -> PR -> done on their own | ⬆10 💬2 | https://www.reddit.com/r/ClaudeAI/comments/1vaowu8/i_themed_my_kanban_board_as_the_matrix_neo/ |
| `1vphazv` | r/ClaudeCode | A humble guide to the multi-agent workflows I use every day | ⬆215 💬35 | https://www.reddit.com/r/ClaudeCode/comments/1vphazv/a_humble_guide_to_the_multiagent_workflows_i_use/ |
| `1t1q54w` | r/ClaudeCode | What agent orchestrator are you using? | ⬆15 💬22 | https://www.reddit.com/r/ClaudeCode/comments/1t1q54w/what_agent_orchestrator_are_you_using/ |
| `1uam4jf` | r/ClaudeCode | Messy workflow with Claude? I built a live WorkBoard for humans and agents! | ⬆0 💬20 | https://www.reddit.com/r/ClaudeCode/comments/1uam4jf/messy_workflow_with_claude_i_built_a_live/ |
| `1rbphir` | r/ClaudeCode | I built Chorus — an open-source SaaS for teams to coordinate Claude Code agents on the same repo, with a shared Kanban, traceable audit trail, and pixel boss view | ⬆43 💬32 | https://www.reddit.com/r/ClaudeCode/comments/1rbphir/i_built_chorus_an_opensource_saas_for_teams_to/ |
| `1vjrxmb` | r/ClaudeWorkflows | [Workflow] LoopBoard: Orchestrate AI Agent Loops with a TODO.md Kanban Board in VS Code for Cost Efficiency and Persistent State | ⬆1 💬0 | https://www.reddit.com/r/ClaudeWorkflows/comments/1vjrxmb/workflow_loopboard_orchestrate_ai_agent_loops/ |
| `1wl347x` | r/ClaudeWorkflows | [Workflow] Kangentic: Kanban Board for Claude Code with Git Worktrees and Configurable Agent Stages | ⬆1 💬0 | https://www.reddit.com/r/ClaudeWorkflows/comments/1wl347x/workflow_kangentic_kanban_board_for_claude_code/ |
| `1uc9xbc` | r/LocalLLM | I built a platform where 8 AI agents live and argue 24/7 — humans can only watch. One of them is auditing my spice drawer! | ⬆56 💬32 | https://www.reddit.com/r/LocalLLM/comments/1uc9xbc/i_built_a_platform_where_8_ai_agents_live_and/ |
| `1ugit8h` | r/LocalLLM | Built an open source local first Kanban workflow for running AI coding agents without babysitting every step | ⬆2 💬15 | https://www.reddit.com/r/LocalLLM/comments/1ugit8h/built_an_open_source_local_first_kanban_workflow/ |
| `1rf9891` | r/LocalLLaMA | Anyone actually running multi-agent setups that coordinate autonomously? | ⬆0 💬27 | https://www.reddit.com/r/LocalLLaMA/comments/1rf9891/anyone_actually_running_multiagent_setups_that/ |
| `1ufq3cz` | r/LocalLLaMA | Built an open source local first Kanban workflow for running AI coding agents without babysitting every step | ⬆20 💬40 | https://www.reddit.com/r/LocalLLaMA/comments/1ufq3cz/built_an_open_source_local_first_kanban_workflow/ |
| `1uo2waf` | r/PiCodingAgent | Made a Pi extension for hierarchical multi-agent orchestration — is this useful to anyone, or does it already exist? | ⬆33 💬18 | https://www.reddit.com/r/PiCodingAgent/comments/1uo2waf/made_a_pi_extension_for_hierarchical_multiagent/ |
| `1wc0ny9` | r/SaaS | My personal solution to AI context bloat: A Kanban board. | ⬆7 💬15 | https://www.reddit.com/r/SaaS/comments/1wc0ny9/my_personal_solution_to_ai_context_bloat_a_kanban/ |
| `1wbqcdn` | r/SideProject | I built a workspace for coding agents. Looking for early testers. | ⬆17 💬37 | https://www.reddit.com/r/SideProject/comments/1wbqcdn/i_built_a_workspace_for_coding_agents_looking_for/ |
| `1vt3c7p` | r/SideProject | I built a vibe-kanban fork with persistent agent memory (mem0 + Qdrant) — context loss across sessions was killing my workflow | ⬆1 💬2 | https://www.reddit.com/r/SideProject/comments/1vt3c7p/i_built_a_vibekanban_fork_with_persistent_agent/ |
| `1s5xh5a` | r/VibeCodeDevs | Terminal kanban for managing multiple AI coding sessions in parallel - with orchestrator agent | ⬆165 💬31 | https://www.reddit.com/r/VibeCodeDevs/comments/1s5xh5a/terminal_kanban_for_managing_multiple_ai_coding/ |
| `1vui1nh` | r/aiagents | AI agents are getting good. Making the whole system work is the interesting part. | ⬆31 💬21 | https://www.reddit.com/r/aiagents/comments/1vui1nh/ai_agents_are_getting_good_making_the_whole/ |
| `1ruae1l` | r/artificial | Engineering management is the next role likely to be automated by LLM agents | ⬆0 💬28 | https://www.reddit.com/r/artificial/comments/1ruae1l/engineering_management_is_the_next_role_likely_to/ |
| `1wc2j8q` | r/buildinpublic | My personal solution to AI context bloat: A Kanban board. | ⬆5 💬14 | https://www.reddit.com/r/buildinpublic/comments/1wc2j8q/my_personal_solution_to_ai_context_bloat_a_kanban/ |
| `1vqm7h0` | r/codex | ZaoFu: an open-source harness for long-horizon, multi-agent software delivery | ⬆0 💬3 | https://www.reddit.com/r/codex/comments/1vqm7h0/zaofu_an_opensource_harness_for_longhorizon/ |
| `1ucmvi8` | r/hermesagent | Multi-Agent & Profiles Megathread — Hermes Agent (June 2026) | ⬆109 💬35 | https://www.reddit.com/r/hermesagent/comments/1ucmvi8/multiagent_profiles_megathread_hermes_agent_june/ |
| `1ugkihk` | r/hermesagent | Kanban Setups Megathread — Hermes Agent (June 2026) | ⬆85 💬15 | https://www.reddit.com/r/hermesagent/comments/1ugkihk/kanban_setups_megathread_hermes_agent_june_2026/ |
| `1t5cjlm` | r/hermesagent | MEGATHREAD: Multi-Agent Workflows — Kanban, Delegation & Advanced Patterns | ⬆85 💬14 | https://www.reddit.com/r/hermesagent/comments/1t5cjlm/megathread_multiagent_workflows_kanban_delegation/ |
| `1ucdlu9` | r/hermesagent | Hermes Agent: Multi-Profile Kanban | ⬆2 💬6 | https://www.reddit.com/r/hermesagent/comments/1ucdlu9/hermes_agent_multiprofile_kanban/ |
| `1vwgt9i` | r/hermesagent | Three months of running Hermes as a kanban controller over Claude Code, OpenCode, Codex and MiMo - 560+ agent dispatches, here's what broke | ⬆17 💬7 | https://www.reddit.com/r/hermesagent/comments/1vwgt9i/three_months_of_running_hermes_as_a_kanban/ |
| `1tra70h` | r/hermesagent | Hermes Kanban feels complex vs Paperclip's agent system — does Hermes have similar resilience features, and is there a plugin or a fork worth building? | ⬆8 💬7 | https://www.reddit.com/r/hermesagent/comments/1tra70h/hermes_kanban_feels_complex_vs_paperclips_agent/ |
| `1u0xpb6` | r/hermesagent | Looking for a Cost-Effective AI Setup for Hermes Agent (Coding + General Tasks) | ⬆60 💬70 | https://www.reddit.com/r/hermesagent/comments/1u0xpb6/looking_for_a_costeffective_ai_setup_for_hermes/ |
| `1v4ojlr` | r/hermesagent | Setting up a dev loop using the Kanban board | ⬆2 💬3 | https://www.reddit.com/r/hermesagent/comments/1v4ojlr/setting_up_a_dev_loop_using_the_kanban_board/ |
| `1tmoyl7` | r/mcp | I gave my terminal AI agent a Kanban board. Not for me for its own memory. | ⬆11 💬29 | https://www.reddit.com/r/mcp/comments/1tmoyl7/i_gave_my_terminal_ai_agent_a_kanban_board_not/ |
| `1uxlfbj` | r/opensource | I built an open-source Kanban board for running AI coding agents | ⬆0 💬15 | https://www.reddit.com/r/opensource/comments/1uxlfbj/i_built_an_opensource_kanban_board_for_running_ai/ |
