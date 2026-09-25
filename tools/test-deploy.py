#!/usr/bin/env python3
"""Smoke test for deploy.sh.

    python3 tools/test-deploy.py

Runs deploy.sh against a temporary HOME. It never touches your own config.
"""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
DEPLOY = REPO / "deploy.sh"
ALL_RULES = sorted(p.name for p in (REPO / "rules").glob("*.md"))
fails = []


def fresh_home(own_claude_md=False):
    home = pathlib.Path(tempfile.mkdtemp(prefix="agent-config-deploy-test-"))
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "sonnet"}, indent=2))
    if own_claude_md:
        (home / ".claude" / "CLAUDE.md").write_text("MY OWN CONTRACT\n")
    return home


def run(home, *args):
    env = dict(os.environ, HOME=str(home))
    return subprocess.run([str(DEPLOY), *args], env=env, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True)


def snapshot(root):
    out = {}
    for p in sorted(root.rglob("*")):
        rel = str(p.relative_to(root))
        if p.is_symlink():
            out[rel] = "link->" + os.readlink(p)
        elif p.is_dir():
            out[rel] = "dir"
        else:
            out[rel] = hashlib.sha256(p.read_bytes()).hexdigest()[:12]
    return out


def check(n, label, ok, detail=""):
    print(f"{str(n):3} {'ok  ' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def rules_in(home):
    d = home / ".claude" / "rules"
    return sorted(p.name for p in d.glob("*.md")) if d.exists() else []


def agents_in(home):
    d = home / ".claude" / "agents"
    return sorted(p.stem for p in d.glob("*.md")) if d.exists() else []


# 1-2 -- dry run
home = fresh_home()
before = snapshot(home)
run(home, "--dry-run")
check(1, "--dry-run changed nothing on disk", before == snapshot(home))

# 3 -- a plain deploy links every rule
r = run(home)
check(3, "deploy links every rule file",
      r.returncode == 0 and rules_in(home) == ALL_RULES, f"{rules_in(home)} {r.stderr}")
check("3b", "rules are symlinks when nothing is filtered",
      all((home / ".claude" / "rules" / n).is_symlink() for n in rules_in(home)))
check("3c", "the repo does not create a CLAUDE.md",
      not (home / ".claude" / "CLAUDE.md").exists())

# 4 -- narrowing generates instead, and drops what is not wanted
r = run(home, "--no-argent", "--models", "opus-5.5,sonnet-5")
got = rules_in(home)
check(4, "--no-argent drops the UI automation rule", "80-ui-automation.md" not in got, str(got))
check("4b", "a filtered deploy writes real files, not links",
      got and not any((home / ".claude" / "rules" / n).is_symlink() for n in got))
routing = (home / ".claude" / "rules" / "40-model-routing.md").read_text()
check("4c", "--models drops the rows not asked for",
      "fable-5" not in routing and "gpt-6-astra" not in routing and "opus-5.5" in routing)
check("4d", "no marker survives into a generated rule", "<!--" not in routing)

# 5 -- going back to a full deploy restores what was dropped
run(home)
check(5, "a later full deploy restores the dropped rule", rules_in(home) == ALL_RULES)

# 6 -- revert
r = run(home, "--revert")
check(6, "--revert removes the rules and the manifest",
      r.returncode == 0 and rules_in(home) == [] and agents_in(home) == []
      and not (home / ".claude" / ".agent-config-manifest").exists(), r.stderr)
shutil.rmtree(home)

# 7 -- a teammate's own CLAUDE.md is never touched
home = fresh_home(own_claude_md=True)
run(home)
check(7, "a CLAUDE.md of your own survives a deploy untouched",
      (home / ".claude" / "CLAUDE.md").read_text() == "MY OWN CONTRACT\n"
      and not (home / ".claude" / "CLAUDE.md").is_symlink())

# 8 -- an old deploy's CLAUDE.md symlink is retired
link = home / ".claude" / "CLAUDE.md"
link.unlink()
link.symlink_to(REPO / "CLAUDE.md")
r = run(home)
check(8, "an old CLAUDE.md symlink into this repo is retired",
      not link.exists() and "retire" in r.stdout, r.stdout[-200:])
shutil.rmtree(home)

# 9 -- agent selection still works
home = fresh_home()
r = run(home, "--agents", "runner,reviewer")
check(9, "--agents deploys only the agents named",
      r.returncode == 0 and agents_in(home) == ["reviewer", "runner"], r.stderr)
r = run(home, "--agents", "no-such-agent")
check("9b", "--agents rejects an unknown name", r.returncode != 0 and "unknown agent" in r.stderr)
r = run(home, "--models", "no-such-model")
check("9c", "--models rejects an unknown name", r.returncode != 0 and "unknown feature" in r.stderr)

# 10 -- confirm-before-replace, on a file the repo does own
own = home / ".claude" / "ledger.template.md"
own.unlink(missing_ok=True)
own.write_text("MINE\n")
r = run(home)
check(10, "refuses to replace a file of your own without a terminal",
      r.returncode != 0 and "--force" in r.stderr and own.read_text() == "MINE\n")
r = run(home, "--force")
check("10b", "--force replaces it and backs it up",
      r.returncode == 0 and own.is_symlink()
      and any(p.read_text() == "MINE\n"
              for p in (home / ".claude" / "backups").glob("deploy-*/.claude/ledger.template.md")))
shutil.rmtree(home)

# 11 -- no-codex drops both the agents and the Codex prose
home = fresh_home()
run(home, "--no-codex")
mech = (home / ".claude" / "rules" / "60-subagent-mechanics.md").read_text()
check(11, "--no-codex drops its agents and its prose",
      agents_in(home) == ["opus-implementer", "researcher", "reviewer", "runner", "ui-runner"]
      and "codex exec" not in mech and "Codex CLI" not in mech, agents_in(home))
shutil.rmtree(home)

# 13 -- a filtered deploy over a linked one must not touch the repo sources
home = fresh_home()
run(home)                      # links the rules into the temp HOME
src = {f.name: hashlib.sha256(f.read_bytes()).hexdigest()
       for f in (REPO / "rules").glob("*.md")}
run(home, "--models", "opus-5.5")   # writes filtered copies over those links
after = {f.name: hashlib.sha256(f.read_bytes()).hexdigest()
         for f in (REPO / "rules").glob("*.md")}
check(13, "a filtered deploy does not write through the symlinks into the repo",
      src == after, str([k for k in src if src[k] != after.get(k)]))
shutil.rmtree(home)

# 12 -- no rule may name a lane that was not deployed
home = fresh_home()
run(home, "--agents", "opus-implementer", "--models", "opus-5.5",
    "--no-codex", "--no-argent", "--no-stacks")
blob = "".join((home / ".claude" / "rules" / n).read_text() for n in rules_in(home))
ALL_AGENTS = ["researcher", "runner", "ui-runner", "opus-implementer",
              "sol-implementer", "astra-implementer", "astra-reviewer", "reviewer"]
# Backticked, so the ordinary English words reviewer and runner do not count.
dangling = [a for a in ALL_AGENTS if a != "opus-implementer" and chr(96) + a + chr(96) in blob]
check(12, "no rule names a lane that was not deployed", dangling == [], str(dangling))
shutil.rmtree(home)

print("PASS" if not fails else f"FAILED: {len(fails)}")
sys.exit(1 if fails else 0)
