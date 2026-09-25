## Context discipline

Everything read stays in context and is paid for again on every later turn of the
session. Measured over eight weeks of one operator's own sessions: 86% of spend
is context re-read, 14% is generation — 257 tokens read for every one written.
Your own ratio will differ. Its direction will not. Before pulling something in,
ask whether you need all of it.

- Read ranges, not whole files. Use `Read` with `offset`/`limit`, or `sed -n '120,180p'`.
  Reserve whole-file reads for files under ~200 lines.
- Never re-read a file already in this session's context. Scroll back instead.
- `.claude/ledger.md` is injected at SessionStart. Do not `cat` it.
- Narrow output at the source — `grep -n`, `head`, `--name-only` — rather than reading
  everything and filtering afterwards.

## Editing files

- Use `Edit` to change a file. Do not write a `python3 - <<PY` or `node -e` script to
  perform a string replacement: it costs more, fails opaquely, and returns stdout
  instead of a diff.
- A script is the right tool only for a mechanical change across many files at once.
  For one file, or a handful, use `Edit`.
- Append to `.claude/ledger.md` with `Edit`, not `cat >>` with a heredoc. Never rewrite
  the whole ledger to change part of it.
