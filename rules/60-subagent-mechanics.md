## Subagent mechanics

- Claude models run via the Agent/Workflow model parameter with `effort` per
  delegation. opus-5.x: thinking on by default; `thinking: disabled` with xhigh/max
  → 400; `max_tokens` caps thinking plus response.
<!-- needs: codex -->
- OpenAI models run only through the Codex CLI (`codex exec` / `codex review`).
  `~/.codex/config.toml` sets its own default model, which can be any model. Always
  pass `-m` explicitly to `codex exec`: `-m gpt-6.1-sol`, or `-m gpt-6-astra`.
  Never rely on the config default. Reasoning effort is a config override, not a
  flag: `-c model_reasoning_effort=high|xhigh|max`. `codex review` accepts
  neither `-m` nor `-s`; set its model with `-c model="gpt-6-astra"`. Read-only
  work: `codex exec -s read-only` with a self-contained prompt.
<!-- /needs -->
<!-- needs: gpt-6.1-sol -->
- Sol needs Codex CLI ≥ 0.165.0. On 0.153.4, `-m gpt-6.1-sol` fails with
  `model_not_found`. Upgrade with `brew upgrade codex`.
<!-- /needs -->
<!-- needs: gpt-6-astra -->
- Astra needs Codex CLI ≥ 0.153.1. Astra wrappers never run below high.
<!-- /needs -->
<!-- needs: gpt-6-astra -->
- ⚠ Astra: `approval_policy = "on-request"`, set globally in `~/.codex/config.toml`.
  Never `--full-auto`, never
  `approval_policy = "never"`. Reviews `-s read-only`. Log tool results with a
  `post_tool_use` hook.
<!-- /needs -->
<!-- needs: codex -->
- OpenAI models in workflows need a wrapper: thin Claude agent, `model: 'claude-haiku-5-5',
  effort: 'low'`, writes a self-contained Codex prompt, runs it via Bash, returns a
  `schema` report. Label with the engine prefix — `gpt-6.1:` for Sol, `gpt-6:` for Astra and Luna, e.g.
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
- Workflow budgets count Claude tokens only. Sol and Luna are plan-covered; track Astra spend via
  Codex thread metadata (`model` / `reasoningEffort`) until the plan allowance is
  confirmed.
<!-- /needs -->
