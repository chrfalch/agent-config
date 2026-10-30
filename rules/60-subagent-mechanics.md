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
  neither `-m` nor `-s`; set its model with `-c model="gpt-6-astra"`.
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
<!-- needs: codex, codex-runner -->
- Every Codex run goes through a wrapper agent. The orchestrator
  never runs `codex exec` or `codex review` itself, not even in the background.
  A direct run shows "0 agents" in the UI, and no agent owns it. A wrapper is a
  thin Claude agent, `model: 'claude-haiku-5-5'`, `effort: 'low'`. It writes a
  self-contained Codex prompt, runs it through Bash, and returns a `schema`
  report. The UI shows only the wrapper's model, so name the engine with a
  prefix: `gpt-6.1:` for Sol, `gpt-6:` for Astra and Luna. In an Agent call,
  start `description` with the prefix. In a workflow, use the same wrappers and
  put the prefix in `label`.
<!-- /needs -->
<!-- needs: codex, codex-runner, sol-implementer -->
  - `sol-implementer` wraps volume implementation on gpt-6.1-sol.
<!-- /needs -->
<!-- needs: codex, codex-runner, astra-implementer -->
  - `astra-implementer` wraps hard implementation on gpt-6-astra. Example
    workflow label: `{label: 'gpt-6:astra-impl-sync-engine'}`.
<!-- /needs -->
<!-- needs: codex, codex-runner, astra-reviewer -->
  - `astra-reviewer` wraps independent review on gpt-6-astra.
<!-- /needs -->
<!-- needs: codex, codex-runner -->
  - `codex-runner` wraps all read-only Codex work (`codex exec -s read-only`,
    with a self-contained prompt): investigation on gpt-6.1-sol and batch work
    on gpt-6-luna. Example description: `gpt-6.1: investigate the sync crash`.
<!-- /needs -->
<!-- needs: codex -->
- Inside a wrapper, a Codex run can exceed Bash's 10-minute foreground limit. The
  wrapper starts Codex in the background with no `timeout`, then waits
  on a done-file with Monitor. The wrapper never returns before Codex ends. Each
  wrapper agent file gives the wait steps.
<!-- /needs -->
<!-- needs: codex -->
- Parallel Codex implementers use `isolation: 'worktree'`.
<!-- /needs -->
<!-- needs: codex -->
- Workflow budgets count Claude tokens only. Sol and Luna are plan-covered; track Astra spend via
  Codex thread metadata (`model` / `reasoningEffort`) until the plan allowance is
  confirmed.
<!-- /needs -->
