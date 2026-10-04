# The fleet

Eight subagents. Each has one question it answers, one lane it stays in, and a
list of things it never does. The orchestrator routes work to them; you rarely
name one yourself.

| agent | engine | effort | answers | never does |
|---|---|---|---|---|
| `researcher` | opus-5.5 | medium | *why* — root cause, relevant code surface | fix, plan, edit |
| `runner` | sonnet-5.5 | — | *what happened* — build and test verdicts | fix beyond a trivial retry, dump raw logs |
| `ui-runner` | opus-5.5 | medium/high | *what the UI did* — device flows, assertions | fix code, paste hierarchies or screenshots |
| `opus-implementer` | opus-5.5 | medium/high/max | implement judged and taste work | architecture, review |
| `sol-implementer` | gpt-6.1-sol | routine only | implement free volume work | hard tier, untrusted input, taste work, fill spec gaps |
| `astra-implementer` | gpt-6-astra | high/xhigh/max | implement the hardest well-specified work | routine work, taste work, untrusted input, fill spec gaps |
| `reviewer` | opus-5.5 | medium | is it actually done, with red/green evidence | fix code |
| `astra-reviewer` | gpt-6-astra | high/xhigh | independent cross-lab verdict on critical work | fix code, see the Claude verdict first |

`runner` first when there are errors. `researcher` when the errors are known but
the cause is not.

The last three Codex agents are thin Claude wrappers. Their own model is cheap
because the real work happens in Codex; what matters is the Codex model behind
them.

## Models

Each agent pins a model in its frontmatter. Change that one line if your plan
does not include the model named, or if you want a lane to run cheaper.

| Agent | Model | Effort | Needs |
|---|---|---|---|
| `runner` | `claude-sonnet-5-5` | — | — |
| `researcher` | `claude-opus-5-5` | medium | — |
| `reviewer` | `claude-opus-5-5` | medium | — |
| `opus-implementer` | `claude-opus-5-5` | high | — |
| `ui-runner` | `claude-opus-5-5` | — | argent |
| `sol-implementer` | `sonnet` | low | Codex, `gpt-6.1-sol` |
| `astra-implementer` | `sonnet` | low | Codex, `gpt-6-astra` |
| `astra-reviewer` | `sonnet` | low | Codex, `gpt-6-astra` |

To drop the models you do not have from the routing and fleet tables:

```sh
bin/deploy --models opus-5.5,sonnet-5.5
```

## Routing

The rankings live in `rules/40-model-routing.md`. Higher is better. Cost is what
the operator actually pays. Intelligence is how hard a problem the model takes
unsupervised. Taste covers UI and UX, code quality, API design, and copy.

| model | cost | intelligence | taste | note |
|---|---|---|---|---|
| gpt-6-luna | 8 | 4 | — | Codex plan; trivial batch only |
| gpt-6.1-sol | 7 | 8 | 6 | Codex plan; injection not measured |
| sonnet-5.5 | 7 | 7 | 7 | |
| opus-5.5 | 5 | 9 | 9 | the orchestrator; default for anything judged |
| gpt-6-astra | 3 | 8 | 6 | Codex only; cost score assumes plan |
| fable-5 | 2 | 9 | 9 | retired from routing; manual only |

These rankings, and the cost figures beside them, come from one operator's own
eight-week corpus. Treat the ordering as a starting point and the absolute
numbers as that operator's, not yours. The reasoning is in
`notes/model-routing-rationale.md`.

### Choosing an implementer

Two questions: is the work volume or judged, and if judged, does it need taste?

- **Volume** — mechanical, clear spec, free execution is the point: migrations,
  codemods, test scaffolding, bulk renames. Use `sol-implementer`. Work that
  needs high reasoning is not volume.
- **Judged, with taste** — features, user-facing work, API design, judgment in
  approach. Use `opus-implementer`, with the effort stated.
- **Hard, crisply specified, no taste** — multi-file refactors, concurrency,
  tricky migrations, algorithmic work. Use `astra-implementer`. The spec must be
  complete and the criteria mechanical. In doubt, use Opus.
- **Untrusted or externally sourced input** — opus-5.5 only.
- **Ambiguous spec** — nobody. Resolve it first.

### Effort, not model

Raise effort on one model before switching models: low, medium, high, xhigh,
max. Medium is routine, high is hard, xhigh and max are for difficult or
taste-critical work. The Astra lane is for a shape of work, not a step up the
ladder.

### Two warnings

Every model in the fleet expands scope and fills gaps when allowed. Complete
specs, and a scope review, are how you stop it.

Never add "then verify your work" to a delegation. All fleet models self-verify,
and the instruction causes over-verification.

## The review gate

Every subagent result is reviewed against its original spec by a fresh agent,
never its author. This is mandatory, not a judgement call.

`reviewer` is the gate. On user-facing, architectural, security-relevant, or
astra-implemented work, `astra-reviewer` is added as an independent cross-check.
It reviews blind — it never sees the Claude verdict first. Where the two
disagree, you decide.

## Codex mechanics

OpenAI models run only through the Codex CLI (`codex exec` and `codex review`).

- Always pass `-m` explicitly to `codex exec`: `-m gpt-6.1-sol`, or
  `-m gpt-6-astra`. The config default is not sol, and relying on it is a bug.
- Reasoning effort is a config override, not a flag:
  `-c model_reasoning_effort=high|xhigh|max`. The `--reasoning-effort` flag is
  gone as of Codex CLI 0.153.4.
- `codex review` accepts neither `-m` nor `-s`. Set its model with
  `-c model="gpt-6-astra"`. Use `codex exec -s read-only` when the sandbox must
  be pinned.
- Read-only work runs `codex exec -s read-only` with a self-contained prompt.
- Astra needs Codex CLI 0.153.1 or later. Astra wrappers never run below high
  effort.
- Astra runs with `approval_policy = "on-request"`. Never `--full-auto`, never
  `approval_policy = "never"`.
- Codex runs can exceed the 10-minute Bash timeout. Use an explicit timeout, or
  run in the background and poll for the report file. Astra at xhigh or max runs
  in the background by default.
- Label a wrapper delegation with its engine prefix — `gpt-6.1:` for Sol,
  `gpt-6:` for Astra and Luna — because the UI shows only the wrapper's model.

## UI automation

All `mcp__argent__*` work goes to `ui-runner`, never in the main session. One
view hierarchy is 30–55k tokens and a screenshot is more; held in the
orchestrator's context it is re-read on every later turn. In the same corpus,
argent results cost $0.64 a call against Bash's $0.0096 — 70 times as much. One
twelve-minute in-thread run cost about $59.

Inside `ui-runner`, prefer `await-ui-element` assertions over describe-then-read.
An assertion answers the question. A hierarchy answers it by handing you the
whole tree.
