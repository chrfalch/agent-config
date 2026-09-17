# Model routing — rationale (not loaded into sessions)

Kept out of CLAUDE.md to save context. Update when the routing table changes.

- **opus-5** (24 Jul 2026): $5/$25, half of Fable 5. Tops the Artificial Analysis
  Intelligence and Agentic indices above Fable 5 and Sol. 1M context; effort dial
  low→max covers cheap-and-fast through frontier work on one model.
- **gpt-6-astra** (3 Sep 2026): $10/$50 list, 5x Sol, same as Fable 5. 1M context,
  effort low→max. Ties Sol on the AA Intelligence Index, behind Fable 5.1. Clear
  gains over Sol in agentic coding and computer use (1.9x faster on Mind2Web).
  Codex CLI only. Cost score 3 assumes plan-covered Codex usage; correct once spend
  is visible. System card: reduced chain-of-thought monitorability, 2/500
  supply-chain-attack runs in adversarial eval → never untrusted input, never
  without an approval gate.
- **fable-5 retired from routing**: remaining wins under a point (SWE-bench Pro
  80.0 vs 79.2; DeepSWE 69.7 vs 68.8); Opus 5 wins long-horizon agentic work
  (Frontier-Bench 43.3 vs 33.7); Fable's safety classifiers fire far more on benign
  work (42% vs 5%). Manual invocation only. Revisit on a Mythos-tier update.
- **gpt-5.6-sol** keeps a lane on cost, not capability — free on our Codex plan.
  Leads DeepSWE v1.1 (72.7), level on web research. Lost computer use to Opus 5
  (OSWorld 2.0: 70.57% vs 62.6%). Far weaker on prompt injection (Gray Swan 20.0%
  vs 2.0%) → no autonomous work on untrusted input. With Astra, no hard tier.
- **opus-5 API breaking changes**: thinking on by default; `thinking: disabled`
  with effort xhigh/max returns 400; `max_tokens` caps thinking plus response.
