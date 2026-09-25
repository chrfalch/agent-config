#!/usr/bin/env python3
"""Merge this repo's policy into the live config files, preserving everything else.

The repo owns a handful of keys. Local state -- Codex project trust levels,
plugins, marketplaces, mcp_servers, permissions, model choice -- is never
touched and never stored in the repo.
"""
import argparse, json, pathlib, shutil, sys, tomllib

REPO = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path.home()


def backup(path, backup_dir):
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_dir / path.name)


def merge_key(live_value, policy_value):
    """Merge one policy key into the live value already under that key.

    A dict is merged one level down, so sub-keys this repo does not assert
    survive: another hook event, for example. Anything else is replaced
    outright. Returns (merged value, changed sub-keys, kept sub-keys); a
    changed sub-key of "" means the whole key changed.
    """
    if not (isinstance(live_value, dict) and isinstance(policy_value, dict)):
        return policy_value, ([] if live_value == policy_value else [""]), []
    merged = dict(live_value)
    changed = []
    for k, v in policy_value.items():
        if merged.get(k) != v:
            changed.append(k)
        merged[k] = v
    kept = [k for k in live_value if k not in policy_value]
    return merged, changed, kept


def apply_json(policy_path, target, backup_dir):
    policy = json.loads(policy_path.read_text())
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(policy, indent=2) + "\n")
        return sorted(policy), []
    live = json.loads(target.read_text())
    merged = dict(live)
    changed, kept = [], []
    for key, value in policy.items():
        new_value, sub_changed, sub_kept = merge_key(live.get(key), value)
        merged[key] = new_value
        changed += [key if s == "" else f"{key}.{s}" for s in sub_changed]
        kept += [f"{key}.{s}" for s in sub_kept]
    kept += [k for k in live if k not in policy]
    if not changed:
        return [], sorted(kept)
    backup(target, backup_dir)
    target.write_text(json.dumps(merged, indent=2) + "\n")
    return sorted(changed), sorted(kept)


def set_toml_key(lines, key, raw_value):
    """Set a top-level key, preserving comments, ordering and every table."""
    first_table = next((i for i, l in enumerate(lines) if l.startswith("[")), len(lines))
    for i in range(first_table):
        stripped = lines[i].lstrip()
        if stripped.startswith(key) and stripped[len(key):].lstrip().startswith("="):
            if lines[i] == f"{key} = {raw_value}\n":
                return False
            lines[i] = f"{key} = {raw_value}\n"
            return True
    lines.insert(first_table, f"{key} = {raw_value}\n")
    if first_table + 1 < len(lines) and lines[first_table + 1].startswith("["):
        lines.insert(first_table + 1, "\n")
    return True


def apply_toml(policy_path, target, backup_dir):
    policy = tomllib.loads(policy_path.read_text())
    flat = {k: v for k, v in policy.items() if not isinstance(v, dict)}
    if not target.exists():
        return None, None
    lines = target.read_text().splitlines(keepends=True)
    original = list(lines)
    changed = [k for k, v in flat.items() if set_toml_key(lines, k, json.dumps(v))]
    if not changed:
        return [], len([l for l in lines if l.startswith("[")])
    new = "".join(lines)
    tomllib.loads(new)  # refuse to write a broken file
    backup(target, backup_dir)
    target.write_text(new)
    return changed, len([l for l in lines if l.startswith("[")])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup-dir", required=True)
    ap.add_argument("--no-codex", action="store_true")
    ap.add_argument("--codex", action="store_true", help="fail if Codex is absent")
    a = ap.parse_args()
    bdir = pathlib.Path(a.backup_dir)

    changed, untouched = apply_json(REPO / "settings.policy.json", HOME / ".claude/settings.json", bdir)
    print(f"claude   policy keys applied: {', '.join(changed) if changed else 'already current'}")
    if untouched:
        print(f"         left alone: {', '.join(untouched)}")

    target = HOME / ".codex/config.toml"
    if a.no_codex:
        print("codex    skipped (--no-codex)")
        return 0
    if not target.exists():
        if a.codex:
            print(f"codex    ERROR: {target} not found", file=sys.stderr)
            return 1
        print("codex    skipped (no ~/.codex/config.toml; pass --codex to require it)")
        return 0
    changed, tables = apply_toml(REPO / "codex/policy.toml", target, bdir)
    print(f"codex    policy keys applied: {', '.join(changed) if changed else 'already current'}")
    print(f"         left alone: {tables} tables of local state (projects, plugins, mcp_servers)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
