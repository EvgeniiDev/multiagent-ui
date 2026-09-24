"""E2E: view rail + Projects view derived from real agent sessions."""
import time
from playwright.sync_api import sync_playwright

URL = "http://192.168.1.222:25808/"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 900}).new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector(".session-list", timeout=20000)

    # Wait for the agent inventory (boots the Projects data with it).
    deadline = time.time() + 60
    while time.time() < deadline and not page.query_selector(".session-row"):
        page.wait_for_timeout(400)
    print("sessions in sidebar:", len(page.query_selector_all(".session-row")))

    print("rail buttons:", page.eval_on_selector_all(".rail-btn", "els => els.map(e => e.getAttribute('aria-label'))"))

    # Projects
    page.click('.rail-btn[aria-label="Projects"]')
    page.wait_for_timeout(800)
    rows = page.eval_on_selector_all(".project-row", "els => els.map(e => e.textContent.replace(/\\s+/g,' ').trim())")
    print("PROJECT ROWS:", len(rows))
    for r in rows[:8]:
        print("   ", r)
    assert rows, "no project rows"
    # Click the project that actually has sessions in its tree (Common = ~/projects),
    # not just the first row: an empty sandbox project legitimately shows 0 sessions.
    page.click('.project-row:has-text("Common")')
    page.wait_for_timeout(500)
    detail = page.evaluate("""() => ({
      name: document.querySelector('.project-detail h3')?.textContent,
      path: document.querySelector('.detail-path')?.textContent,
      metrics: [...document.querySelectorAll('.metric')].map(m => m.textContent.replace(/\\s+/g,' ').trim()),
      sessions: document.querySelectorAll('.detail-session').length,
      action: document.querySelector('.action')?.textContent,
    })""")
    print("PROJECT DETAIL:", detail)
    assert detail["sessions"] > 0, detail
    page.screenshot(path="/tmp/cc_projects.png")

    # Keyboard: bare digits switch views, but never while typing in a field
    page.click('.rail-btn[aria-label="Projects"]')
    page.wait_for_timeout(300)
    page.click(".search")
    page.type(".search", "3")
    page.wait_for_timeout(300)
    print("view while typing '3' in search:", page.evaluate("() => document.querySelector('.rail-btn.active').getAttribute('aria-label')"))
    assert page.evaluate("() => document.querySelector('.rail-btn.active').getAttribute('aria-label')") == "Projects"
    page.fill(".search", "")
    page.click(".pane-head")
    page.keyboard.press("3")
    page.wait_for_timeout(400)
    print("view after pressing '3':", page.evaluate("() => document.querySelector('.rail-btn.active').getAttribute('aria-label')"))
    assert page.evaluate("() => document.querySelector('.rail-btn.active').getAttribute('aria-label')") == "Board"
    page.keyboard.press("1")
    page.wait_for_timeout(300)
    print("view after pressing '1':", page.evaluate("() => document.querySelector('.rail-btn.active').getAttribute('aria-label')"))

    # Board / Dashboard placeholders still render (their workstreams own them)
    page.click('.rail-btn[aria-label="Board"]')
    page.wait_for_timeout(400)
    print("BOARD PANE:", page.inner_text(".view-pane").replace("\n", " ")[:80])
    page.click('.rail-btn[aria-label="Dashboard"]')
    page.wait_for_timeout(400)
    print("DASH PANE:", page.inner_text(".view-pane").replace("\n", " ")[:80])

    # Phone viewport: rail becomes a horizontal bar, and it must still switch views
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(600)
    rail = page.evaluate("""() => { const r = document.querySelector('.view-rail').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; }""")
    print("PHONE RAIL:", rail)
    page.click('.rail-btn[aria-label="Projects"]')
    page.wait_for_timeout(600)
    print("phone projects rows:", len(page.query_selector_all(".project-row")))
    print("horizontal scroll:", page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth"))
    page.screenshot(path="/tmp/cc_projects_phone.png")

    print("PAGE ERRORS:", errors[:3])
    b.close()
    print("PROJECTS E2E OK")
