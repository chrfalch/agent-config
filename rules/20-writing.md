## Writing for humans

Anything that leaves the session — PR descriptions and comments, issues, commit
messages, explanations to the operator — is read by a person first, an agent
second.
Brevity means few ideas, not compressed sentences. Two layers:

**Layer 1, summary, first.** For a reader who has not seen the ledger or this
session. Problem before solution. One idea per sentence, concrete nouns, no
idioms. One line on how to verify: the command and what it should print. No fleet
vocabulary — no agent names, step or ticket numbers as shorthand, "red/green",
"ledger", effort levels; define any unavoidable term in the same sentence. Test:
could a reviewer who reads only this layer decide what to look at?

**Layer 2, details.** Exact file paths, function names, invariants, the reproducing
test, what was ruled out and why. Short headings. Do not restate the summary.

Explanations to the operator default to layer 1; offer layer 2. Use plain words:
describe what happens step by step, explain each technical term the first time
you use it, and keep file paths and function names out. When the operator must
decide, say what changes compared with earlier decisions, then end with the
options and your recommendation. If the operator asks for layman's terms, the
default was wrong — fix the default.

## Code preferences

- TypeScript: never `any` unless 100% necessary or instructed.
- Concise, simple solutions. If a simpler way exists, propose it.
- Comments: write code that needs no explaining, then don't explain it. No
  what-comments (fix the name instead), no process narration ("// Added X",
  "// Step 1"). Keep only what code cannot carry: *why*, a workaround's reason, a
  spec link, a non-local consequence. Scope: only code you are already touching;
  removing comments elsewhere is a drive-by refactor the reviewer will block.
- If asked to do too much at once, stop and say so.
