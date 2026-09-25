#!/usr/bin/env python3
"""Smoke test for tools/apply-policy.py.

Run it before you trust a deploy against a config you care about:

    python3 tools/test-apply-policy.py

It writes only to a temporary directory. It never touches ~/.claude.

What it proves:
  1. A hook event this repo does not assert survives the merge.
  2. Local keys -- model, permissions -- survive the merge.
  3. The keys this repo does assert are applied.
  4. A second run changes nothing.
  5. An absent config file is created from the policy alone.
"""
import importlib.util, json, pathlib, tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
POLICY = REPO / "settings.policy.json"

spec = importlib.util.spec_from_file_location("ap", REPO / "tools/apply-policy.py")
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)

tmp = pathlib.Path(tempfile.mkdtemp(prefix="agent-config-test-"))
target = tmp / "settings.json"

# A teammate's config: their own PreToolUse hook, a stale SessionStart hook,
# their model choice, their permissions, and a tui value we will overwrite.
live = {
    "model": "sonnet",
    "permissions": {"allow": ["mcp__argent"]},
    "tui": "compact",
    "hooks": {
        "PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo mine"}]}
        ],
        "SessionStart": [
            {"hooks": [{"type": "command", "command": "echo stale"}]}
        ],
    },
}
target.write_text(json.dumps(live, indent=2))

changed, kept = ap.apply_json(POLICY, target, tmp / "backup")
out = json.loads(target.read_text())

assert "PreToolUse" in out["hooks"], "FOREIGN HOOK LOST"
assert out["hooks"]["PreToolUse"] == live["hooks"]["PreToolUse"], "FOREIGN HOOK ALTERED"
assert out["hooks"]["SessionStart"] != live["hooks"]["SessionStart"], "SessionStart not applied"
assert "PreCompact" in out["hooks"], "PreCompact not added"
assert out["model"] == "sonnet", "local model lost"
assert out["permissions"] == live["permissions"], "local permissions lost"
assert out["tui"] == "fullscreen", "tui not applied"
assert (tmp / "backup" / "settings.json").exists(), "no backup written"
assert "hooks.PreToolUse" in kept, "foreign hook not reported as kept"

print(f"1-3 ok   changed: {', '.join(changed)}")
print(f"         kept:    {', '.join(kept)}")

changed2, _ = ap.apply_json(POLICY, target, tmp / "backup2")
assert changed2 == [], f"second run not idempotent: {changed2}"
print("4   ok   second run changed nothing")

fresh = tmp / "fresh.json"
c3, k3 = ap.apply_json(POLICY, fresh, tmp / "backup3")
assert sorted(c3) == sorted(json.loads(POLICY.read_text())), c3
assert k3 == [], k3
print("5   ok   absent config created from policy")

print("PASS")
