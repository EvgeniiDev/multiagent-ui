# Отчёт: researcher-pm + доступ к Reddit без жёстких лимитов

Карточка `22c664fb`, ветка `cc/researcher`, 2026-09-26.

## Часть 1. Варианты доступа к Reddit — проверено живьём 2026-09-26

| Вариант | Цена | Лимиты | Комменты | Вердикт |
|---|---|---|---|---|
| **Публичный RSS** `/r/<s>/new/.rss`, `/comments/<id>/.rss` | $0 | ~1 успешный запрос/мин на IP (общий пул на посты+комменты), ≤100 постов/запрос, без пагинации | да, 1 слот на тред, top-сортировка | **Основа.** Бесплатно, живо (пилотный прогон ниже), медленно но предсказуемо: ~60 запросов/час |
| **Apify** `fatihtahta~reddit-scraper-search-fast` | Free $5/мес включённого usage; **Starter $19/мес** (понижен с $29 ~11.09.2026) + overage до $100 | Hard-cap: при исчерпании `403 platform-feature-disabled`; ~$1.2–1.5/1K результатов | да, `scrapeComments`+`maxComments`, batch по `urls[]` | **Второй слой.** Сейчас квота выбрана ($5.15/$5, ресет 2026-09-27); ротация ключей внедрена |
| Ротация Apify-ключей | N×$5 free | как у Apify | да | Механика внедрена (`APIFY_TOKENS`/`APIFY_TOKEN_2..8`, fallback по 402/403-quota/429). Честно: несколько **бесплатных** аккаунтов — серая зона ToS; нормальное применение — платный ключ + free-запасной, ключи только в `~/.hermes/.env` |
| **Официальный Reddit API (OAuth)** | free non-commercial 100 QPM | 100 QPM/клиент; $0.24/1K commercial | да, нативно | **Не сегодня.** Self-serve регистрация закрыта с 11.2025 (Responsible Builder Policy, ручная заявка, недели). Старые creds живы, но у нас их нет. Стоит подать заявку и ждать — на 100 QPM это был бы лучший путь |
| **pullpush.io** | «free» | 429 + «does not provide free scraping resources for agents»; свежие комменты пустые (проверено и раньше) | нет для свежих | Мёртвый для нас |
| **Самостоятельный скрейпинг + ротация IP** | residential-прокси $$/GB | Reddit агрессивно банит датацентр-IP | если дожил | Не стоит: Apify уже продаёт ровно этот результат дешевле собственной инфраструктуры |
| **glim.sh** | $0.01/search, **$0.015/post+comments** | пополняемый баланс, без месячного минимума; MCP есть | да (`reddit/get`) | Живой, дёшев, агент-нативный. Требует пополнения баланса (402 без него). Хороший «промежуточный» платный путь |
| **redditapis.com** | $0.002/чтение, $0.50 стартовых | pay-per-call | да | Живой; реселл одобренного доступа — серая зона, на вкус владельца |
| **fetchlayer** | $0.00199/req | кредиты, 30 бесплатных | да | Живой, MCP включён |

### Что внедрено

**Гибрид: RSS — хребет, Apify — комменты/поиск когда есть бюджет, RSS-comments — fallback.**

- `scripts/research/collect.py` — коллектор: RSS по сабам (sequential, 20с пауза, backoff 30→240с на 429, failures-first, dead-subs помечаются), TG через `tg-read`, дедуп по seen-set, скоринг по осям, комменты к топ-K постам (Apify batch `urls[]`+`scrapeComments` с ротацией токенов и preflight-проверкой `/users/me/limits` → иначе RSS `/comments/<id>/.rss`).
- `~/.hermes/scripts/reddit_search.py` — ротация ключей: `APIFY_TOKENS` (список) + `APIFY_TOKEN`, `APIFY_TOKEN_2..8`; квота-блок (402/403 `platform-feature-disabled`/`usage hard limit`/429) или смерть рана по квоте → следующий ключ. Проверено живьём: единственный ключ с выбранной квотой честно падает с `403`.
- Секреты — только `~/.hermes/.env`. Чтобы добавить запасной ключ: `APIFY_TOKEN_2=...` или `APIFY_TOKENS=a,b`.

### Измеренные факты прогона (пилот, реальный)

- 6 сабов × `?limit=50` + 3 треда комментов: каждый запрос после первого ловил один 429 → retry ~35–40с → 200. Итого ~9 запросов ≈ 10 минут за прогон.
- Apify: preflight `GET /users/me/limits` вернул `monthlyUsageUsd=5.15 > max=5` → токен пропущен без запуска, комменты ушли в RSS-fallback. Бесплатный цикл ресетится 2026-09-27.
- pullpush: `api.pullpush.io` отвечает 429 и текстом «не даём бесплатный скрейпинг агентам» — не вариант.

