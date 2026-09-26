# Автопрогон researcher — {{session}}

Это автоматический запуск роли researcher по расписанию
(acp-researcher-wakeup). Карточки-триггера нет — `boardctl show` пропусти.

- скоуп: проект `{{scope}}`
- файл роли: {{promptFile}}
- сбор уже сделан collect.py — свежий дайджест: {{digest}}
  (если пусто — возьми последний каталог `.acp/research/runs/*/digest.md`)
- артефакты прогона: {{runDir}}/
- отчёт пиши в {{reportPath}} (содержание — как в роли;
  последняя строка `STATUS: DONE | BLOCKED | CHANGES_REQUIRED`)

Прочитай файл роли и следуй его порядку прогона.
