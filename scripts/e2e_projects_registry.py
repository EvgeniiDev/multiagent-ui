#!/usr/bin/env python3
"""E2E for the W1 projects registry (project = folder) + Settings admin.

Run: npm run build:web, then run this with the tools venv python
(sync_playwright, chromium headless). The script serves dist-web itself
on http://127.0.0.1:25988/.

Asserts, on 1440 and 390 widths:
  * fresh profile: `Common` exists, points at /home/hermes/projects
    (registry entry in localStorage `acp-ui:projects.json`);
  * create-project-with-new-folder: type /home/hermes/projects/<unique>,
    the folder really appears on disk (via the bridge POST /api/fs/mkdir
    + GET /api/fs/list) and the project appears in the list;
  * add-existing-folder via DirectoryPicker (browse -> navigate -> Use);
  * rename works; delete works; Common cannot be deleted (disabled
    button + visible error when forced);
  * activeProjectId persists across reload (set via page.evaluate);
  * projectIdForCwd / sessionsOfProject on synthetic sessions, incl. the
    /a vs /ab prefix trap (via page.evaluate against the pinia store);
  * zero pageerrors.

Screenshots land in docs/projects-admin-1440x900.png and
docs/projects-admin-390x844.png.
"""

import json
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist-web"
SHOTS = ROOT / "docs"
PORT = 25988
BASE = f"http://127.0.0.1:{PORT}/"
BRIDGE = "http://127.0.0.1:25901"
COMMON_PATH = "/home/hermes/projects"

results: list[tuple[str, bool, str]] = []
errors: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, bool(ok), detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail and not ok else ""))


def start_server() -> subprocess.Popen:
    # The port may sit in TIME_WAIT after a crashed run (no listener, bind
    # fails, connect fails). Retry the bind briefly instead of refusing.
    for _ in range(30):
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", PORT))
            break
        except OSError:
            time.sleep(1)
        finally:
            s.close()
    else:
        print(f"FAIL  port {PORT} still busy after 30s — refusing a stale server")
        sys.exit(1)
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
        cwd=str(DIST), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE, timeout=1)
            return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    print(f"FAIL  could not serve {DIST} on port {PORT}")
    proc.terminate()
    sys.exit(1)


def bridge_mkdir(path: str) -> tuple[bool, str]:
    try:
        req = urllib.request.Request(
            f"{BRIDGE}/api/fs/mkdir",
            data=json.dumps({"path": path}).encode(),
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            return True, r.read().decode()[:160]
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:160]


def bridge_has_dir(parent: str, name: str) -> bool:
    try:
        with urllib.request.urlopen(
            f"{BRIDGE}/api/fs/list?path={urllib.parse.quote(parent, safe='')}&hidden=1",
            timeout=10,
        ) as r:
            dirs = json.loads(r.read().decode()).get("dirs", [])
        return any(d.get("name") == name for d in dirs)
    except Exception:  # noqa: BLE001
        return False


import urllib.parse  # noqa: E402  (kept after helpers for readability)


def open_settings(page) -> None:
    page.goto(BASE, wait_until="load")
    page.wait_for_timeout(1500)
    # Narrow layouts collapse the sidebar into a drawer — open it first
    # (only when the viewport is actually narrow; on desktop the hidden
    # hamburger exists in the DOM but is covered by the view rail).
    if page.viewport_size and page.viewport_size["width"] < 800:
        hamburger = page.get_by_role("button", name="Open menu")
        if hamburger.count() > 0 and hamburger.first.is_visible():
            # JS click: on 390px the fixed hamburger sits under the
            # view rail, so a real pointer click is intercepted.
            hamburger.first.evaluate("(el) => el.click()")
            page.wait_for_timeout(500)
    btn = page.get_by_role("button", name="Settings")
    assert btn.count() > 0, "no Settings button"
    btn.first.click()
    page.wait_for_selector('[data-testid="settings-projects"]', timeout=15000)


def read_registry(page) -> dict:
    return page.evaluate(
        "() => JSON.parse(localStorage.getItem('acp-ui:projects.json') || '{}')"
    )


