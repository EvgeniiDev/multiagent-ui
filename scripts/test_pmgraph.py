#!/usr/bin/env python3
"""Unit tests for scripts/pmgraph — the deterministic half of the pm role.

Covers the pure core only (no HTTP): mechanical findings, plan validation,
the atomicity-relevant safety rails (unsafe ops / unknown refs / cycle
creation are rejected wholesale), mirror repair and the derived blocked
flags incl. the pm-ownership rule that keeps foreign reasons untouched.

    python3 scripts/test_pmgraph.py        # or ~/.hermes/tools-venv/bin/python
"""
import importlib.util
import sys
import unittest
from pathlib import Path

PMGRAPH = Path(__file__).resolve().parent / "pmgraph"
spec = importlib.util.spec_from_loader("pmgraph", loader=None)
pm = importlib.util.module_from_spec(spec)
loader = importlib.machinery.SourceFileLoader("pmgraph", str(PMGRAPH))
spec.loader = loader
spec.loader.exec_module(pm)


def card(cid, **kw):
    c = {
        "id": cid, "title": cid, "description": "d", "project": "p",
        "agent": "", "priority": "medium", "acceptance": "", "verification": "",
        "links": [], "session": None, "blocked": False, "blockedReason": "",
        "cancelled": False, "touches": [], "dependsOn": [], "blocks": [],
        "conflictsWith": [], "stage": "spec", "status": "in_progress",
        "statusByStage": {}, "order": 10, "createdAt": 1, "updatedAt": 1,
    }
    c.update(kw)
    return c


def scope(cards):
    return {c["id"] for c in cards}


def classes(findings):
    return sorted(f["class"] for f in findings)


class TestScanFindings(unittest.TestCase):
    def test_touch_overlap_pairs(self):
        cards = [
            card("a", touches=["./src/auth.py", "x"]),
            card("b", touches=["src/auth.py"]),
            card("c", touches=["other.py"]),
        ]
        findings, _ = pm.analyze(cards, scope(cards))
        ov = [f for f in findings if f["class"] == "module_overlap"]
        self.assertEqual(len(ov), 1)
        self.assertEqual(ov[0]["cards"], ["a", "b"])
        self.assertEqual(ov[0]["paths"], ["src/auth.py"])

    def test_cycle_via_dependsOn_and_blocks(self):
        # a dependsOn b; c blocks a  ->  a waits b, a waits c? no:
        # c.blocks=[a] means a waits on c, so a->b and a->c — not a cycle.
        # make it real: a->b (dep), b->a (dep) is a 2-cycle.
        cards = [card("a", dependsOn=["b"]), card("b", dependsOn=["a"])]
        findings, _ = pm.analyze(cards, scope(cards))
        cyc = [f for f in findings if f["class"] == "cycle"]
        self.assertEqual(len(cyc), 1)
        self.assertEqual(cyc[0]["cards"], ["a", "b"])

    def test_cycle_via_blocks_edge(self):
        # a.blocks=[b] (b waits a) and b.blocks=[a] (a waits b) — a cycle
        # stated entirely through `blocks`.
        cards = [card("a", blocks=["b"]), card("b", blocks=["a"])]
        findings, _ = pm.analyze(cards, scope(cards))
        self.assertIn("cycle", classes(findings))

    def test_self_loop_is_a_cycle(self):
        cards = [card("a", dependsOn=["a"])]
        findings, _ = pm.analyze(cards, scope(cards))
        self.assertIn("cycle", classes(findings))

    def test_three_node_cycle(self):
        cards = [
            card("a", dependsOn=["b"]),
            card("b", dependsOn=["c"]),
            card("c", dependsOn=["a"]),
        ]
        findings, _ = pm.analyze(cards, scope(cards))
        cyc = [f for f in findings if f["class"] == "cycle"]
        self.assertEqual(len(cyc), 1)
        self.assertEqual(cyc[0]["cards"], ["a", "b", "c"])

    def test_dangling_and_cancelled(self):
        cards = [
            card("a", dependsOn=["ghost", "gone-card"]),
            card("gone-card", cancelled=True, stage="dev"),
        ]
        findings, _ = pm.analyze(cards, scope(cards))
        cls = classes(findings)
        self.assertIn("dangling_edge", cls)
        self.assertIn("dep_on_cancelled", cls)

    def test_implied_blocked(self):
        cards = [
            card("a", dependsOn=["b"]),
            card("b", stage="dev"),
            card("c", dependsOn=["d"]),
            card("d", stage="done", status=None),
        ]
        _, implied = pm.analyze(cards, scope(cards))
        self.assertEqual(implied, {"a": ["b"]})  # done dep does not block

    def test_clean_card_has_no_findings(self):
        cards = [card("a", dependsOn=["b"]), card("b", stage="done", status=None, blocks=["a"])]
        findings, _ = pm.analyze(cards, scope(cards))
        self.assertEqual(findings, [])


