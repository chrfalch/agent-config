## Fleet reference

| agent             | engine      | effort          | answers                                    | never does                                            |
|-------------------|-------------|-----------------|--------------------------------------------|-------------------------------------------------------|
<!-- needs: researcher -->
| researcher        | opus-5.5    | medium          | *why* — root cause, relevant code surface  | fix, plan, edit                                       |
<!-- /needs -->
<!-- needs: runner -->
| runner            | sonnet-5.5  | —               | *what happened* — build/test verdicts      | fix (beyond trivial retry), dump raw logs             |
<!-- /needs -->
<!-- needs: ui-runner -->
| ui-runner         | opus-5.5    | medium/high     | *what the UI did* — device flows, assertions | fix code, paste hierarchies or screenshots          |
<!-- /needs -->
<!-- needs: opus-implementer -->
| opus-implementer  | opus-5.5    | medium/high/max | implement judged and taste work            | architecture, review                                  |
<!-- /needs -->
<!-- needs: sol-implementer -->
| sol-implementer   | gpt-6.1-sol | routine only    | implement free volume work                 | hard tier, untrusted input, taste work, fill spec gaps |
<!-- /needs -->
<!-- needs: astra-implementer -->
| astra-implementer | gpt-6-astra | high/xhigh/max  | implement the hardest well-specified work  | routine work, taste work, untrusted input, fill spec gaps, `--full-auto` |
<!-- /needs -->
<!-- needs: reviewer -->
| reviewer          | opus-5.5    | medium          | is it actually done, red/green provenance  | fix code                                              |
<!-- /needs -->
<!-- needs: astra-reviewer -->
| astra-reviewer    | gpt-6-astra | high/xhigh      | independent cross-lab verdict on critical work | fix code, see the Claude verdict before reviewing |
<!-- /needs -->

Runner first for errors; researcher when the cause is not obvious from them.
Pipeline: investigate → resolve ambiguity → plan → ledger → red tests → implement
(effort stated) → verify (runner) → review (reviewer) → clear point if more remains
→ you accept.

<!-- needs: astra-reviewer -->
Add `astra-reviewer` after `reviewer` on critical work.
<!-- /needs -->
