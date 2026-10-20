/**
 * A /ledger:close, /ledger:next or /ledger:go that ran in this turn: the session clears when the turn ends.
 * After /ledger:next and /ledger:go, the new session continues with `go <slug>`.
 */
export type LedgerArmed = { mode: 'close' | 'next' | 'go'; slug: string }

declare module 'claude-code' {
  interface PluginState {
    ledger: { armed: LedgerArmed | null }
  }
}