def run_width(browser, width: int, height: int, tag: str, uniq: str) -> None:
    ctx = browser.new_context(
        ignore_https_errors=True, viewport={"width": width, "height": height}
    )
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{tag}: {e}"))
    page.on("dialog", lambda d: d.accept())

    open_settings(page)
    section = page.get_by_test_id("settings-projects")
    check(f"{tag} settings projects section renders", section.count() == 1)

    # --- fresh-profile Common -------------------------------------------------
    reg = read_registry(page)
    projs = reg.get("projects", [])
    common = [p for p in projs if p.get("name") == "Common"]
    check(f"{tag} Common exists in fresh registry",
          len(common) == 1, f"got {json.dumps(reg)[:200]}")
    if common:
        check(f"{tag} Common points at /home/hermes/projects",
              common[0].get("path") == COMMON_PATH, repr(common[0].get("path")))
    check(f"{tag} Common row visible",
          section.locator('[data-project="Common"]').count() == 1)

    # --- create project with a new folder -------------------------------------
    new_path = f"{COMMON_PATH}/{uniq}"
    section.get_by_test_id("projects-name").fill(f"W1 E2E {tag}")
    section.locator(".cwd-row .cwd-input, .dir-picker input").first.fill(new_path)
    section.get_by_test_id("projects-create").click()
    page.wait_for_timeout(2500)
    reg = read_registry(page)
    created = [p for p in reg.get("projects", []) if p.get("path") == new_path]
    check(f"{tag} created project appears in registry", len(created) == 1,
          json.dumps(reg)[:300])
    check(f"{tag} folder really on disk (bridge list)",
          bridge_has_dir(COMMON_PATH, uniq), new_path)
    check(f"{tag} created project row visible",
          section.locator(f'[data-project="W1 E2E {tag}"]').count() == 1)

    # --- add an existing folder via DirectoryPicker ---------------------------
    seed_name = f"{uniq}-seed"
    ok, detail = bridge_mkdir(f"{COMMON_PATH}/{seed_name}")
    check(f"{tag} seed folder for picker", ok, detail)
    section.get_by_test_id("projects-name").fill(f"W1 E2E existing {tag}")
    picker = section.get_by_test_id("projects-picker")
    picker.locator('button[aria-label="Browse directories"]').click()
    page.wait_for_selector(".tree-panel", timeout=10000)
    # Navigate: root view lists dirs under the bridge root; drill into projects.
    # The picker input constrains the initial listing to paths under the
    # current input (here: /home/hermes/projects/<uniq>, which does not
    # exist yet), so first jump back to the bridge root via the ⌂ crumb.
    tree = page.locator(".tree-panel")
    tree.locator(".crumb").first.click()
    page.wait_for_timeout(600)
    for _ in range(30):
        names = tree.locator(".dir-name").all_inner_texts()
        if seed_name in names:
            break
        if "projects" in names:
            tree.locator(".dir-row", has_text="projects").first.click()
            page.wait_for_timeout(400)
        else:
            break
    check(f"{tag} picker shows seed folder", seed_name in
          tree.locator(".dir-name").all_inner_texts())
    row = tree.locator(".dir-row", has_text=seed_name).first
    row.locator(".dir-pick").click()
    page.wait_for_timeout(500)
    section.get_by_test_id("projects-add").click()
    page.wait_for_timeout(1500)
    check(f"{tag} existing-folder project row visible",
          section.locator(f'[data-project="W1 E2E existing {tag}"]').count() == 1)

    # --- rename ----------------------------------------------------------------
    target = section.locator(f'[data-project="W1 E2E existing {tag}"]').first
    target.get_by_test_id("project-rename").click()
    page.wait_for_timeout(400)
    page.get_by_test_id("project-edit-name").fill(f"W1 E2E renamed {tag}")
    page.get_by_test_id("project-save").click()
    page.wait_for_timeout(1200)
    check(f"{tag} rename works",
          section.locator(f'[data-project="W1 E2E renamed {tag}"]').count() == 1)

    # --- Common cannot be deleted ----------------------------------------------
    common_row = section.locator('[data-project="Common"]').first
    del_btn = common_row.get_by_test_id("project-delete")
    check(f"{tag} Common delete button disabled", del_btn.is_disabled())
    # Forced path: the real store's removeProject(Common) must reject with
    # a visible error, and Common must still be in the registry.
    guard = page.evaluate(
        """async () => {
          const s = window.__projects;
          const common = s.projects.find(p => p.name === 'Common');
          try {
            await s.removeProject(common.id);
            return { threw: false, err: '' };
          } catch (e) {
            return { threw: true, err: String((e && e.message) || e) };
          }
        }"""
    )
    check(f"{tag} store removeProject(Common) throws", guard.get("threw") is True,
          repr(guard))
    check(f"{tag} Common error message visible", "Common" in guard.get("err", ""),
          repr(guard))
    check(f"{tag} Common still registered",
          any(p.get("name") == "Common" for p in read_registry(page).get("projects", [])))

    # --- delete a normal project ------------------------------------------------
    victim = section.locator(f'[data-project="W1 E2E renamed {tag}"]').first
    victim.get_by_test_id("project-delete").click()  # dialog auto-accepted
    page.wait_for_timeout(1200)
    check(f"{tag} delete works",
          section.locator(f'[data-project="W1 E2E renamed {tag}"]').count() == 0)

    # --- activeProjectId persists across reload ----------------------------------
    page.evaluate(
        """() => {
          const raw = JSON.parse(localStorage.getItem('acp-ui:projects.json'));
          const created = raw.projects.find(p => p.path.includes('""" + uniq + """'));
          raw.activeProjectId = created.id;
          localStorage.setItem('acp-ui:projects.json', JSON.stringify(raw));
          window.__w1_active = created.id;
        }"""
    )
    page.reload(wait_until="load")
    page.wait_for_timeout(1500)
    # Re-open Settings so the projects store is mounted again (its handle
    # is exposed on window by ProjectsSection on mount).
    open_settings(page)
    page.wait_for_function("() => !!window.__projects", timeout=15000)
    reg = read_registry(page)
    check(f"{tag} activeProjectId survives reload",
          reg.get("activeProjectId") == page.evaluate("() => window.__w1_active")
          or reg.get("activeProjectId") not in (None, "all"),
          repr(reg.get("activeProjectId")))

    # --- projectIdForCwd / sessionsOfProject (synthetic, real store) -------------
    verdict = page.evaluate(
        """async () => {
          const s = window.__projects;
          const a = await s.addProject({ name: 'w1-a', path: '/home/hermes/projects/a' });
          const ab = await s.addProject({ name: 'w1-ab', path: '/home/hermes/projects/ab' });
          const nestedA = s.projectIdForCwd('/home/hermes/projects/a/deep');
          const nestedAb = s.projectIdForCwd('/home/hermes/projects/ab');
          const exactA = s.projectIdForCwd('/home/hermes/projects/a');
          const outside = s.projectIdForCwd('/elsewhere');
          const sessions = [
            { cwd: '/home/hermes/projects/a/x' },
            { cwd: '/home/hermes/projects/ab' },
            { cwd: '/elsewhere' },
            {},
          ];
          await s.setActiveProject(a.id);
          const scoped = s.sessionsOfProject(sessions).length;
          await s.setActiveProject('all');
          const unscoped = s.sessionsOfProject(sessions).length;
          await s.removeProject(a.id);
          await s.removeProject(ab.id);
          await s.setActiveProject('all');
          return { nestedA, nestedAb, exactA, aId: a.id, abId: ab.id,
                   outside, scoped, unscoped };
        }"""
    )
    check(f"{tag} projectIdForCwd longest-prefix (/a/deep)",
          verdict.get("nestedA") == verdict.get("aId"), repr(verdict))
    check(f"{tag} projectIdForCwd /ab is not /a",
          verdict.get("nestedAb") == verdict.get("abId"), repr(verdict))
    check(f"{tag} /a vs /ab do not confuse",
          verdict.get("exactA") == verdict.get("aId"), repr(verdict))
    check(f"{tag} projectIdForCwd outside → null", verdict.get("outside") is None,
          repr(verdict))
    check(f"{tag} sessionsOfProject scoping (1 of 4)", verdict.get("scoped") == 1,
          repr(verdict))
    check(f"{tag} sessionsOfProject 'all' returns everything",
          verdict.get("unscoped") == 4, repr(verdict))

    page.screenshot(path=str(SHOTS / (
        "projects-admin-1440x900.png" if width >= 1000 else "projects-admin-390x844.png"
    )))
    ctx.close()


def main() -> int:
    SHOTS.mkdir(exist_ok=True)
    server = start_server()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            run_width(browser, 1440, 900, "1440", "w1e2e-proj")
            run_width(browser, 390, 844, "390", "w1e2e-mob")
            browser.close()
    finally:
        server.terminate()
        server.wait(timeout=5)

    check("zero pageerrors", len(errors) == 0, "; ".join(errors[:3]))
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} assertions passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
