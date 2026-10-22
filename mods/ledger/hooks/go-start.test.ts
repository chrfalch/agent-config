import type { EngineInterface, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { summarize } from './ledger'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const WORKTREES = '/repo/.claude/worktrees'
const BACKLOG = '/home/.claude/ledger-backlog/repo'
const pathOf = (slug: string): string => `${WORKTREES}/${slug}/.claude/ledger.md`
const backlogPathOf = (slug: string): string => `${BACKLOG}/${slug}.md`
const UNCHANGED = 'Nothing was written, and the session was not cleared.'

function ledgerText(slug: string, { parent, children }: { parent?: string; children?: string } = {}): string {
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
    ...(children ? ['## Children', children, ''] : []),
    '## Next step',
    `Next of ${slug}.`,
    '',
  ].join('\n')
}

const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

const REGISTRY = 'bin/cc-ledgers list --json'
const COMMON_DIR = 'git rev-parse --path-format=absolute --git-common-dir'
const WORKTREE_LIST = 'git worktree list --porcelain -z'
const PROMOTE = (slug: string) => `bin/cc-task-new --promote ${slug}`
const START = (parent: string, child: string) => `bin/cc-ledger-parent start ${parent} ${child}`
const NEXT = (parent: string) => `bin/cc-ledger-parent next ${parent}`
const SHOW = (parent: string) => `bin/cc-ledger-parent show ${parent} --json`

const promoted = (slug: string): Reply =>
  exit(0, `worktree ${WORKTREES}/${slug}\nbranch   ${slug}\nbase     origin/main @ abc1234\nledger   ${pathOf(slug)}\n`)

const backlogEntry = (slug: string, extra: Record<string, string> = {}) => ({
  repo: 'repo',
  slug,
  path: backlogPathOf(slug),
  branch: '',
  status: 'backlog',
  main: '/repo',
  created: '2026-10-01T00:00:00.000Z',
  updated: '2026-10-01T00:00:00.000Z',
  ...extra,
})

const registry = (...entries: object[]): Reply => exit(0, JSON.stringify(entries))

const shown = (parent: string, children: { slug: string; status: string }[]): Reply =>
  exit(0, JSON.stringify({ parent, goal: `Goal of ${parent}.`, children: children.map(child => ({ ...child, next: '' })) }))

/**
 * `listed` are the ledgers ledger-list.sh paths prints; `files` every other file there is to read, such as a backlog ledger
 * or the ledger a promotion moves into its new worktree.
 */
function world(on: On, cwd: string, listed: Record<string, string>, replies: Record<string, Reply>, files: Record<string, string> = {}) {
  const all = { ...listed, ...files }
  const commands: { key: string; cwd?: string }[] = []
  const calls: string[] = []
  const armed: unknown[] = []
  const writes: string[] = []
  let markdownArgs: string | undefined
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string } }) => {
    if (e.argv[0] === 'bash') return exit(0, Object.keys(listed).join('\n'))
    const key = scriptKey(e.argv)
    if (key !== WORKTREE_LIST) commands.push({ key, cwd: e.init?.cwd })
    return replies[key] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => (e.path in all ? { value: all[e.path] ?? '' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', async (_, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('state.set', async (_, e, next) => {
    if (e.plugin === 'ledger' && e.key === 'armed' && e.value !== null) armed.push(e.value)
    return next(e)
  })
  on('command.run', { command: 'ledger:go' }, async (_, e) => {
    markdownArgs = e.args
    return { text: '' }
  })
  on('command.run', { command: 'clear' }, async () => {
    calls.push('clear')
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => {
    calls.push(`submit: ${e.text}`)
    return { text: '' }
  })
  on('ui.log', async (_, e) => {
    calls.push(`log: ${e.text}`)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: '' }))
  return { commands, calls, armed, writes, markdownArgs: () => markdownArgs }
}

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

const keys = (commands: { key: string }[]): string[] => commands.map(({ key }) => key)

async function expectGoTo($: EngineInterface, w: ReturnType<typeof world>, slug: string): Promise<void> {
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual(['clear', `submit: go ${slug}`])
}

test('summarize reads a Children line marked started, with its date', () => {
  const text = ledgerText('epic', { children: '- a (started 2026-10-20)\n- b (retired 2026-10-01)\n- c' })

  expect(summarize(text, 'x', 0).children).toEqual([{ slug: 'a', started: '2026-10-20' }, { slug: 'b', retired: '2026-10-01' }, { slug: 'c' }])
})

const CHILD_IN_WORKTREE = {
  [pathOf('child-a')]: ledgerText('child-a', { parent: 'epic' }),
  [pathOf('epic')]: ledgerText('epic', { children: '- child-a' }),
}

test('/ledger:go <child> marks it started in its parent, and names the parent ledger it changed', async ($, on) => {
  const w = world(on, '/repo', CHILD_IN_WORKTREE, { [START('epic', 'child-a')]: exit(0, `started child-a in ${pathOf('epic')}\n`) })

  await $.command.run({ command: 'ledger:go', args: 'child-a' })

  expect(w.commands).toEqual([{ key: START('epic', 'child-a'), cwd: '/repo' }])
  expect(w.markdownArgs()).toBe(`task: child-a\nledger: none\nparent: epic\nmarked: ${pathOf('epic')}`)
  await expectGoTo($, w, 'child-a')
})