class TestValidatePlan(unittest.TestCase):
    def setUp(self):
        self.cards = [
            card("a"), card("b"), card("c"),
            card("out", project="other"),
        ]
        self.scope = {"a", "b", "c"}

    def plan(self, actions=(), findings=(), proposals=()):
        return {"actions": list(actions), "findings": list(findings),
                "proposals": list(proposals)}

    def test_good_plan_ok(self):
        ops, errors = pm.validate_plan(self.cards, self.plan(
            actions=[{"op": "link", "field": "dependsOn", "from": "a", "to": "b"}]),
            self.scope)
        self.assertEqual(errors, [])
        self.assertEqual(ops, [("link", "dependsOn", "a", "b")])

    def test_substance_op_rejected(self):
        for op in ("move", "delete", "rewrite", "merge", "set", "block"):
            _, errors = pm.validate_plan(self.cards, self.plan(
                actions=[{"op": op, "from": "a", "to": "b"}]), self.scope)
            self.assertTrue(errors, f"op {op} must be rejected")

    def test_non_graph_field_rejected(self):
        _, errors = pm.validate_plan(self.cards, self.plan(
            actions=[{"op": "link", "field": "title", "from": "a", "to": "b"}]),
            self.scope)
        self.assertTrue(errors)

    def test_self_link_rejected(self):
        _, errors = pm.validate_plan(self.cards, self.plan(
            actions=[{"op": "link", "field": "dependsOn", "from": "a", "to": "a"}]),
            self.scope)
        self.assertTrue(errors)

    def test_out_of_scope_rejected(self):
        _, errors = pm.validate_plan(self.cards, self.plan(
            actions=[{"op": "link", "field": "dependsOn", "from": "a", "to": "out"}]),
            self.scope)
        self.assertTrue(errors)

    def test_unknown_ref_rejected(self):
        _, errors = pm.validate_plan(self.cards, self.plan(
            actions=[{"op": "link", "field": "dependsOn", "from": "a", "to": "zzz"}]),
            self.scope)
        self.assertTrue(errors)

    def test_finding_refs_must_exist(self):
        _, errors = pm.validate_plan(self.cards, self.plan(
            findings=[{"class": "duplicate", "cards": ["a", "zzz"], "summary": "x"}]),
            self.scope)
        self.assertTrue(errors)

    def test_cycle_creating_link_rejected(self):
        # b already depends on a; a plan adding a -> b closes the loop.
        cards = [card("a"), card("b", dependsOn=["a"])]
        _, errors = pm.validate_plan(cards, self.plan(
            actions=[{"op": "link", "field": "dependsOn", "from": "a", "to": "b"}]),
            {"a", "b"})
        self.assertTrue(errors and "cycle" in errors[0])

    def test_link_that_closes_no_cycle_ok(self):
        cards = [card("a"), card("b"), card("c", dependsOn=["b"])]
        ops, errors = pm.validate_plan(cards, self.plan(
            actions=[{"op": "link", "field": "dependsOn", "from": "a", "to": "b"}]),
            {"a", "b", "c"})
        self.assertEqual(errors, [])

    def test_id_prefixes_resolve(self):
        ops, errors = pm.validate_plan(
            [card("abcdef-1234"), card("fedcba-9876")],
            self.plan(actions=[{"op": "link", "field": "blocks",
                                "from": "abcdef", "to": "fedcba"}]),
            {"abcdef-1234", "fedcba-9876"})
        self.assertEqual(errors, [])
        self.assertEqual(ops, [("link", "blocks", "abcdef-1234", "fedcba-9876")])


