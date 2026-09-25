# Model routing — rationale (not loaded into sessions)

Kept out of the rule files to save context. Update when the routing table changes.

## Published rates, checked 2026-09-25

Anthropic list prices, US dollars per million tokens. Cache write is the
five-minute rate.

| model | input | output | cache read | cache write |
|---|---|---|---|---|
| opus-5.5 | 4 | 20 | 0.20 | 5 |
| opus-5 | 5 | 25 | 0.50 | — |
| sonnet-5 | 2 | 10 | 0.20 | 2.50 |
| fable-5.1 | 10 | 50 | 0.25 | — |
| haiku-4.5 | 1 | 5 | 0.10 | — |

**Sonnet 5 did not get more expensive.** Its $2/$10 launched as introductory
pricing through 31 August 2026, and the scheduled rise to $3/$15 on 1 September
was cancelled; $2/$10 is now the standard rate, and cache reads stay at $0.20/M.
Any cost work that assumed the increase took effect is wrong and should be redone.
One price tracker still labels the Sonnet 5 row "through Aug 31, 2026", which is
the stale reading, not a second rate.

**Cache read is the number that matters here**, not the headline rate: the
eight-week measurement put cache reads at 61.5% of the bill and generation at
13.6%. Opus 5.5 and Sonnet 5 now charge the same $0.20/M for a cache read, which
is why the gap between those two lanes is far smaller than $4/$20 against $2/$10
looks.

Not checked here: `gpt-5.6-sol` and `gpt-6-astra`, which are OpenAI models billed
through the Codex plan. The figures for those below are list prices from their
release notes and have not been re-verified.

- **opus-5.5** (22 Sep 2026): $4/$20, cache read $0.20/M, cache write $5/M. That
  is 20% under Opus 5 on published rates and 60% under it on cache reads.
  Anthropic puts the typical workload saving at 40%, because runs are also
  shorter; output is >30% faster. Vendor and press place it at Fable 5.1's level
  on most work, at 40% of Fable's price. 1M context, no long-context premium;
  effort dial low→max.
  Cost score raised 4→5: cache read now equals Sonnet 5's $0.20/M, and cache read
  is 62% of the measured bill, so the real gap to Sonnet is much smaller than
  $4/$20 against $2/$10 suggests.
  Fast mode ($8/$40, 2.5x speed) not adopted — this fleet is context-bound, not
  latency-bound, so doubling the rate buys nothing.
  ⚠ Anthropic flagged that its safeguards can route some cybersecurity and
  biology-adjacent requests to an older, weaker model. Watch the `model` field in
  transcripts rather than assuming the frontmatter was honoured.
- **opus-5** (24 Jul 2026, superseded by 5.5): $5/$25. Topped the Artificial
  Analysis Intelligence and Agentic indices above Fable 5 and Sol.
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
  Opus 5.5 is claimed at Fable 5.1's level on most work at 40% of the price,
  which strengthens the retirement rather than weakening it.
- **gpt-5.6-sol** keeps a lane on cost, not capability — free on our Codex plan.
  Leads DeepSWE v1.1 (72.7), level on web research. Lost computer use to Opus 5
  (OSWorld 2.0: 70.57% vs 62.6%). Far weaker on prompt injection (Gray Swan 20.0%
  vs 2.0%) → no autonomous work on untrusted input. With Astra, no hard tier.
- **opus-5.x API breaking changes** (confirmed on opus-5, unverified on 5.5): thinking on by default; `thinking: disabled`
  with effort xhigh/max returns 400; `max_tokens` caps thinking plus response.
