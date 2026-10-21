import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { DASHBOARD_USAGE } from './dashboard-command'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// The script is keyed by its folder and name, because the plugin root differs from machine to machine.
const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

function world(on: On, replies: Record<string, Reply>): string[][] {
  const calls: string[][] = []
  on('process.run', async (_, e: { argv: string[] }) => {
    calls.push(e.argv)
    return replies[scriptKey(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  return calls
}

const STARTED = 'Ledger dashboard: http://127.0.0.1:5173/#key=abc\nIt keeps running until /ledger:dashboard stop.\n'

test('/ledger:dashboard starts the dashboard through the launcher and answers with its output', async ($, on) => {
  const calls = world(on, { 'bin/cc-ledger-dashboard': exit(0, STARTED) })
  const { text } = await $.command.run({ command: 'ledger:dashboard' })
  expect(text).toBe(STARTED.trim())
  expect(calls.map(scriptKey)).toEqual(['bin/cc-ledger-dashboard'])
})

test('/ledger:dashboard stop passes stop to the launcher', async ($, on) => {
  const calls = world(on, { 'bin/cc-ledger-dashboard stop': exit(0, 'Stopped the ledger dashboard (pid 42).\n') })
  const { text } = await $.command.run({ command: 'ledger:dashboard', args: ' stop ' })
  expect(text).toBe('Stopped the ledger dashboard (pid 42).')
  expect(calls.map(scriptKey)).toEqual(['bin/cc-ledger-dashboard stop'])
})

test('/ledger:dashboard with any other argument answers with usage and runs nothing', async ($, on) => {
  const calls = world(on, {})
  for (const args of ['restart', 'stop now', '--port 80']) {
    const { text } = await $.command.run({ command: 'ledger:dashboard', args })
    expect(text).toBe(DASHBOARD_USAGE)
  }
  expect(calls).toEqual([])
})

test('/ledger:dashboard reports a launcher failure with its error', async ($, on) => {
  world(on, { 'bin/cc-ledger-dashboard': exit(1, '', 'cc-ledger-dashboard: the server did not start. See ~/.claude/ledger-dashboard.log.\n') })
  const { text } = await $.command.run({ command: 'ledger:dashboard' })
  expect(text).toBe('cc-ledger-dashboard failed (exit 1): cc-ledger-dashboard: the server did not start. See ~/.claude/ledger-dashboard.log.')
})