test('/ledger:go <child> whose line is already marked adds no marked line', async ($, on) => {
  const w = world(on, '/repo', CHILD_IN_WORKTREE, { [START('epic', 'child-a')]: exit(0, '') })

  await $.command.run({ command: 'ledger:go', args: 'child-a' })

  expect(w.markdownArgs()).toBe('task: child-a\nledger: none\nparent: epic')
})

test('/ledger:go <child> still switches when the mark cannot be written, and passes on a warning', async ($, on) => {
  const w = world(on, '/repo', CHILD_IN_WORKTREE, {
    [START('epic', 'child-a')]: exit(1, '', 'no task ledger with the slug epic in this repository\n'),
  })

  await $.command.run({ command: 'ledger:go', args: 'child-a' })

  expect(w.markdownArgs()).toBe(
    'task: child-a\nledger: none\nparent: epic\nwarning: Could not mark child-a started in its parent epic: no task ledger with the slug epic in this repository.',
  )
  expect(w.armed).toEqual([{ mode: 'go', slug: 'child-a' }])
  await expectGoTo($, w, 'child-a')
})

test('/ledger:go <child> still switches when the mark script does not run', async ($, on) => {
  const w = world(on, '/repo', CHILD_IN_WORKTREE, {})

  await $.command.run({ command: 'ledger:go', args: 'child-a' })

  expect(w.markdownArgs()).toContain('\nwarning: Could not mark child-a started in its parent epic: cc-ledger-parent did not run')
  await expectGoTo($, w, 'child-a')
})

test('/ledger:go <backlog child> promotes it, then marks it started in its parent', async ($, on) => {
  const kid = ledgerText('kid', { parent: 'epic' })
  const w = world(
    on,
    '/repo',
    {},
    {
      [REGISTRY]: registry(backlogEntry('kid', { parent: 'epic' })),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [PROMOTE('kid')]: promoted('kid'),
      [START('epic', 'kid')]: exit(0, `started kid in ${backlogPathOf('epic')}\n`),
    },
    { [backlogPathOf('kid')]: kid, [pathOf('kid')]: kid },
  )

  await $.command.run({ command: 'ledger:go', args: 'kid' })

  expect(keys(w.commands)).toEqual([REGISTRY, COMMON_DIR, PROMOTE('kid'), START('epic', 'kid')])
  expect(w.markdownArgs()).toBe(`task: kid\nledger: none\nparent: epic\npromoted: ${WORKTREES}/kid\nmarked: ${backlogPathOf('epic')}`)
  await expectGoTo($, w, 'kid')
})

test('/ledger:go <parent> starts its first child not yet started, and names the parent it was picked from', async ($, on) => {
  const kid = ledgerText('kid', { parent: 'epic' })
  const w = world(
    on,
    `${WORKTREES}/epic`,
    { [pathOf('epic')]: ledgerText('epic', { children: '- busy\n- kid' }) },
    {
      [NEXT('epic')]: exit(0, 'epic kid\n'),
      [REGISTRY]: registry(backlogEntry('kid', { parent: 'epic' })),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [PROMOTE('kid')]: promoted('kid'),
      [START('epic', 'kid')]: exit(0, `started kid in ${pathOf('epic')}\n`),
    },
    { [backlogPathOf('kid')]: kid, [pathOf('kid')]: kid },
  )

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(keys(w.commands)).toEqual([NEXT('epic'), REGISTRY, COMMON_DIR, PROMOTE('kid'), START('epic', 'kid')])
  expect(w.markdownArgs()).toBe(
    `task: kid\nledger: ${pathOf('epic')}\nparent: epic\npromoted: ${WORKTREES}/kid\npicked: epic > kid\nmarked: ${pathOf('epic')}`,
  )
  expect(w.armed).toEqual([{ mode: 'go', slug: 'kid', ledger: pathOf('epic') }])
  await expectGoTo($, w, 'kid')
})

test('/ledger:go <parent> walks down to a grandchild when the picked child has children of its own', async ($, on) => {
  const leaf = ledgerText('leaf', { parent: 'phase' })
  const w = world(
    on,
    '/repo',
    { [pathOf('epic')]: ledgerText('epic', { children: '- phase' }) },
    {
      [NEXT('epic')]: exit(0, 'epic phase leaf\n'),
      [REGISTRY]: registry(backlogEntry('phase', { parent: 'epic' }), backlogEntry('leaf', { parent: 'phase' })),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [PROMOTE('leaf')]: promoted('leaf'),
      [START('phase', 'leaf')]: exit(0, `started leaf in ${backlogPathOf('phase')}\n`),
    },
    { [backlogPathOf('leaf')]: leaf, [pathOf('leaf')]: leaf },
  )

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(keys(w.commands)).toEqual([NEXT('epic'), REGISTRY, COMMON_DIR, PROMOTE('leaf'), START('phase', 'leaf')])
  expect(w.markdownArgs()).toBe(
    `task: leaf\nledger: none\nparent: phase\npromoted: ${WORKTREES}/leaf\npicked: epic > phase > leaf\nmarked: ${backlogPathOf('phase')}`,
  )
  await expectGoTo($, w, 'leaf')
})

