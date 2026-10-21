import type { EngineInterface } from 'claude-code'

import { run } from './lookup'

export const DASHBOARD_USAGE = 'Usage: /ledger:dashboard [stop]. Without stop it starts the dashboard, or shows the address of the one that runs.'

/** The text /ledger:dashboard answers with: the launcher's own output, which holds the page's address. */
export async function dashboardCommand($: EngineInterface, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(word => word !== '')
  if (words.length > 1 || words.some(word => word !== 'stop')) return DASHBOARD_USAGE
  const script = `${$.plugin.root}/../../bin/cc-ledger-dashboard`
  const { stdout, failure } = await run($, [script, ...words], $.plugin.root)
  return failure === undefined ? stdout.trim() : `cc-ledger-dashboard ${failure}`
}
