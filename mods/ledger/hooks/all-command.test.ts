import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Entry = { repo: string; slug: string; path: string; branch: string; status: string; created: string; updated: string; archivePath?: string }

const entry = (slug: string, updated: string, extra: Partial<Entry> = {}): Entry => ({
  repo: 'app',
  slug,
  path: `/repo/.claude/worktrees/${slug}/.claude/ledger.md`,
  branch: slug,
  status: 'active',
  created: '2026-01-01T00:00:00.000Z',
  updated,
  ...extra,
})

const ledgerText = (next: string): string => `# Task ledger — x\n\n## Goal\nA goal.\n\n## Next step\n\n${next}\nmore\n`

// The script is keyed by its folder and name, because the plugin root differs from machine to machine.
const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

function world(on: On, replies: Record<string, Reply>, files: Record<string, string> = {}): string[][] {
  const calls: string[][] = []
  on('process.run', async (_, e: { argv: string[] }) => {
    calls.push(e.argv)
    return replies[scriptKey(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.read', async (_, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
  return calls
}

const local = (iso: string): string => {
  const date = new Date(iso)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

const HEADER = '| repo | slug | status | updated | next |\n| --- | --- | --- | --- | --- |'

test('/ledger:all renders every registered ledger newest first with its next step', async ($, on) => {
  const older = entry('older', '2026-10-01T08:00:00.000Z')
  const newer = entry('newer', '2026-10-05T09:30:00.000Z')
  const archived = entry('gone', '2026-10-03T12:00:00.000Z', { status: 'archived', archivePath: '/home/.claude/ledger-archive/app/2026-10-03-gone.md' })
  const unreadable = entry('lost', '2026-09-01T00:00:00.000Z')
  const long = 'x'.repeat(100)
  world(
    on,
    { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([older, archived, newer, unreadable])) },
    {
      [older.path]: ledgerText('Run the tests.'),
      [newer.path]: ledgerText('Pick a | name.'),
      [archived.archivePath ?? '']: ledgerText(long),
    },
  )

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe(
    [
      '**All task ledgers** · 4 tasks, 3 active',
      '',
      HEADER,
      `| app | newer | active | ${local(newer.updated)} | Pick a \\| name. |`,
      `| app | gone | archived | ${local(archived.updated)} | ${'x'.repeat(79)}… |`,
      `| app | older | active | ${local(older.updated)} | Run the tests. |`,
      `| app | lost | active | ${local(unreadable.updated)} | (unreadable) |`,
    ].join('\n'),
  )
})

test('/ledger:all shows an active ledger with a parked mark as parked, and an archived one as archived', async ($, on) => {
  const parked = entry('parked', '2026-10-05T09:30:00.000Z')
  const archived = entry('gone', '2026-10-03T12:00:00.000Z', { status: 'archived', archivePath: '/home/.claude/ledger-archive/app/2026-10-03-gone.md' })
  const marked = ledgerText('Parked: 2026-10-04 — waiting for the API.\nRun the tests.')
  world(on, { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([parked, archived])) }, { [parked.path]: marked, [archived.archivePath ?? '']: marked })

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe(
    [
      '**All task ledgers** · 2 tasks, 0 active',
      '',
      HEADER,
      `| app | parked | parked | ${local(parked.updated)} | Run the tests. |`,
      `| app | gone | archived | ${local(archived.updated)} | Run the tests. |`,
    ].join('\n'),
  )
})

test('/ledger:all starts with a title line, and the table header starts its own line', async ($, on) => {
  const only = entry('only', '2026-10-05T09:30:00.000Z')
  world(on, { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([only])) }, { [only.path]: ledgerText('Ship it.') })

  const { text } = await $.command.run({ command: 'ledger:all' })

  const lines = text.split('\n')
  expect(lines[0]).toBe('**All task ledgers** · 1 task, 1 active')
  expect(lines[1]).toBe('')
  expect(lines[2]).toBe('| repo | slug | status | updated | next |')
})

test('/ledger:all --scan rebuilds the registry and names the rebuild first', async ($, on) => {
  const only = entry('only', '2026-10-05T09:30:00.000Z')
  const calls = world(
    on,
    { 'bin/cc-ledgers scan --json': exit(0, JSON.stringify([only]), 'rebuilt /home/.claude/ledgers.json: 1 active, 0 archived\n') },
    { [only.path]: ledgerText('Ship it.') },
  )

  const { text } = await $.command.run({ command: 'ledger:all', args: ' --scan ' })

  expect(text).toBe(
    `rebuilt /home/.claude/ledgers.json: 1 active, 0 archived\n\n**All task ledgers** · 1 task, 1 active\n\n${HEADER}\n| app | only | active | ${local(only.updated)} | Ship it. |`,
  )
  expect(calls.map(scriptKey)).toEqual(['bin/cc-ledgers scan --json'])
})

test('/ledger:all with an empty registry says how to rebuild it', async ($, on) => {
  world(on, { 'bin/cc-ledgers list --json': exit(0, '[]\n') })

  const { text } = await $.command.run({ command: 'ledger:all', args: '' })

  expect(text).toBe('No ledgers registered. Run /ledger:all --scan to rebuild from disk.')
})

test('/ledger:all with an unknown argument names it and runs nothing', async ($, on) => {
  const calls = world(on, {})

  const { text } = await $.command.run({ command: 'ledger:all', args: '--rebuild' })

  expect(text).toBe('Unknown argument: --rebuild. Usage: /ledger:all [--scan]')
  expect(calls).toEqual([])
})

test('/ledger:all passes on the script error in one line', async ($, on) => {
  world(on, { 'bin/cc-ledgers list --json': exit(1, '', 'cannot write /home/.claude/ledgers.json\n') })

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe('cc-ledgers failed (exit 1): cannot write /home/.claude/ledgers.json')
})

test('/ledger:all says so when the script does not run', async ($, on) => {
  world(on, {})

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toStartWith('cc-ledgers did not run: ')
})

test('/ledger:all says so when the script prints something other than a list of entries', async ($, on) => {
  world(on, { 'bin/cc-ledgers list --json': exit(0, '{"not": "a list"}') })

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe('cc-ledgers printed something that is not a list of ledgers.')
})
