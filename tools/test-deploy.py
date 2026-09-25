#!/usr/bin/env python3
"""Smoke test for deploy.sh.

    python3 tools/test-deploy.py

It runs deploy.sh against a temporary HOME. It never touches your own config.

What it proves:
  1. --dry-run leaves the directory tree byte-identical.
  2. Without a terminal, deploy refuses to replace a file of your own.
  3. --force replaces it, and backs the original up under its own path.
  4. --revert removes this repo's symlinks and restores that backup.
  5. --agents deploys only the agents named.
  6. --no-codex and --no-argent drop the lanes that need those tools.
"""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
DEPLOY = REPO / "deploy.sh"

fails = []


def fresh_home():
    home = pathlib.Path(tempfile.mkdtemp(prefix="agent-config-deploy-test-"))
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "CLAUDE.md").write_text("MY OWN CONTRACT\n")
    (home / ".claude" / "settings.json").write_text(json.dumps({"model": "sonnet"}, indent=2))
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
    print(f"{n} {'ok  ' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(label)


def agents_linked(home):
    d = home / ".claude" / "agents"
    return sorted(p.stem for p in d.glob("*.md")) if d.exists() else []


# 1 -- dry run writes nothing
home = fresh_home()
before = snapshot(home)
run(home, "--dry-run")
check(1, "--dry-run changed nothing on disk", before == snapshot(home))

# 2 -- no terminal, no silent replacement
r = run(home)
check(2, "refuses to replace your CLAUDE.md without a terminal",
      r.returncode != 0
      and "--force" in r.stderr
      and (home / ".claude" / "CLAUDE.md").read_text() == "MY OWN CONTRACT\n")

# 3 -- force replaces, and backs up under the relative path
r = run(home, "--force")
backups = list((home / ".claude" / "backups").glob("deploy-*/.claude/CLAUDE.md"))
check(3, "--force links, and backs the original up under .claude/CLAUDE.md",
      r.returncode == 0
      and (home / ".claude" / "CLAUDE.md").is_symlink()
      and len(backups) == 1
      and backups[0].read_text() == "MY OWN CONTRACT\n",
      r.stderr)

# 4 -- revert puts it back
r = run(home, "--revert")
check(4, "--revert unlinks and restores the original",
      r.returncode == 0
      and not (home / ".claude" / "CLAUDE.md").is_symlink()
      and (home / ".claude" / "CLAUDE.md").read_text() == "MY OWN CONTRACT\n"
      and agents_linked(home) == [],
      r.stderr)
shutil.rmtree(home)

# 5 -- agent selection
home = fresh_home()
r = run(home, "--force", "--agents", "runner,reviewer")
check(5, "--agents deploys only the agents named",
      r.returncode == 0 and agents_linked(home) == ["reviewer", "runner"],
      f"{agents_linked(home)} {r.stderr}")

r = run(home, "--agents", "no-such-agent")
check("5b", "--agents rejects an unknown name", r.returncode != 0 and "unknown agent" in r.stderr)
shutil.rmtree(home)

# 6 -- tool-gated lanes
home = fresh_home()
run(home, "--force", "--no-codex", "--no-argent")
got = agents_linked(home)
check(6, "--no-codex and --no-argent drop their lanes",
      got == ["opus-implementer", "researcher", "reviewer", "runner"], str(got))
shutil.rmtree(home)

print("PASS" if not fails else f"FAILED: {len(fails)}")
sys.exit(1 if fails else 0)