class TestComputeNewCards(unittest.TestCase):
    def setUp(self):
        self.cards = [card("a"), card("b"), card("c")]
        self.scope = {"a", "b", "c"}

    def compute(self, cards, ops):
        return pm.compute_new_cards(cards, ops, {c["id"] for c in cards})

    def test_link_adds_mirror_and_block_flag(self):
        new, applied = self.compute(
            self.cards, [("link", "dependsOn", "a", "b")])
        a = next(c for c in new if c["id"] == "a")
        b = next(c for c in new if c["id"] == "b")
        self.assertEqual(a["dependsOn"], ["b"])
        self.assertEqual(b["blocks"], ["a"])             # mirror repaired
        self.assertTrue(a["blocked"])                    # b is unfinished
        self.assertTrue(a["blockedReason"].startswith("pm: blocked by"))
        self.assertFalse(b["blocked"])

    def test_dep_on_done_does_not_block(self):
        cards = [card("a"), card("b", stage="done", status=None)]
        new, _ = pm.compute_new_cards(
            cards, [("link", "dependsOn", "a", "b")], {"a", "b"})
        a = next(c for c in new if c["id"] == "a")
        self.assertFalse(a["blocked"])

    def test_foreign_reason_untouched(self):
        cards = [card("a", blocked=True, blockedReason="human: hold"),
                 card("b")]
        new, _ = pm.compute_new_cards(
            cards, [("link", "dependsOn", "a", "b")], {"a", "b"})
        a = next(c for c in new if c["id"] == "a")
        self.assertEqual(a["blockedReason"], "human: hold")

    def test_stale_pm_mark_cleared(self):
        cards = [card("a", blocked=True, blockedReason="pm: blocked by deadbeef")]
        new, applied = pm.compute_new_cards(cards, [], {"a"})
        a = new[0]
        self.assertFalse(a["blocked"])
        self.assertEqual(a["blockedReason"], "")
        self.assertTrue(any(x["change"] == "unblocked" for x in applied))

    def test_pm_mark_updated_when_deps_change(self):
        cards = [
            card("a", dependsOn=["b"], blocked=True,
                 blockedReason="pm: blocked by b"),
            card("b"), card("c"),
        ]
        new, _ = pm.compute_new_cards(
            cards, [("link", "dependsOn", "a", "c")], {"a", "b", "c"})
        a = next(c for c in new if c["id"] == "a")
        self.assertIn("c"[:8], a["blockedReason"])
        self.assertIn("b"[:8], a["blockedReason"])

    def test_conflicts_with_is_symmetric(self):
        new, _ = self.compute(
            self.cards, [("link", "conflictsWith", "a", "b")])
        a = next(c for c in new if c["id"] == "a")
        b = next(c for c in new if c["id"] == "b")
        self.assertEqual(a["conflictsWith"], ["b"])
        self.assertEqual(b["conflictsWith"], ["a"])

    def test_unlink_removes_the_fact_everywhere(self):
        # dependsOn/blocks are one fact on two cards: unlinking clears both
        # representations, or the mirror repair would re-add the other half.
        cards = [card("a", dependsOn=["b"]), card("b", blocks=["a"])]
        new, _ = pm.compute_new_cards(
            cards, [("unlink", "dependsOn", "a", "b")], {"a", "b"})
        a = next(c for c in new if c["id"] == "a")
        b = next(c for c in new if c["id"] == "b")
        self.assertEqual(a["dependsOn"], [])
        self.assertEqual(b["blocks"], [])

    def test_unlink_clears_the_blocked_flag_too(self):
        cards = [card("a", dependsOn=["b"], blocked=True,
                      blockedReason="pm: blocked by b"),
                 card("b", blocks=["a"])]
        new, _ = pm.compute_new_cards(
            cards, [("unlink", "dependsOn", "a", "b")], {"a", "b"})
        a = next(c for c in new if c["id"] == "a")
        self.assertFalse(a["blocked"])
        self.assertEqual(a["blockedReason"], "")

    def test_unlink_conflicts_clears_both_sides(self):
        cards = [card("a", conflictsWith=["b"]), card("b", conflictsWith=["a"])]
        new, _ = pm.compute_new_cards(
            cards, [("unlink", "conflictsWith", "a", "b")], {"a", "b"})
        self.assertEqual(new[0]["conflictsWith"], [])
        self.assertEqual(new[1]["conflictsWith"], [])

    def test_done_card_not_blocked(self):
        cards = [card("a", stage="done", status=None), card("b")]
        new, _ = pm.compute_new_cards(
            cards, [("link", "dependsOn", "a", "b")], {"a", "b"})
        a = next(c for c in new if c["id"] == "a")
        self.assertFalse(a["blocked"])

    def test_only_touched_cards_get_updatedAt(self):
        cards = [card("a"), card("b"), card("c")]
        new, applied = pm.compute_new_cards(
            cards, [("link", "dependsOn", "a", "b")], {"a", "b", "c"})
        c = next(x for x in new if x["id"] == "c")
        self.assertEqual(c["updatedAt"], 1)

    def test_idempotent_second_run(self):
        new1, applied1 = self.compute(
            self.cards, [("link", "dependsOn", "a", "b")])
        self.assertTrue(applied1)
        new2, applied2 = pm.compute_new_cards(new1, [], {"a", "b", "c"})
        self.assertEqual(applied2, [])
        self.assertEqual(new1, new2)

    def test_out_of_scope_card_never_written(self):
        cards = [card("a"), card("b", project="other")]
        new, _ = pm.compute_new_cards(cards, [], {"a"})
        self.assertEqual(new[1], cards[1])


class TestHelpers(unittest.TestCase):
    def test_norm_touch(self):
        self.assertEqual(pm.norm_touch("./src//a.py/"), "src/a.py")
        self.assertEqual(pm.norm_touch("  x.py  "), "x.py")

    def test_resolve_prefix(self):
        cards = [card("abcdef-1"), card("abc999-2")]
        self.assertEqual(pm.resolve_ref(cards, "abcdef")["id"], "abcdef-1")
        self.assertIsNone(pm.resolve_ref(cards, "abc"))   # ambiguous
        self.assertIsNone(pm.resolve_ref(cards, "zzz"))

    def test_project_label_matching(self):
        projects = [{"id": "p1", "name": "Shop",
                     "path": "/home/hermes/projects/shop-ui"}]
        self.assertTrue(pm.project_label_matches("shop", "p1", projects))
        self.assertTrue(pm.project_label_matches("shop-ui", "p1", projects))
        self.assertTrue(pm.project_label_matches("Shop", "shop", projects))
        self.assertFalse(pm.project_label_matches("other", "p1", projects))


if __name__ == "__main__":
    unittest.main(verbosity=2)
