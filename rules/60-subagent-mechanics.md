## Subagent mechanics

- Claude models run via the Agent/Workflow model parameter with `effort` per
  delegation. opus-5.x: thinking on by default; `thinking: disabled` with xhigh/max
  → 400; `max_tokens` caps thinking plus response.
<!-- needs: codex -->
- OpenAI models run only through the Codex CLI (`codex exec` / `codex review`).
  `~/.codex/config.toml` sets its own default model, and it is not sol. Always
  pass `-m` explicitly: `-m gpt-5.6-sol`, or `-m gpt-6-astra --reasoning-effort
  high|xhigh|max` for Astra. Never rely on the config default. Read-only work:
  `codex exec -s read-only` with a self-contained prompt.
<!-- /needs -->
<!-- needs: gpt-6-astra -->
- Astra needs Codex CLI ≥ 0.153.1; `codex models` confirms access. Astra wrappers
  never run below high.
<!-- /needs -->
<!-- needs: gpt-6-astra -->
- ⚠ Astra: `approval_policy = "on-request"`, set globally in `~/.codex/config.toml`.
  Never `--full-auto`, never
  `approval_policy = "never"`. Reviews `-s read-only`. Log tool results with a
  `post_tool_use` hook.
<!-- /needs -->
<!-- needs: codex -->
- OpenAI models in workflows need a wrapper: thin Claude agent, `model: 'sonnet',
  effort: 'low'`, writes a self-contained Codex prompt, runs it via Bash, returns a
  `schema` report. Label with the engine prefix — `gpt-5.6:` or `gpt-6:`, e.g.
  `{label: 'gpt-6:astra-impl-sync-engine'}` — the UI shows only the wrapper's model.
<!-- /needs -->
<!-- needs: codex -->
- Codex runs exceed Bash's 10-minute timeout: explicit timeout, or background and
  poll for the report file. Astra at xhigh/max: background-and-poll by default.
<!-- /needs -->
<!-- needs: codex -->
- Parallel Codex implementers use `isolation: 'worktree'`.
<!-- /needs -->
<!-- needs: codex -->
- Workflow budgets count Claude tokens only. Sol is free; track Astra spend via
  Codex thread metadata (`model` / `reasoningEffort`) until the plan allowance is
  confirmed.
<!-- /needs -->
