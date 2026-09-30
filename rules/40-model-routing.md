## Model routing

Rankings, higher = better. Cost is what the operator actually pays. Intelligence is how hard a
problem the model takes unsupervised. Taste covers UI/UX, code quality, API
design, copy. Rationale and benchmarks: `~/.claude/notes/model-routing-rationale.md`.

| model       | cost | intelligence | taste | note                                   |
|-------------|------|--------------|-------|----------------------------------------|
<!-- needs: gpt-6-luna -->
| gpt-6-luna  | 8    | 4            | —     | Codex plan; trivial batch only         |
<!-- /needs -->
<!-- needs: gpt-6.1-sol -->
| gpt-6.1-sol | 7    | 8            | 6     | Codex plan; injection not measured     |
<!-- /needs -->
<!-- needs: sonnet-5.5 -->
| sonnet-5.5  | 7    | 7            | 7     |                                        |
<!-- /needs -->
<!-- needs: opus-5.5 -->
| opus-5.5    | 5    | 9            | 9     | you; default for everything judged     |
<!-- /needs -->
<!-- needs: gpt-6-astra -->
| gpt-6-astra | 3    | 8            | 6     | Codex only; cost score assumes plan    |
<!-- /needs -->
<!-- needs: fable-5 -->
| fable-5     | 2    | 9            | 9     | retired from routing; manual only      |
<!-- /needs -->

Rules:
- Defaults, not limits. If cheaper output misses the bar, redo it smarter or at
  higher effort without asking. Judge the output, not the price.
- For anything that ships: intelligence > taste > cost. Cost is a tie-breaker.
- Effort: medium routine, high hard, xhigh/max difficult or taste-critical.
- **Implementation — two questions: volume or judged? if judged, taste?** The
  Fleet reference table carries each agent's effort range and its never-does list.
<!-- needs: gpt-6.1-sol -->
  - Volume (mechanical, clear-spec, free is the point: migrations, codemods, test
    scaffolding, bulk renames) → `sol-implementer`. Needs high reasoning → not
    volume.
<!-- /needs -->
  - Judged with taste (features, user-facing, API design, judgment in approach) →
    `opus-implementer`, effort stated.
<!-- needs: gpt-6-astra -->
  - Hard, crisply specified, non-taste (multi-file refactors, concurrency, tricky
    migrations, algorithmic, long many-file sessions) → `astra-implementer`. Spec
    complete, criteria mechanical. In doubt → Opus: cheaper on our plan,
    injection-hardened.
<!-- /needs -->
  - Untrusted or externally-sourced input → opus-5.5 only.
  - Ambiguous spec → nobody. Resolve it first.
<!-- needs: gpt-6.1-sol -->
- Deep investigation with a self-contained brief → `codex exec -s read-only -m
  gpt-6.1-sol` (plan-covered).
<!-- /needs -->
<!-- needs: gpt-6-luna -->
- Trivial batch work on trusted text (classify, extract, short summaries) →
  `codex exec -s read-only -m gpt-6-luna`. Never for code, review or verdicts.
<!-- /needs -->
<!-- needs: researcher -->
- Deep investigation that needs session state or iteration → `researcher`.
<!-- /needs -->
<!-- needs: argent -->
- Computer use: `ui-runner` (opus-5.5, injection robustness). Never in-thread — a view
  hierarchy in your context is re-read by every later turn.
<!-- /needs -->
<!-- needs: argent, gpt-6-astra -->
- Long end-to-end UI runs where budget matters → gpt-6-astra through the Codex CLI.
<!-- /needs -->
- ⚠ Every model here **expands scope and fills gaps** if allowed. Complete specs;
  scope review is mandatory. Never add "verify your work".
- Never use Haiku.
