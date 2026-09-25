#!/usr/bin/env python3
"""Filter the rule files by the features a machine actually has.

Two marker forms, neither of which Claude Code ever sees:

  frontmatter, gating a whole file
      ---
      needs: argent
      ---
  Claude Code reads only `paths` from a rule, ignores any other field without
  an error, and removes the frontmatter before loading the rule.

  HTML comments, gating a block
      <!-- needs: gpt-6-astra -->
      ...
      <!-- /needs -->
  Block-level HTML comments are stripped before the content enters context, so
  the markers cost nothing even when nothing is filtered.

A block or file is kept when every feature it names is present.

Used by deploy.sh. Also runnable:
    python3 tools/build-rules.py --features opus-5.5,sonnet-5,reviewer,runner \
        --src rules --out /tmp/rules
    python3 tools/build-rules.py --vocabulary
"""
import argparse, pathlib, re, sys

MODELS = ["gpt-5.6-sol", "sonnet-5", "opus-5.5", "gpt-6-astra", "fable-5"]
TOOLS = ["codex", "argent", "gh-stack"]
AGENTS = ["researcher", "runner", "ui-runner", "opus-implementer",
          "sol-implementer", "astra-implementer", "astra-reviewer", "reviewer"]
VOCABULARY = set(MODELS) | set(TOOLS) | set(AGENTS)

# A model that exists only behind another tool.
MODEL_REQUIRES = {"gpt-5.6-sol": "codex", "gpt-6-astra": "codex"}

OPEN = re.compile(r"^<!--\s*needs:\s*(.+?)\s*-->\s*$")
CLOSE = re.compile(r"^<!--\s*/needs\s*-->\s*$")
FRONT = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def split_frontmatter(text):
    m = FRONT.match(text)
    if not m:
        return set(), text
    needs = set()
    for line in m.group(1).splitlines():
        if line.strip().startswith("needs:"):
            needs = parse_needs(line.split(":", 1)[1])
    return needs, text


def parse_needs(raw):
    return {p.strip() for p in raw.split(",") if p.strip()}


def render(text, features):
    """Drop blocks whose features are absent. Remove every marker line."""
    out, stack = [], []
    for line in text.splitlines(keepends=True):
        m = OPEN.match(line.rstrip("\n"))
        if m:
            stack.append(parse_needs(m.group(1)) <= features)
            continue
        if CLOSE.match(line.rstrip("\n")):
            if not stack:
                raise ValueError("closing marker without an opening one")
            stack.pop()
            continue
        if all(stack):
            out.append(line)
    if stack:
        raise ValueError("unclosed block marker")
    # Collapse the blank runs a dropped block leaves behind.
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).rstrip() + "\n"


def wanted(text, features):
    needs, _ = split_frontmatter(text)
    return needs <= features


def used_features(text):
    found = set()
    needs, _ = split_frontmatter(text)
    found |= needs
    for line in text.splitlines():
        m = OPEN.match(line.strip())
        if m:
            found |= parse_needs(m.group(1))
    return found


def features_for(models=None, codex=True, argent=True, gh_stack=True, agents=None):
    """Turn deploy's flags into the feature set the markers are matched against."""
    tools = {t for t, on in
             (("codex", codex), ("argent", argent), ("gh-stack", gh_stack)) if on}
    chosen = set(models if models is not None else MODELS)
    # A model whose tool is absent cannot be used, whatever was asked for.
    chosen = {m for m in chosen
              if MODEL_REQUIRES.get(m) is None or MODEL_REQUIRES[m] in tools}
    return chosen | tools | set(agents if agents is not None else AGENTS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="rules")
    ap.add_argument("--out")
    ap.add_argument("--features", default="")
    ap.add_argument("--vocabulary", action="store_true")
    a = ap.parse_args()

    src = pathlib.Path(a.src)
    if a.vocabulary:
        print(" ".join(sorted(VOCABULARY)))
        return 0

    features = parse_needs(a.features)
    # A model that only exists behind a tool goes when the tool goes. Applied
    # here so every caller gets it, not only deploy.sh.
    for model, tool in MODEL_REQUIRES.items():
        if tool not in features:
            features.discard(model)
    unknown = features - VOCABULARY
    if unknown:
        print(f"unknown feature(s): {', '.join(sorted(unknown))}", file=sys.stderr)
        return 1

    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    skipped = []
    for f in sorted(src.glob("*.md")):
        text = f.read_text()
        if not wanted(text, features):
            skipped.append(f.name)
            continue
        dest = out / f.name
        # A previous unfiltered deploy leaves a symlink into the repo here.
        # Writing through it would overwrite the source. Replace it instead.
        if dest.is_symlink() or dest.exists():
            dest.unlink()
        dest.write_text(render(text, features))
    if skipped:
        print(f"rules    not written: {', '.join(skipped)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
