import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { formatAll, formatTime, groupByParent, summarize, unknownTaskMessage, type Grouped } from './ledger'

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

const BACKLOG = '/home/.claude/ledger-backlog/repo'
const backlogPathOf = (slug: string): string => `${BACKLOG}/${slug}.md`

/**
 * `ledgers` maps a worktree ledger's path to its text, then `backlog` a backlog ledger's, then `unlisted` the ledger of
 * another worktree that ledger-list.sh paths does not print, newest first: the first is edited at n × 1000 ms for n
 * ledgers in all, the next 1000 ms earlier, and so on. `backlog` of a string is the error of a backlog lookup that fails.
 */
function world(
  on: On,
  cwd: string,
  ledgers: Record<string, string>,
  replies: Record<string, Reply> = {},
  backlog: Record<string, string> | string = {},
  unlisted: Record<string, string> = {},
): World {
  const calls: string[] = []
  let markdownArgs: string | undefined
  const backlogLedgers = typeof backlog === 'string' ? {} : backlog
  const files = { ...ledgers, ...backlogLedgers, ...unlisted }
  const all = Object.keys(files)
  const removed: string[] = []
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e) => {
    if (e.argv[0] === 'bash' && e.argv[2] === 'paths') return exit(0, Object.keys(ledgers).join('\n'))
    if (e.argv[0] === 'bash' && e.argv[2] === 'backlog') {
      calls.push('ledger-list.sh backlog')
      return typeof backlog === 'string' ? exit(1, '', backlog) : exit(0, Object.keys(backlog).join('\n'))
    }
    calls.push(scriptKey(e.argv))
    return replies[scriptKey(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async (_, e) =>
    removed.some(folder => e.path === folder || e.path.startsWith(`${folder}/`))
      ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
      : { value: { kind: 'file', size: 0, mtimeMs: (all.length - all.indexOf(e.path)) * 1000, isLink: false } },
  )
  on('fs.read', async (_, e) => (e.path in files ? { value: files[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
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

type Shape = [string, Shape[]]
const shapeOf = ({ item, children }: Grouped<{ slug: string }>): Shape => [item.slug, children.map(shapeOf)]
const shape = (items: { slug: string; parent?: string }[]): Shape[] => groupByParent(items, item => item.slug, item => item.parent).map(shapeOf)

test('groupByParent puts a child under its listed parent and keeps the rest in their order', () => {
  const items = [
    { slug: 'child-a', parent: 'epic' },
    { slug: 'other' },
    { slug: 'epic' },
    { slug: 'orphan', parent: 'gone' },
    { slug: 'child-b', parent: 'epic' },
  ]
  expect(shape(items)).toEqual([
    ['other', []],
    [
      'epic',
      [
        ['child-a', []],
        ['child-b', []],
      ],
    ],
    ['orphan', []],
  ])
})

test('groupByParent nests at every depth, and keeps each task of a cycle at the top with its other children under it', () => {
  const chain = [{ slug: 'a', parent: 'b' }, { slug: 'b', parent: 'c' }, { slug: 'c' }]
  const cycle = [{ slug: 'x', parent: 'y' }, { slug: 'y', parent: 'x' }, { slug: 'z', parent: 'x' }]
  const self = [{ slug: 's', parent: 's' }]
  expect(shape(chain)).toEqual([['c', [['b', [['a', []]]]]]])
  expect(shape(cycle)).toEqual([
    ['x', [['z', []]]],
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

test('/ledger does not look in the backlog when every parent is listed', async ($, on) => {
  const { calls } = world(on, '/repo', {
    [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }),
    [pathOf('epic')]: ledgerText('epic', { children: ['- child-a'] }),
  })

  await $.command.run({ command: 'ledger', args: '' })

  expect(calls).toEqual([])
})

const BACKLOG_FAMILY = {
  ledgers: { [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }), [pathOf('other')]: ledgerText('other') },
  backlog: { [backlogPathOf('epic')]: ledgerText('epic', { children: ['- child-a'] }), [backlogPathOf('idea')]: ledgerText('idea') },
}

test('/ledger shows a backlog parent of a listed task, marked backlog, with its children under it, and no other backlog task', async ($, on) => {
  const { calls } = world(on, '/repo', BACKLOG_FAMILY.ledgers, {}, BACKLOG_FAMILY.backlog)

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toBe(
    [
      '**Task ledgers** · 3 ledgers, newest first, children under their parent',
      '',
      `#### other · edited ${at(3000)}`,
      '- **Goal:** Goal of other.',
      '- **Next:** Next of other.',
      '',
      `#### epic (backlog) · edited ${at(2000)}`,
      '- **Goal:** Goal of epic.',
      '- **Next:** Next of epic.',
      '- **Children:**',
      `  - **child-a** · edited ${at(4000)}`,
      '    - **Goal:** Goal of child-a.',
      '    - **Next:** Next of child-a.',
    ].join('\n'),
  )
  expect(calls).toEqual(['ledger-list.sh backlog'])
})

test('/ledger <name> matches a backlog parent of a listed task', async ($, on) => {
  world(on, '/repo', BACKLOG_FAMILY.ledgers, {}, BACKLOG_FAMILY.backlog)

  const { text } = await $.command.run({ command: 'ledger', args: 'EPI' })

  expect(text).toBe(['**Task ledgers** · 1 ledger', '', `#### epic (backlog) · edited ${at(2000)}`, '- **Goal:** Goal of epic.', '- **Next:** Next of epic.'].join('\n'))
})

test('/ledger <name> does not match a backlog task that is no parent of a listed task', async ($, on) => {
  world(on, '/repo', BACKLOG_FAMILY.ledgers, {}, BACKLOG_FAMILY.backlog)

  const { text } = await $.command.run({ command: 'ledger', args: 'idea' })

  expect(text).toBe('No ledger matches "idea".')
})

test('/ledger walks up a chain of backlog parents and nests each level under the one above', async ($, on) => {
  world(
    on,
    '/repo',
    { [pathOf('child-a')]: ledgerText('child-a', { parent: 'mid' }) },
    {},
    { [backlogPathOf('mid')]: ledgerText('mid', { parent: 'top', children: ['- child-a'] }), [backlogPathOf('top')]: ledgerText('top', { children: ['- mid'] }) },
  )

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toBe(
    [
      '**Task ledgers** · 3 ledgers, newest first, children under their parent',
      '',
      `#### top (backlog) · edited ${at(1000)}`,
      '- **Goal:** Goal of top.',
      '- **Next:** Next of top.',
      '- **Children:**',
      `  - **mid (backlog)** · edited ${at(2000)}`,
      '    - **Goal:** Goal of mid.',
      '    - **Next:** Next of mid.',
      '    - **Children:**',
      `      - **child-a** · edited ${at(3000)}`,
      '        - **Goal:** Goal of child-a.',
      '        - **Next:** Next of child-a.',
    ].join('\n'),
  )
})

const porcelainZ = (...worktrees: string[]): string => worktrees.map(path => `worktree ${path}\0HEAD abc\0\0`).join('')

test('/ledger in a linked worktree walks up through a parent active in another worktree to a backlog grandparent, and shows no other worktree task', async ($, on) => {
  world(
    on,
    `${WORKTREES}/child-a`,
    { [pathOf('child-a')]: ledgerText('child-a', { parent: 'mid' }) },
    { 'git worktree list --porcelain -z': exit(0, porcelainZ('/repo', `${WORKTREES}/child-a`, `${WORKTREES}/mid`, `${WORKTREES}/stray`)) },
    { [backlogPathOf('top')]: ledgerText('top', { children: ['- mid'] }) },
    { [pathOf('mid')]: ledgerText('mid', { parent: 'top', children: ['- child-a'] }), [pathOf('stray')]: ledgerText('stray') },
  )

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toBe(
    [
      '**Task ledgers** · 3 ledgers, newest first, children under their parent',
      '',
      `#### top (backlog) · edited ${at(3000)}`,
      '- **Goal:** Goal of top.',
      '- **Next:** Next of top.',
      '- **Children:**',
      `  - **mid** · edited ${at(2000)}`,
      '    - **Goal:** Goal of mid.',
      '    - **Next:** Next of mid.',
      '    - **Children:**',
      `      - **child-a** · edited ${at(4000)}`,
      '        - **Goal:** Goal of child-a.',
      '        - **Next:** Next of child-a.',
    ].join('\n'),
  )
})

test('/ledger skips another worktree whose ledger cannot be read, and still shows the parent found in the others', async ($, on) => {
  world(
    on,
    `${WORKTREES}/child-a`,
    { [pathOf('child-a')]: ledgerText('child-a', { parent: 'mid' }) },
    { 'git worktree list --porcelain -z': exit(0, porcelainZ('/repo', `${WORKTREES}/child-a`, `${WORKTREES}/gone`, `${WORKTREES}/mid`)) },
    {},
    { [pathOf('mid')]: ledgerText('mid', { children: ['- child-a'] }) },
  )

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text.split('\n').filter(line => / · edited /.test(line))).toEqual([`#### mid · edited ${at(1000)}`, `  - **child-a** · edited ${at(2000)}`])
})

const parkedText = (slug: string, options: { parent?: string } = {}): string =>
  ledgerText(slug, options).replace('## Next step\n', '## Next step\nParked: 2026-10-01 — Waiting for the API.\n')

test('/ledger lists the active children first, then the parked ones, each newest first', async ($, on) => {
  world(on, '/repo', {
    [pathOf('child-parked')]: parkedText('child-parked', { parent: 'epic' }),
    [pathOf('child-new')]: ledgerText('child-new', { parent: 'epic' }),
    [pathOf('child-old')]: ledgerText('child-old', { parent: 'epic' }),
    [pathOf('epic')]: ledgerText('epic', { children: ['- child-parked', '- child-new', '- child-old'] }),
  })

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text.split('\n').filter(line => / · edited /.test(line))).toEqual([
    `#### epic · edited ${at(1000)}`,
    `  - **child-new** · edited ${at(3000)}`,
    `  - **child-old** · edited ${at(2000)}`,
    `  - **child-parked** · edited ${at(4000)}`,
  ])
})

test('/ledger stops at a cycle among backlog parents and shows each task once', async ($, on) => {
  world(
    on,
    '/repo',
    { [pathOf('child-a')]: ledgerText('child-a', { parent: 'p' }) },
    {},
    { [backlogPathOf('p')]: ledgerText('p', { parent: 'q' }), [backlogPathOf('q')]: ledgerText('q', { parent: 'p' }) },
  )

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toStartWith('**Task ledgers** · 3 ledgers')
  expect(text.split('\n').filter(line => /\b(child-a|p|q)\b.* · edited /.test(line))).toEqual([
    `#### p (backlog) · edited ${at(2000)}`,
    `  - **child-a** · edited ${at(3000)}`,
    `#### q (backlog) · edited ${at(1000)}`,
  ])
})

test('/ledger keeps the parent note when the parent is in no worktree and not in the backlog', async ($, on) => {
  world(on, '/repo', { [pathOf('child-a')]: ledgerText('child-a', { parent: 'gone' }) }, {}, { [backlogPathOf('idea')]: ledgerText('idea') })

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text.split('\n').at(-1)).toBe('- **Parent:** gone')
  expect(text).not.toContain('idea')
})

test('/ledger still shows the worktree ledgers when the backlog cannot be checked, and says so', async ($, on) => {
  world(on, '/repo', { [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }) }, {}, 'boom')

  const { text } = await $.command.run({ command: 'ledger', args: '' })

  expect(text).toStartWith(`**Task ledgers** · 1 ledger\n\n#### child-a · edited ${at(1000)}`)
  expect(text).toContain('- **Parent:** epic')
  expect(text.split('\n').at(-1)).toStartWith('Parent tasks in the backlog are not shown. ')
  expect(text).toEndWith('boom')
})

test('unknownTaskMessage names the children of each child with it', () => {
  const tasks = [{ slug: 'c', parent: 'b' }, { slug: 'a' }, { slug: 'b', parent: 'a' }]
  expect(unknownTaskMessage('nope', tasks)).toEndWith('Task ledgers: a (children: b (children: c)).')
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
