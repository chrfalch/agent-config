import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Entry = { repo: string; slug: string; path: string; branch: string; status: string; created: string; updated: string; archivePath?: string; parent?: string }

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

type Session = { cwd?: string; removed?: string }

function world(on: On, replies: Record<string, Reply>, files: Record<string, string> = {}, { cwd = '/repo', removed }: Session = {}): { argv: string[]; cwd?: string }[] {
  const calls: { argv: string[]; cwd?: string }[] = []
  on('session.cwd', async () => ({ value: cwd }))
  on('fs.stat', async (_, e) =>
    e.path === removed ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` } : { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } },
  )
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string } }) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd })
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
  expect(calls.map(({ argv, cwd }) => ({ key: scriptKey(argv), cwd }))).toEqual([{ key: 'bin/cc-ledgers scan --json', cwd: '/repo' }])
})

test('/ledger:all from a removed worktree runs the registry in the nearest folder that still exists', async ($, on) => {
  const only = entry('only', '2026-10-05T09:30:00.000Z')
  const gone = '/repo/.claude/worktrees/gone'
  const calls = world(on, { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([only])) }, { [only.path]: ledgerText('Ship it.') }, { cwd: gone, removed: gone })

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe(`**All task ledgers** · 1 task, 1 active\n\n${HEADER}\n| app | only | active | ${local(only.updated)} | Ship it. |`)
  expect(calls.map(({ argv, cwd }) => ({ key: scriptKey(argv), cwd }))).toEqual([{ key: 'bin/cc-ledgers list --json', cwd: '/repo/.claude/worktrees' }])
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

test('/ledger:all shows a child under its parent in the same repo, and any other child with a parent note', async ($, on) => {
  const child = entry('child', '2026-10-05T09:30:00.000Z', { parent: 'epic' })
  const other = entry('other', '2026-10-04T09:30:00.000Z')
  const epic = entry('epic', '2026-10-03T09:30:00.000Z')
  const orphan = entry('orphan', '2026-10-02T09:30:00.000Z', { parent: 'gone' })
  const elsewhere = entry('web-child', '2026-10-01T09:30:00.000Z', { repo: 'web', parent: 'epic' })
  const all = [child, other, epic, orphan, elsewhere]
  world(
    on,
    { 'bin/cc-ledgers list --json': exit(0, JSON.stringify(all)) },
    Object.fromEntries(all.map(({ path }) => [path, ledgerText('Ship it.')])),
  )

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe(
    [
      '**All task ledgers** · 5 tasks, 5 active',
      '',
      HEADER,
      `| app | other | active | ${local(other.updated)} | Ship it. |`,
      `| app | epic | active | ${local(epic.updated)} | Ship it. |`,
      `| app | ↳ child | active | ${local(child.updated)} | Ship it. |`,
      `| app | orphan (parent: gone) | active | ${local(orphan.updated)} | Ship it. |`,
      `| web | web-child (parent: epic) | active | ${local(elsewhere.updated)} | Ship it. |`,
    ].join('\n'),
  )
})

test('/ledger:all indents a grandchild one step further than its parent', async ($, on) => {
  const grandchild = entry('grandchild', '2026-10-05T09:30:00.000Z', { parent: 'child' })
  const child = entry('child', '2026-10-04T09:30:00.000Z', { parent: 'epic' })
  const epic = entry('epic', '2026-10-03T09:30:00.000Z')
  const all = [grandchild, child, epic]
  world(
    on,
    { 'bin/cc-ledgers list --json': exit(0, JSON.stringify(all)) },
    Object.fromEntries(all.map(({ path }) => [path, ledgerText('Ship it.')])),
  )

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text.split('\n').slice(4)).toEqual([
    `| app | epic | active | ${local(epic.updated)} | Ship it. |`,
    `| app | ↳ child | active | ${local(child.updated)} | Ship it. |`,
    `| app |   ↳ grandchild | active | ${local(grandchild.updated)} | Ship it. |`,
  ])
})

test('/ledger:all lists the active children first, then the parked and archived ones, each newest first', async ($, on) => {
  const parked = entry('c-parked', '2026-10-06T09:30:00.000Z', { parent: 'epic' })
  const archived = entry('c-gone', '2026-10-05T09:30:00.000Z', { parent: 'epic', status: 'archived', archivePath: '/home/.claude/ledger-archive/app/2026-10-05-c-gone.md' })
  const newer = entry('c-new', '2026-10-04T09:30:00.000Z', { parent: 'epic' })
  const older = entry('c-old', '2026-10-03T09:30:00.000Z', { parent: 'epic' })
  const epic = entry('epic', '2026-10-01T09:30:00.000Z')
  world(
    on,
    { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([older, parked, epic, archived, newer])) },
    {
      ...Object.fromEntries([newer, older, epic].map(({ path }) => [path, ledgerText('Ship it.')])),
      [parked.path]: ledgerText('Parked: 2026-10-06 — waiting for the API.\nShip it.'),
      [archived.archivePath ?? '']: ledgerText('Ship it.'),
    },
  )

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text.split('\n').slice(4)).toEqual([
    `| app | epic | active | ${local(epic.updated)} | Ship it. |`,
    `| app | ↳ c-new | active | ${local(newer.updated)} | Ship it. |`,
    `| app | ↳ c-old | active | ${local(older.updated)} | Ship it. |`,
    `| app | ↳ c-parked | parked | ${local(parked.updated)} | Ship it. |`,
    `| app | ↳ c-gone | archived | ${local(archived.updated)} | Ship it. |`,
  ])
})

const BACKLOG_HEADER = '| repo | slug | updated | goal |\n| --- | --- | --- | --- |'

const backlogEntry = (slug: string, updated: string): Entry & { main: string } => ({
  ...entry(slug, updated, { status: 'backlog', path: `/home/.claude/ledger-backlog/app/${slug}.md`, branch: '' }),
  main: '/repo',
})

test('/ledger:all lists backlog tasks in their own section, newest first, and counts them in the title', async ($, on) => {
  const active = entry('newer', '2026-10-05T09:30:00.000Z')
  const idea = backlogEntry('idea', '2026-10-04T08:00:00.000Z')
  const lost = backlogEntry('lost-idea', '2026-09-01T00:00:00.000Z')
  const latest = backlogEntry('latest', '2026-10-06T08:00:00.000Z')
  world(
    on,
    { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([idea, active, lost, latest])) },
    {
      [active.path]: ledgerText('Ship it.'),
      [idea.path]: '# Task ledger — idea\n\n## Goal\nLet | users pick a theme.\n',
      [latest.path]: `# Task ledger — latest\n\n## Goal\n${'y'.repeat(100)}\n`,
    },
  )

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe(
    [
      '**All task ledgers** · 4 tasks, 1 active, 3 backlog',
      '',
      HEADER,
      `| app | newer | active | ${local(active.updated)} | Ship it. |`,
      '',
      '**Backlog**',
      '',
      BACKLOG_HEADER,
      `| app | latest | ${local(latest.updated)} | ${'y'.repeat(79)}… |`,
      `| app | idea | ${local(idea.updated)} | Let \\| users pick a theme. |`,
      `| app | lost-idea | ${local(lost.updated)} | (unreadable) |`,
    ].join('\n'),
  )
})

