import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { formatAll, formatTime, groupByParent, summarize, unknownTaskMessage } from './ledger'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const WORKTREES = '/repo/.claude/worktrees'
const pathOf = (slug: string): string => `${WORKTREES}/${slug}/.claude/ledger.md`

function ledgerText(slug: string, { parent, children }: { parent?: string; children?: string[] } = {}): string {
  return [
    `# Task ledger — ${slug}`,
    '',
    '## Goal',
    `Goal of ${slug}.`,
    '',
    '## Location',
    `- worktree: ${WORKTREES}/${slug}`,
    ...(parent ? [`- parent: ${parent}`] : []),
    '',
    ...(children ? ['## Children', ...children, ''] : []),
    '## Next step',
    `Next of ${slug}.`,
    '',
  ].join('\n')
}

// The script is keyed by its folder and name, because the plugin root differs from machine to machine.
const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

type World = {
  calls: string[]
  markdownArgs: () => string | undefined
  /** Makes fs.stat fail for `folder` and everything in it, as after /ledger:retire removed the worktree. */
  removeFolder: (folder: string) => void
}

/** `ledgers` maps a path to its text, newest first: the first is edited at 4000 ms, the next at 3000 ms, and so on. */
function world(on: On, cwd: string, ledgers: Record<string, string>, replies: Record<string, Reply> = {}): World {
  const calls: string[] = []
  let markdownArgs: string | undefined
  const paths = Object.keys(ledgers)
  const removed: string[] = []
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'bash') return exit(0, paths.join('\n'))
    calls.push(scriptKey(e.argv))
    return replies[scriptKey(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async (_, e) =>
    removed.some(folder => e.path === folder || e.path.startsWith(`${folder}/`))
      ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
      : { value: { kind: 'file', size: 0, mtimeMs: (paths.length - paths.indexOf(e.path)) * 1000, isLink: false } },
  )
  on('fs.read', async (_, e) => (e.path in ledgers ? { value: ledgers[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', async () => ({ value: undefined }))
  on('command.run', { command: 'ledger:go' }, async (_, e) => {
    markdownArgs = e.args
    return { text: '' }
  })
  return {
    calls,
    markdownArgs: () => markdownArgs,
    removeFolder: folder => {
      removed.push(folder)
    },
  }
}

const shown = (children: { slug: string; status: string; next: string }[]): Reply =>
  exit(0, JSON.stringify({ parent: 'epic', goal: 'Goal of epic.', children }, null, 2))

const FAMILY = [
  { slug: 'child-a', status: 'active', next: 'Run the tests.' },
  { slug: 'child-b', status: 'parked', next: 'Wait for the API.' },
  { slug: 'old', status: 'retired', next: '' },
  { slug: 'lost', status: 'missing', next: '' },
]

const SHOW_EPIC = 'bin/cc-ledger-parent show epic --json'

// /ledger:go always lists the worktrees, to find another worktree's ledger with the same slug.
const withoutWorktreeList = (calls: string[]): string[] => calls.filter(call => call !== 'git worktree list --porcelain -z')

test('/ledger:parent <slug> shows the parent, then each child with its status and next step', async ($, on) => {
  const { calls } = world(on, '/repo', {}, { [SHOW_EPIC]: shown(FAMILY) })

  const { text } = await $.command.run({ command: 'ledger:parent', args: ' epic ' })

  expect(text).toBe(
    [
      '**Parent task epic** · 4 children, 1 active',
      'Goal of epic.',
      '',
      '- **child-a** · active — Run the tests.',
      '- **child-b** · parked — Wait for the API.',
      '- **old** · retired',
      '- **lost** · missing',
    ].join('\n'),
  )
  expect(calls).toEqual([SHOW_EPIC])
})

test('/ledger:parent of a task without children says how to add one', async ($, on) => {
  world(on, '/repo', {}, { [SHOW_EPIC]: shown([]) })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic' })

  expect(text).toBe('epic has no child tasks. Add one with `/ledger:parent epic add <child>`.')
})

test('/ledger:parent with one child counts it in the singular', async ($, on) => {
  world(on, '/repo', {}, { [SHOW_EPIC]: shown([FAMILY[0] ?? { slug: '', status: '', next: '' }]) })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic' })

  expect(text.split('\n')[0]).toBe('**Parent task epic** · 1 child, 1 active')
})

test('/ledger:parent without a slug in a child task shows its parent', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/child-a/src`, { [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }) }, { [SHOW_EPIC]: shown(FAMILY) })

  const { text } = await $.command.run({ command: 'ledger:parent' })

  expect(text.split('\n')[0]).toBe('**Parent task epic** · 4 children, 1 active')
  expect(calls).toEqual([SHOW_EPIC])
})

test('/ledger:parent without a slug in a parent task shows that task', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/epic`, { [pathOf('epic')]: ledgerText('epic', { children: ['- child-a', '- old (retired 2026-10-01)'] }) }, { [SHOW_EPIC]: shown(FAMILY) })

  await $.command.run({ command: 'ledger:parent', args: '' })

  expect(calls).toEqual([SHOW_EPIC])
})

for (const [where, cwd] of [
  ['a task with no parent or children', `${WORKTREES}/plain`],
  ['no task worktree', '/repo'],
] as const) {
  test(`/ledger:parent without a slug in ${where} prints one usage line and runs nothing`, async ($, on) => {
    const { calls } = world(on, cwd, { [pathOf('plain')]: ledgerText('plain') })

    const { text } = await $.command.run({ command: 'ledger:parent' })

    expect(text).toStartWith('Usage: /ledger:parent')
    expect(text.includes('\n')).toBe(false)
    expect(calls).toEqual([])
  })
}

test('/ledger:parent without a slug in a removed worktree nested in a parent task does not show that task as its own', async ($, on) => {
  const inner = `${WORKTREES}/epic/.claude/worktrees/inner`
  const epic = ledgerText('epic', { children: ['- child-a'] })
  const { calls, removeFolder } = world(on, inner, { [pathOf('epic')]: epic }, { [SHOW_EPIC]: shown(FAMILY) })
  removeFolder(inner)

  const { text } = await $.command.run({ command: 'ledger:parent' })

  expect(text).toStartWith('Usage: /ledger:parent')
  expect(calls).toEqual([])
})

for (const args of ['add', 'remove', 'epic add', 'epic add a b', 'epic move child-a', 'add child-a', 'epic child-a']) {
  test(`/ledger:parent ${args} prints the usage and runs nothing`, async ($, on) => {
    const { calls } = world(on, '/repo', {})

    const { text } = await $.command.run({ command: 'ledger:parent', args })

    expect(text).toStartWith('Usage: /ledger:parent')
    expect(calls).toEqual([])
  })
}

test('/ledger:parent <slug> add <child> runs cc-ledger-parent add and says what changed', async ($, on) => {
  const { calls } = world(on, '/repo', {}, { 'bin/cc-ledger-parent add epic child-a': exit(0, '') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic add child-a' })

  expect(text).toBe('epic is now the parent of child-a.')
  expect(calls).toEqual(['bin/cc-ledger-parent add epic child-a'])
})

test('/ledger:parent add add <child> treats the first add as the parent slug', async ($, on) => {
  const { calls } = world(on, '/repo', {}, { 'bin/cc-ledger-parent add add child-a': exit(0, '') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'add add child-a' })

  expect(text).toBe('add is now the parent of child-a.')
  expect(calls).toEqual(['bin/cc-ledger-parent add add child-a'])
})

test('/ledger:parent <slug> remove <child> runs cc-ledger-parent remove and says what changed', async ($, on) => {
  const { calls } = world(on, '/repo', {}, { 'bin/cc-ledger-parent remove epic child-a': exit(0, '') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic remove child-a' })

  expect(text).toBe('child-a is no longer a child of epic.')
  expect(calls).toEqual(['bin/cc-ledger-parent remove epic child-a'])
})

test('/ledger:parent add passes on a warning the script printed on success', async ($, on) => {
  world(on, '/repo', {}, { 'bin/cc-ledger-parent add epic child-a': exit(0, '', 'warning: registry not updated\n') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic add child-a' })

  expect(text).toBe('epic is now the parent of child-a. warning: registry not updated')
})

test('/ledger:parent add passes on the script error in one line', async ($, on) => {
  world(on, '/repo', {}, { 'bin/cc-ledger-parent add epic child-a': exit(1, '', 'child-a already has the parent other;\nremove it first\n') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic add child-a' })

  expect(text).toBe('Could not add child-a to epic. child-a already has the parent other; remove it first')
})

test('/ledger:parent remove passes on the script error', async ($, on) => {
  world(on, '/repo', {}, { 'bin/cc-ledger-parent remove epic child-a': exit(1, '', 'child-a is not a child of epic\n') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic remove child-a' })

  expect(text).toBe('Could not remove child-a from epic. child-a is not a child of epic')
})

test('/ledger:parent <slug> passes on the script error', async ($, on) => {
  world(on, '/repo', {}, { [SHOW_EPIC]: exit(1, '', 'no task ledger with the slug epic in this repository\n') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic' })

  expect(text).toBe('Could not show epic. no task ledger with the slug epic in this repository')
})

test('/ledger:parent says so when the script does not run', async ($, on) => {
  world(on, '/repo', {})

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic' })

  expect(text).toStartWith('Could not show epic. cc-ledger-parent did not run: ')
})

test('/ledger:parent says so when the script prints something other than a parent', async ($, on) => {
  world(on, '/repo', {}, { [SHOW_EPIC]: exit(0, '{"parent": "epic"}') })

  const { text } = await $.command.run({ command: 'ledger:parent', args: 'epic' })

  expect(text).toBe('Could not show epic. cc-ledger-parent printed something that is not a parent and its children.')
})

test('summarize reads the parent bullet and the Children lines', () => {
  const child = summarize(ledgerText('child-a', { parent: 'epic' }), 'folder', 0)
  const parent = summarize(ledgerText('epic', { children: ['- child-a', '- old (retired 2026-10-01)', 'notes'] }), 'folder', 0)
  expect(child.parent).toBe('epic')
  expect(child.children).toBeUndefined()
  expect(parent.parent).toBeUndefined()
  expect(parent.children).toEqual([{ slug: 'child-a' }, { slug: 'old', retired: '2026-10-01' }])
})

test('summarize ignores a template placeholder, a parent of several words, and a heading that only starts with Children', () => {
  const placeholder = ledgerText('t').replace('## Location\n', '## Location\n- parent: <slug>\n')
  const words = ledgerText('t').replace('## Location\n', '## Location\n- parent: two words\n')
  const old = ledgerText('t').replace('## Next step', '## Children (old)\n- child-a\n\n## Next step')
  for (const text of [placeholder, words, old]) {
    const { parent, children } = summarize(text, 'folder', 0)
    expect([parent, children]).toEqual([undefined, undefined])
  }
})

test('summarize reads CRLF parent and Children lines', () => {
  const crlf = (text: string) => text.replace(/\n/g, '\r\n')
  expect(summarize(crlf(ledgerText('child-a', { parent: 'epic' })), 'folder', 0).parent).toBe('epic')
  expect(summarize(crlf(ledgerText('epic', { children: ['- child-a'] })), 'folder', 0).children).toEqual([{ slug: 'child-a' }])
})

test('groupByParent puts a child under its listed parent and keeps the rest in their order', () => {
  const items = [
    { slug: 'child-a', parent: 'epic' },
    { slug: 'other' },
    { slug: 'epic' },
    { slug: 'orphan', parent: 'gone' },
    { slug: 'child-b', parent: 'epic' },
  ]
  const grouped = groupByParent(items, item => item.slug, item => item.parent)
  expect(grouped.map(({ item, children }) => [item.slug, children.map(child => child.slug)])).toEqual([
    ['other', []],
    ['epic', ['child-a', 'child-b']],
    ['orphan', []],
  ])
})

test('groupByParent nests no deeper than one level and survives a cycle', () => {
  const chain = [{ slug: 'a', parent: 'b' }, { slug: 'b', parent: 'c' }, { slug: 'c' }]
  const cycle = [{ slug: 'x', parent: 'y' }, { slug: 'y', parent: 'x' }]
  const self = [{ slug: 's', parent: 's' }]
  const shape = (items: { slug: string; parent?: string }[]) =>
    groupByParent(items, item => item.slug, item => item.parent).map(({ item, children }) => [item.slug, children.map(child => child.slug)])
  expect(shape(chain)).toEqual([
    ['a', []],
    ['c', ['b']],
  ])
  expect(shape(cycle)).toEqual([
    ['x', []],
    ['y', []],
  ])
  expect(shape(self)).toEqual([['s', []]])
})

const at = (ms: number) => formatTime(ms)

test('formatAll shows a child indented under its parent, and a child whose parent is not listed with a parent note', () => {
  const ledgers = [
    summarize(ledgerText('child-a', { parent: 'epic' }), '', 4000),
    summarize(ledgerText('other'), '', 3000),
    summarize(ledgerText('epic', { children: ['- child-a'] }), '', 2000),
    summarize(ledgerText('orphan', { parent: 'gone' }), '', 1000),
  ]
  expect(formatAll(ledgers)).toBe(
    [
      '**Task ledgers** · 4 ledgers, newest first, children under their parent',
      '',
      `#### other · edited ${at(3000)}`,
      '- **Goal:** Goal of other.',
      '- **Next:** Next of other.',
      '',
      `#### epic · edited ${at(2000)}`,
      '- **Goal:** Goal of epic.',
      '- **Next:** Next of epic.',
      '- **Children:**',
      `  - **child-a** · edited ${at(4000)}`,
      '    - **Goal:** Goal of child-a.',
      '    - **Next:** Next of child-a.',
      '',
      `#### orphan · edited ${at(1000)}`,
      '- **Goal:** Goal of orphan.',
      '- **Next:** Next of orphan.',
      '- **Parent:** gone',
    ].join('\n'),
  )
})

test('/ledger groups the children under their parent', async ($, on) => {
  world(on, '/repo', {
    [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }),
    [pathOf('epic')]: ledgerText('epic', { children: ['- child-a'] }),
  })

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toBe(
    [
      '**Task ledgers** · 2 ledgers, newest first, children under their parent',
      '',
      `#### epic · edited ${at(1000)}`,
      '- **Goal:** Goal of epic.',
      '- **Next:** Next of epic.',
      '- **Children:**',
      `  - **child-a** · edited ${at(2000)}`,
      '    - **Goal:** Goal of child-a.',
      '    - **Next:** Next of child-a.',
    ].join('\n'),
  )
})

test('unknownTaskMessage names the children of a listed parent with it, and the parent of any other child', () => {
  const tasks = [{ slug: 'child-a', parent: 'epic' }, { slug: 'epic' }, { slug: 'orphan', parent: 'gone' }, { slug: 'child-b', parent: 'epic' }]
  expect(unknownTaskMessage('nope', tasks)).toBe(
    'No task ledger is named "nope". Nothing was written, and the session was not cleared. Task ledgers: epic (children: child-a, child-b), orphan (parent: gone).',
  )
})

const FAMILY_LEDGERS = {
  [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }),
  [pathOf('epic')]: ledgerText('epic', { children: ['- child-a', '- old (retired 2026-10-01)'] }),
  [pathOf('orphan')]: ledgerText('orphan', { parent: 'gone' }),
}

test('/ledger:go to an unknown slug lists the tasks grouped by parent', async ($, on) => {
  world(on, '/repo', FAMILY_LEDGERS)

  const { text } = await $.command.run({ command: 'ledger:go', args: 'nope' })

  expect(text).toContain('Task ledgers: epic (children: child-a), orphan (parent: gone).')
})

test('/ledger:go <child> names the parent to the command', async ($, on) => {
  const { calls, markdownArgs } = world(on, '/repo', FAMILY_LEDGERS)

  await $.command.run({ command: 'ledger:go', args: 'child-a' })

  expect(markdownArgs()).toBe('task: child-a\nledger: none\nparent: epic')
  expect(withoutWorktreeList(calls)).toEqual([])
})

test('/ledger:go <parent> lists the children with their status to the command', async ($, on) => {
  const { calls, markdownArgs } = world(on, '/repo', FAMILY_LEDGERS, {
    [SHOW_EPIC]: shown([
      { slug: 'child-a', status: 'active', next: 'Run the tests.' },
      { slug: 'old', status: 'retired', next: '' },
    ]),
  })

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(markdownArgs()).toBe('task: epic\nledger: none\nchildren: child-a (active), old (retired)')
  expect(withoutWorktreeList(calls)).toEqual([SHOW_EPIC])
})

test('/ledger:go <parent> still switches when the children cannot be listed, without a children line', async ($, on) => {
  const { markdownArgs } = world(on, '/repo', FAMILY_LEDGERS, { [SHOW_EPIC]: exit(1, '', 'boom\n') })

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(markdownArgs()).toBe('task: epic\nledger: none')
})