test('/ledger:go <backlog parent> starts its first child and leaves the parent in the backlog', async ($, on) => {
  const kid = ledgerText('kid', { parent: 'epic' })
  const w = world(
    on,
    '/repo',
    {},
    {
      [REGISTRY]: registry(backlogEntry('epic'), backlogEntry('kid', { parent: 'epic' })),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [NEXT('epic')]: exit(0, 'epic kid\n'),
      [PROMOTE('kid')]: promoted('kid'),
      [START('epic', 'kid')]: exit(0, `started kid in ${backlogPathOf('epic')}\n`),
    },
    { [backlogPathOf('epic')]: ledgerText('epic', { children: '- kid' }), [backlogPathOf('kid')]: kid, [pathOf('kid')]: kid },
  )

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(keys(w.commands)).not.toContain(PROMOTE('epic'))
  expect(keys(w.commands).at(-2)).toBe(PROMOTE('kid'))
  expect(w.markdownArgs()).toBe(`task: kid\nledger: none\nparent: epic\npromoted: ${WORKTREES}/kid\npicked: epic > kid\nmarked: ${backlogPathOf('epic')}`)
  await expectGoTo($, w, 'kid')
})

test('/ledger:go <parent> with no child left to start continues in the parent worktree, as before', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('epic')]: ledgerText('epic', { children: '- busy\n- old (retired 2026-10-01)' }) }, {
    [NEXT('epic')]: exit(0, ''),
    [SHOW('epic')]: shown('epic', [{ slug: 'busy', status: 'active' }, { slug: 'old', status: 'retired' }]),
  })

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(keys(w.commands)).toEqual([NEXT('epic'), SHOW('epic')])
  expect(w.markdownArgs()).toBe('task: epic\nledger: none\nchildren: busy (active), old (retired)')
  await expectGoTo($, w, 'epic')
})

test('/ledger:go <parent> continues in the parent worktree with a warning when no child can be picked', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('epic')]: ledgerText('epic', { children: '- busy' }) }, {
    [NEXT('epic')]: exit(1, '', 'boom\n'),
    [SHOW('epic')]: shown('epic', [{ slug: 'busy', status: 'active' }]),
  })

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(w.markdownArgs()).toBe('task: epic\nledger: none\nchildren: busy (active)\nwarning: Could not pick a child task of epic to start, so this continues in epic: boom.')
  await expectGoTo($, w, 'epic')
})

test('/ledger:go to a task without children asks for no child to start', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('solo')]: ledgerText('solo') }, {})

  await $.command.run({ command: 'ledger:go', args: 'solo' })

  expect(w.commands).toEqual([])
  expect(w.markdownArgs()).toBe('task: solo\nledger: none')
})

const BACKLOG_PARENT = { [backlogPathOf('epic')]: ledgerText('epic', { children: '- busy\n- old (retired 2026-10-01)' }) }

async function expectNothingChanged($: EngineInterface, w: ReturnType<typeof world>): Promise<void> {
  expect(w.writes).toEqual([])
  expect(w.armed).toEqual([])
  expect(w.markdownArgs()).toBe(undefined)
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
}

test('/ledger:go <backlog parent> with no child left to start lists its children and promotes nothing', async ($, on) => {
  const w = world(
    on,
    '/repo',
    {},
    {
      [REGISTRY]: registry(backlogEntry('epic')),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [NEXT('epic')]: exit(0, ''),
      [SHOW('epic')]: shown('epic', [{ slug: 'busy', status: 'active' }, { slug: 'old', status: 'retired' }]),
      [PROMOTE('epic')]: promoted('epic'),
    },
    BACKLOG_PARENT,
  )

  const { text } = await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(text).toBe(
    `Backlog task epic has no child task left to start. Child tasks: busy (active), old (retired). ${UNCHANGED} A parent task in the backlog stays there: continue in a child task with /ledger:go <child>, or add one with /ledger:parent epic add <child>.`,
  )
  expect(keys(w.commands)).toEqual([REGISTRY, COMMON_DIR, NEXT('epic'), SHOW('epic')])
  await expectNothingChanged($, w)
})

test('/ledger:go <backlog parent> refuses when no child can be picked', async ($, on) => {
  const w = world(
    on,
    '/repo',
    {},
    {
      [REGISTRY]: registry(backlogEntry('epic')),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [NEXT('epic')]: exit(1, '', 'boom\n'),
      [PROMOTE('epic')]: promoted('epic'),
    },
    BACKLOG_PARENT,
  )

  const { text } = await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(text).toBe(`Could not pick a child task of backlog task epic to start: boom. ${UNCHANGED}`)
  expect(keys(w.commands)).not.toContain(PROMOTE('epic'))
  await expectNothingChanged($, w)
})