## Часть 2. researcher-pm (пилот acp-ui)

### Файлы

- `.acp/roles/researcher.md` — роль по образцу pm.md: порядок прогона (collect → digest → idea.py → boardctl), что можно/нельзя, контракт отчёта со `STATUS:`.
- `scripts/research/collect.py` — сборщик (см. выше).
- `scripts/research/idea.py` — детерминированная запись в `~/.hermes/IDEA_BACKLOG.md` (`add` — авто-нумерация `## Идея #N`, формат исходный) и `card` — `boardctl add` + обратная ссылка на карточку в идее.
- `scripts/research/sources.acp-ui.json` — источники/оси/лимиты проекта: 19 сабов (ядро из скилла + ClaudeCode/ClaudeAI/ChatGPTCoding/VibeCodeDevs под оркестрацию), 7 TG-каналов из списка Pi-сессии, оси orchestration/coding_agents/new_models/free_tier/providers_pricing/benchmarks/agent_infra + penalties.
- `scripts/research/wakeup.sh` — этюд обвязки таймера: collect (без модели) → есть новое → spawn роли.
- `docs/acp-researcher-wakeup.{service,timer}` — юниты-референс (НЕ включены).
- `docs/researcher-brief-template.md` — шаблон брифа для wakeup-прогона.
- `server/acp-pm-wakeup.mjs` — обобщён без слома контракта: `PM_ROLE_ID` уже был; добавлены `PM_KIND`, `PM_SESSION_PREFIX`, `PM_REPORT_NAME`, `PM_BRIEF_FILE` (плейсхолдеры `{{session}} {{runDir}} {{reportPath}} {{promptFile}} {{scope}} {{digest}}`), `PM_DIGEST_PATH`. Дефолты = pm-поведение, e2e_pm_wakeup зелёный (37/37).
- В `roles.json` на стейт-сервере добавлена роль `researcher` (pi/spark, как pm; без привязки к стадии — инертна, пока wakeup/диспетчер её не позовёт).

### Пилотный прогон (реальный, 2026-09-26)

`collect.py --subs LocalLLaMA,ClaudeCode,opencode,OpenaiCodex,mcp,agenticAI --comments auto --top-comments 3`:

- собрано **284 элемента** (221 Reddit-пост + 63 TG-сообщения), 0 дублей;
- комменты топ-3 постов приехали через RSS-fallback (Apify preflight честно отказал);
- digest: `.acp/research/runs/20260926-035008/digest.md` — топ: OpenCode v2 transparency, OpenJev (классификатор мелких решений), per-session Chrome pairing, agentic lifecycle, token-usage.

В `IDEA_BACKLOG.md` заведены **идеи #8–#12** (классификатор-дежурный, метрика навигационного шума, browser pairing, agentic-цикл тред, free-модели как субагенты). Карточка-пилот: **`76c6fcd7`** «Дешёвый классификатор-дежурный для механических решений агента (паттерн OpenJev)» — backlog, acp-ui, со ссылкой на источник.

### Периодика — механика (предложение, НЕ включено)

- `acp-researcher-wakeup.timer`: `OnBootSec=15min`, `OnUnitInactiveSec=8h` (3×/день — RSS-квота делает чаще бессмысленным), `Persistent`.
- `acp-researcher-wakeup.service` → `scripts/research/wakeup.sh`: сначала `collect.py` (чистый fetch, без модели — «тихий» тик бесплатен), при `new items > 0` → `acp-pm-wakeup.mjs --force` с `PM_ROLE_ID=researcher`, отдельными wakeup-doc/каталогом и brief-template. Гейт = «есть новые элементы», а не «доска изменилась» — поэтому `--force` после коллектора.
- Включение (когда решит владелец): `systemctl --user link` юнитов + `enable --now` таймера; плюс путь `REPO` в юните — основной чекаут `~/projects/acp-ui`.

## Тесты

- `scripts/e2e_research.py` — **23/23 PASS**, полностью офлайн (фикстуры Atom/tg/комментов): сбор, скоринг+PENALTY, дедуп по seen-set, failures-first и восстановление саба, `idea.py add`→`card` на тестовом стейт-сервере, wakeup-spawn researcher-стаба с брифом из шаблона и `kind:researcher` в леджере. Добавлен в `e2e_all.py`.
- `e2e_pm_wakeup.py` — **37/37 PASS** после обобщения pm-wakeup.
- Панель (`src/`) не трогал.
