/**
 * A /ledger:close, /ledger:next, /ledger:go or /ledger:park that ran in this turn: the session clears when the turn ends.
 * After /ledger:next and /ledger:go, the new session continues with `go <slug>`. When the task at `ledger`, the one the old
 * session worked on, is finished, a line on how to retire it is shown first.
 * /ledger:park first writes `marker` into the ledger at `ledger`.
 */
export type LedgerArmed =
  | { mode: 'close'; slug: string }
  | { mode: 'next' | 'go'; slug: string; ledger?: string }
  | { mode: 'park'; slug: string; ledger: string; marker: string }

declare module 'claude-code' {
  interface PluginState {
    ledger: { armed: LedgerArmed | null }
  }
}
