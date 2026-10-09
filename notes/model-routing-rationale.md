# Model routing — rationale (not loaded into sessions)

Kept out of the rule files to save context. Update when the routing table changes.

## Published rates, checked 2026-09-30

US dollars per million tokens. Anthropic cache write is the five-minute rate.

Anthropic (source: platform.claude.com pricing page):

| model | input | output | cache read | cache write |
|---|---|---|---|---|
| opus-5.5 | 4 | 20 | 0.20 | 5 |
| sonnet-5.5 | 2 | 10 | 0.10 | 2.50 |
| sonnet-5 | 2 | 10 | 0.20 | 2.50 |
| fable-5.1 | 10 | 50 | 0.25 | 12.50 |
| mythos-5.1 | 10 | 50 | 0.25 | 12.50 |
| opus-5 | 5 | 25 | 0.50 | 6.25 |
| haiku-5.5, prompt ≤100k | 0.10 | 0.50 | 0.01 | 0.125 |
| haiku-5.5, prompt >100k | 0.50 | 2.50 | 0.05 | 0.625 |
| haiku-4.5 | 1 | 5 | 0.10 | 1.25 |

OpenAI API list prices (sources: OpenAI launch posts for GPT-6 Sol/Luna and
GPT-6.1 Sol; OpenRouter for cached rates and Astra). These models run here
through the Codex plan, so list price is what the usage would cost on the API,
not what the plan charges.

| model | input | cached input | output | context |
|---|---|---|---|---|
| gpt-6-astra | 10 | 1 | 50 | 1.05M |
| gpt-6.1-sol | 2 | 0.10 | 10 | 1.1M |
| gpt-6-sol | 2 | 0.20 | 10 | 1.1M |
| gpt-6-luna | 0.10 | 0.01 | 0.50 | 1.1M |

Codex's model list (learn.chatgpt.com/docs/models, 2026-09-30) recommends
`gpt-6-astra`, `gpt-6.1-sol` and `gpt-6-luna`. `gpt-5.6-sol` is no longer in
that list. Plan coverage for the GPT-6 family is assumed from the launch posts
("available in Codex for Plus, Pro, Business, Enterprise, Edu"), not measured.

**Cache read is the number that matters here**, not the headline rate: the
eight-week measurement put cache reads at 61.5% of the bill and generation at
13.6%. Opus 5.5 and Sonnet 5 charge $0.20/M for a cache read. Sonnet 5.5 charges
$0.10/M (pricing page, checked 2026-10-09; the 2026-09-30 table had $0.20).

## Changes on 2026-10-09

- **haiku-5.5** (7 Oct 2026, `claude-haiku-5-5`) added to the table. $0.10/$0.50,
  cache read $0.01/M, cache write $0.125/M, 1M context, 128k output. A request
  whose prompt passes 100k tokens (cache reads included) pays 5x on every rate.
  Vendor figures: Terminal-Bench 4.0 39.2% (Sonnet 5.5 70.6%, GPT-6 Luna 16.4%),
  OSWorld 2.1 72.4% (Sonnet 83.9%, Luna 48.9%), GDPval-AA 1620 (Sonnet 1840, Luna
  1437). Artificial Analysis index 43 at max effort, 34 at medium (Luna 37/29,
  6.1 Sol 52). Scores: cost 8 (same list price as Luna), intelligence 5, taste
  not measured. Prompt-injection robustness not published.
- **Codex wrappers** (`sol-implementer`, `astra-implementer`, `astra-reviewer`)
  move from `sonnet` to `claude-haiku-5-5`. They write a Codex prompt and relay
  the report; the judgement is in Codex.
- **Not moved:** `runner` stays on Sonnet 5.5 until a shadow trial compares
  verdicts on the same logs. Long logs can also pass the 100k price step.
  `ui-runner`, `researcher`, `reviewer` stay on Opus 5.5.
- **Open — Sonnet 5.5 cache read is $0.10/M**, half of Opus 5.5. Cost score left
  at 7 for now. Whether this reopens the 2026-09-22 withdrawal of "move
  main-thread turns to Sonnet" is undecided.

## Changes on 2026-09-30

- **sonnet-5.5** (28 Sep 2026) replaces sonnet-5 in the `runner` lane. Same
  rates as Sonnet 5. Anthropic claims 30%+ faster, up to 30% less cost per task,
  10 points over Sonnet 5 on FrontierCode, two points under Opus 5.5 on
  GDPval-AA, Terminal-Bench 4.0 70.6%. Scores: cost 6→7 (same rates, fewer
  tokens per task claimed), intelligence 6→7. Vendor claims, not measured here.
  Main-thread work stays on Opus: the 2026-09-22 withdrawal of "move main-thread
  turns to Sonnet" still stands.
- **gpt-6.1-sol** (29 Sep 2026) replaces gpt-5.6-sol in the `sol-implementer`
  lane and the read-only investigation route. $2/$10, cached $0.10. OpenAI
  claims it matches Astra on DeepSWE v1.1 at a fifth of the cost, +6.4 points
  over GPT-6 Sol; within 2.1 points of Astra on OSWorld 2.0; above Opus 5.5 on
  AutomationBench (+2.2) and GDP.pdf. Artificial Analysis Intelligence Index:
  6.1 Sol 52, Astra 53, 6 Sol 48. gpt-6-sol (22 Sep) was skipped: 6.1 is the
  same list price with half the cached rate.
  Prompt-injection robustness is not published for 6.1. The ban on untrusted
  input stays until it is measured.
- **gpt-6-luna** (22 Sep 2026) added to the table. $0.10/$0.50. AA index 37 at
  max effort, 29 at medium. Vendor and OpenRouter position it for high-volume
  classification and lightweight agentic tasks. No agent lane; one routing line
  for trivial batch work on trusted text. Taste not measured, so no score.
- **mythos-5.1** (1 Sep 2026) not added. Access is limited to vetted US
  organisations through Anthropic's cyber and life-sciences verification
  programs, so this fleet cannot use it.
- **Open question — Astra implementer.** If 6.1 Sol's DeepSWE and OSWorld claims
  hold, hard well-specified implementation could move from `astra-implementer`
  to `sol-implementer` at high/xhigh, at a fifth of the list price. Not changed
  on vendor claims alone; trial it on a few tasks first. `astra-reviewer` is
  unaffected (dual-model review is a standing decision).

## Earlier notes

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
- **gpt-6-astra** (3 Sep 2026; OpenRouter lists 4 Sep): $10/$50 list, cached $1/M, 5x Sol, same as Fable 5. 1M context,
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
- **gpt-5.6-sol** (superseded 2026-09-30 by gpt-6.1-sol) kept a lane on cost,
  not capability — free on our Codex plan.
  Leads DeepSWE v1.1 (72.7), level on web research. Lost computer use to Opus 5
  (OSWorld 2.0: 70.57% vs 62.6%). Far weaker on prompt injection (Gray Swan 20.0%
  vs 2.0%) → no autonomous work on untrusted input. With Astra, no hard tier.
- **opus-5.x API breaking changes** (confirmed on opus-5, unverified on 5.5): thinking on by default; `thinking: disabled`
  with effort xhigh/max returns 400; `max_tokens` caps thinking plus response.