test('/ledger:all with only backlog tasks shows the title and the backlog section alone', async ($, on) => {
  const idea = backlogEntry('idea', '2026-10-04T08:00:00.000Z')
  world(on, { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([idea])) }, { [idea.path]: '# Task ledger — idea\n\n## Goal\nA theme picker.\n' })

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe(
    ['**All task ledgers** · 1 task, 0 active, 1 backlog', '', '**Backlog**', '', BACKLOG_HEADER, `| app | idea | ${local(idea.updated)} | A theme picker. |`].join('\n'),
  )
})

test('/ledger:all rejects an entry whose main checkout is not a string', async ($, on) => {
  const broken = { ...backlogEntry('idea', '2026-10-04T08:00:00.000Z'), main: 7 }
  world(on, { 'bin/cc-ledgers list --json': exit(0, JSON.stringify([broken])) })

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text).toBe('cc-ledgers printed something that is not a list of ledgers.')
})

test('/ledger:all nests a backlog parent, child and grandchild in the backlog section as it does active tasks', async ($, on) => {
  const grandchild = { ...backlogEntry('grandchild', '2026-10-06T08:00:00.000Z'), parent: 'child' }
  const child = { ...backlogEntry('child', '2026-10-05T08:00:00.000Z'), parent: 'epic' }
  const other = backlogEntry('other', '2026-10-04T08:00:00.000Z')
  const epic = backlogEntry('epic', '2026-10-03T08:00:00.000Z')
  const all = [grandchild, child, other, epic]
  world(
    on,
    { 'bin/cc-ledgers list --json': exit(0, JSON.stringify(all)) },
    Object.fromEntries(all.map(({ slug, path }) => [path, `# Task ledger — ${slug}\n\n## Goal\nA goal.\n`])),
  )

  const { text } = await $.command.run({ command: 'ledger:all' })

  expect(text.split('\n').slice(6)).toEqual([
    `| app | other | ${local(other.updated)} | A goal. |`,
    `| app | epic | ${local(epic.updated)} | A goal. |`,
    `| app | ↳ child | ${local(child.updated)} | A goal. |`,
    `| app |   ↳ grandchild | ${local(grandchild.updated)} | A goal. |`,
  ])
})
