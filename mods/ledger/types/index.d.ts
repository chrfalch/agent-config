/** A /ledger:close or /ledger:next that ran in this turn: the session clears when the turn ends. */
export type LedgerArmed = { mode: 'close' | 'next'; slug: string }

declare module 'claude-code' {
  interface PluginState {
    ledger: { armed: LedgerArmed | null }
  }
}
