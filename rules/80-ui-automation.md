---
needs: argent
---

## UI automation

This section applies only where the argent MCP server is available. Ignore it
otherwise; `ui-runner` is not deployed without argent.

All `mcp__argent__*` work goes to `ui-runner`, never in-thread. A view hierarchy is
30–55k tokens and a screenshot more; held in your context it is re-read by every
later turn of the session. Measured in that same corpus: argent results cost $0.64
a call against Bash's $0.0096 — 70x. One twelve-minute in-thread run cost ~$59.

Inside `ui-runner`, and anywhere else: prefer `await-ui-element` assertions over
`describe`-then-read. An assertion answers the question exactly; a hierarchy answers
it by handing you the whole tree.
