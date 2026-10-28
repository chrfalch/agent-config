import type { EngineInterface, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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
function world(on: On, cwd: string, listed: Record<string, string>, replies: Record<string, Reply>, files: Record<string, string> = {}, removed?: string) {
  const all = { ...listed, ...files }
  const commands: { key: string; cwd?: string }[] = []
  const calls: string[] = []
  const armed: unknown[] = []
  const writes: string[] = []
  let markdownArgs: string | undefined
  const skills: { skill: string; args?: string }[] = []
  let isDownstreamBroken = false
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string } }) => {
    if (e.argv[0] === 'bash') return exit(0, Object.keys(listed).join('\n'))
    const key = scriptKey(e.argv)
    if (key !== WORKTREE_LIST) commands.push({ key, cwd: e.init?.cwd })
    return replies[key] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async (_, e) =>
    e.path === removed ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` } : { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } },
  )
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
    if (isDownstreamBroken) throw new Error('markdown command failed')
    return { text: '' }
  })
  let skillDenial: string | undefined
  let skillRejection: string | undefined
  // Stands for the Skill tool, which expands the command's markdown with the args it is given, and for its permission check.
  on('tool.call', { tool: 'Skill' }, async (_, e) => {
    skills.push({ skill: e.skill, args: e.args })
    if (isDownstreamBroken) throw new Error('Skill tool failed')
    // A person's No at the permission prompt comes back as an error result, not as a deny.
    if (skillRejection !== undefined) return { isError: true, result: {}, text: skillRejection }
    return skillDenial === undefined ? { result: {} } : { deny: skillDenial }
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
  const denySkill = (text: string) => {
    skillDenial = text
  }
  const rejectSkill = (text: string) => {
    skillRejection = text
  }
  const breakDownstream = () => {
    isDownstreamBroken = true
  }
  return { commands, calls, armed, writes, skills, denySkill, rejectSkill, breakDownstream, markdownArgs: () => markdownArgs }
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

test('/ledger:go <backlog parent> the registry misses starts its first child and leaves the parent in the backlog', async ($, on) => {
  const kid = ledgerText('kid', { parent: 'epic' })
  mock.env(on, { HOME: '/home' })
  const w = world(
    on,
    '/repo',
    {},
    {
      [REGISTRY]: registry(backlogEntry('kid', { parent: 'epic' })),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [NEXT('epic')]: exit(0, 'epic kid\n'),
      [PROMOTE('epic')]: promoted('epic'),
      [PROMOTE('kid')]: promoted('kid'),
      [START('epic', 'kid')]: exit(0, `started kid in ${backlogPathOf('epic')}\n`),
    },
    { [backlogPathOf('epic')]: ledgerText('epic', { children: '- kid' }), [backlogPathOf('kid')]: kid, [pathOf('kid')]: kid },
  )

  await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(keys(w.commands)).not.toContain(PROMOTE('epic'))
  expect(keys(w.commands).slice(-2)).toEqual([PROMOTE('kid'), START('epic', 'kid')])
  expect(w.markdownArgs()).toBe(`task: kid\nledger: none\nparent: epic\npromoted: ${WORKTREES}/kid\npicked: epic > kid\nmarked: ${backlogPathOf('epic')}`)
  await expectGoTo($, w, 'kid')
})

test('/ledger:go <backlog parent> the registry misses, with no child left to start, promotes nothing', async ($, on) => {
  mock.env(on, { HOME: '/home' })
  const w = world(
    on,
    '/repo',
    {},
    {
      [REGISTRY]: registry(),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [NEXT('epic')]: exit(0, ''),
      [SHOW('epic')]: shown('epic', [{ slug: 'busy', status: 'active' }, { slug: 'old', status: 'retired' }]),
      [PROMOTE('epic')]: promoted('epic'),
    },
    BACKLOG_PARENT,
  )

  const { text } = await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(text).toContain('Backlog task epic has no child task left to start.')
  expect(keys(w.commands)).not.toContain(PROMOTE('epic'))
  await expectNothingChanged($, w)
})

// The model starts a command through the Skill tool, which raises tool.call and no command.run.
type Via = 'typed' | 'Skill'

async function startVia(via: Via, $: EngineInterface, w: ReturnType<typeof world>, args: string): Promise<{ args?: string; refusal?: string }> {
  if (via === 'typed') {
    const { text } = await $.command.run({ command: 'ledger:go', args })
    const markdownArgs = w.markdownArgs()
    return markdownArgs === undefined ? { refusal: text } : { args: markdownArgs }
  }
  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args })
  return ran.deny === undefined ? { args: w.skills.at(-1)?.args } : { refusal: ran.deny }
}

const IDEA_REPLIES = { [REGISTRY]: registry(backlogEntry('idea')), [COMMON_DIR]: exit(0, '/repo/.git\n'), [PROMOTE('idea')]: promoted('idea') }
const IDEA_FILES = { [backlogPathOf('idea')]: ledgerText('idea'), [pathOf('idea')]: ledgerText('idea') }
const PARKED_API = ledgerText('new-api').replace('## Next step\n', '## Next step\nParked: 2026-10-01 — waiting on the API review\n')

for (const via of ['typed', 'Skill'] as const) {
  test(`/ledger:go ${via} promotes a backlog task, and the session clears at the turn's end`, async ($, on) => {
    const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)

    expect(await startVia(via, $, w, 'idea')).toEqual({ args: `task: idea\nledger: none\npromoted: ${WORKTREES}/idea` })
    expect(w.commands).toEqual([
      { key: REGISTRY, cwd: '/repo' },
      { key: COMMON_DIR, cwd: '/repo' },
      { key: PROMOTE('idea'), cwd: '/repo' },
    ])
    expect(w.armed).toEqual([{ mode: 'go', slug: 'idea' }])
    await expectGoTo($, w, 'idea')
  })

  test(`/ledger:go ${via} from a removed worktree runs the registry in the nearest folder that still exists`, async ($, on) => {
    const gone = `${WORKTREES}/gone`
    const w = world(on, gone, {}, IDEA_REPLIES, IDEA_FILES, gone)

    expect(await startVia(via, $, w, 'idea')).toEqual({ args: `task: idea\nledger: none\npromoted: ${WORKTREES}/idea` })
    expect(w.commands).toEqual([
      { key: REGISTRY, cwd: WORKTREES },
      { key: COMMON_DIR, cwd: WORKTREES },
      { key: PROMOTE('idea'), cwd: WORKTREES },
    ])
    await expectGoTo($, w, 'idea')
  })

  test(`/ledger:go ${via} to a parent task starts its first child not yet started`, async ($, on) => {
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

    expect(await startVia(via, $, w, 'epic')).toEqual({
      args: `task: kid\nledger: ${pathOf('epic')}\nparent: epic\npromoted: ${WORKTREES}/kid\npicked: epic > kid\nmarked: ${pathOf('epic')}`,
    })
    expect(w.armed).toEqual([{ mode: 'go', slug: 'kid', ledger: pathOf('epic') }])
    await expectGoTo($, w, 'kid')
  })

  test(`/ledger:go ${via} to a parked task removes the marker`, async ($, on) => {
    const w = world(on, '/repo', { [pathOf('new-api')]: PARKED_API }, {})

    expect(await startVia(via, $, w, 'new-api')).toEqual({ args: 'task: new-api\nledger: none\nparked: 2026-10-01 — waiting on the API review' })
    expect(w.writes).toEqual([pathOf('new-api')])
    await expectGoTo($, w, 'new-api')
  })

  test(`/ledger:go ${via} refuses with the script message when promotion fails, and arms nothing`, async ($, on) => {
    const w = world(on, '/repo', {}, { ...IDEA_REPLIES, [PROMOTE('idea')]: exit(1, '', 'branch already exists: idea\n') }, IDEA_FILES)

    const { refusal } = await startVia(via, $, w, 'idea')

    expect(refusal).toBe(`Could not start backlog task idea. branch already exists: idea. ${UNCHANGED}`)
    expect(w.skills).toEqual([])
    await expectNothingChanged($, w)
  })

  test(`/ledger:go ${via} names the new worktree when reading its ledger fails, and arms nothing`, async ($, on) => {
    const w = world(on, '/repo', {}, IDEA_REPLIES, { [backlogPathOf('idea')]: ledgerText('idea') })

    const { refusal } = await startVia(via, $, w, 'idea')

    expect(refusal).toStartWith(`Promoted backlog task idea: its branch, worktree and ledger are at ${WORKTREES}/idea. Then this failed: `)
    expect(refusal).toContain('ENOENT')
    expect(w.skills).toEqual([])
    await expectNothingChanged($, w)
  })

  test(`/ledger:go ${via} clears nothing when a later handler throws after the clear was armed`, async ($, on) => {
    const w = world(on, '/repo', { [pathOf('solo')]: ledgerText('solo') }, {})
    w.breakDownstream()

    await startVia(via, $, w, 'solo').catch(() => undefined)

    expect(w.armed).toEqual([{ mode: 'go', slug: 'solo' }])
    await $.turn.complete(turnEnd)
    expect(w.calls).toEqual([])
  })

  test(`a second /ledger:go ${via} in one turn is refused, and the turn still switches to the first task`, async ($, on) => {
    const w = world(on, '/repo', { [pathOf('solo')]: ledgerText('solo') }, IDEA_REPLIES, IDEA_FILES)
    await $.command.run({ command: 'ledger:go', args: 'solo' })

    const refusal =
      via === 'typed'
        ? (await $.command.run({ command: 'ledger:go', args: 'idea' })).text
        : (await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'idea' })).deny

    expect(refusal).toBe(
      'This turn already switches to task solo, so /ledger:go idea was not started and nothing was written. A turn switches tasks only once: run /ledger:go idea after the session clears.',
    )
    expect(w.commands).toEqual([])
    expect(w.skills).toEqual([])
    expect(w.markdownArgs()).toBe('task: solo\nledger: none')
    expect(w.armed).toEqual([{ mode: 'go', slug: 'solo' }])
    await expectGoTo($, w, 'solo')
  })
}

/** Starts /ledger:go without waiting for it. It answers with its refusal or denial, or with undefined when it started. */
function goStarted(via: Via, $: EngineInterface, args: string): Promise<string | undefined> {
  if (via === 'typed') return $.command.run({ command: 'ledger:go', args }).then(({ text }) => text || undefined)
  return $.tool.call({ tool: 'Skill', skill: 'ledger:go', args }).then(({ deny }) => deny)
}

const REFUSED_WHILE_IDEA_STARTS =
  'This turn already switches to task idea, so /ledger:go new-api was not started and nothing was written. A turn switches tasks only once: run /ledger:go new-api after the session clears.'

for (const [first, second] of [['typed', 'Skill'], ['Skill', 'Skill']] as const) {
  test(`a /ledger:go ${second} that overlaps a /ledger:go ${first} still starting is refused, and changes nothing`, async ($, on) => {
    const w = world(on, '/repo', { [pathOf('new-api')]: PARKED_API }, IDEA_REPLIES, IDEA_FILES)

    const answers = await Promise.all([goStarted(first, $, 'idea'), goStarted(second, $, 'new-api')])

    expect(answers).toEqual([undefined, REFUSED_WHILE_IDEA_STARTS])
    expect(keys(w.commands)).toEqual([REGISTRY, COMMON_DIR, PROMOTE('idea')])
    expect(w.writes).toEqual([])
    expect([...w.skills.map(({ args }) => args), w.markdownArgs()].filter(Boolean)).toEqual([`task: idea\nledger: none\npromoted: ${WORKTREES}/idea`])
    expect(w.armed).toEqual([{ mode: 'go', slug: 'idea' }])
    await expectGoTo($, w, 'idea')
  })
}

test('a Skill call of ledger:go refused while an overlapping /ledger:go starts leaves that switch armed when its own Skill call would be denied', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('new-api')]: PARKED_API }, IDEA_REPLIES, IDEA_FILES)
  w.denySkill('The user rejected this skill.')

  const answers = await Promise.all([goStarted('typed', $, 'idea'), goStarted('Skill', $, 'new-api')])

  expect(answers).toEqual([undefined, REFUSED_WHILE_IDEA_STARTS])
  expect(w.skills).toEqual([])
  expect(w.armed).toEqual([{ mode: 'go', slug: 'idea' }])
  await expectGoTo($, w, 'idea')
})

for (const second of ['typed', 'Skill'] as const) {
  test(`a Skill call of ledger:go denied after an overlapping /ledger:go ${second} was refused disarms only its own switch`, async ($, on) => {
    const w = world(on, '/repo', { [pathOf('new-api')]: PARKED_API }, IDEA_REPLIES, IDEA_FILES)
    w.denySkill('The user rejected this skill.')

    const answers = await Promise.all([goStarted('Skill', $, 'idea'), goStarted(second, $, 'new-api')])

    expect(answers).toEqual([
      `Promoted backlog task idea: its branch, worktree and ledger are at ${WORKTREES}/idea. Then the Skill call was denied: The user rejected this skill. The session was not cleared.`,
      REFUSED_WHILE_IDEA_STARTS,
    ])
    expect(keys(w.commands)).toEqual([REGISTRY, COMMON_DIR, PROMOTE('idea')])
    expect(w.writes).toEqual([])
    expect(w.markdownArgs()).toBe(undefined)
    expect(w.armed).toEqual([{ mode: 'go', slug: 'idea' }])
    await $.turn.complete(turnEnd)
    expect(w.calls).toEqual([])
  })
}

test('a Skill call of ledger:go after /ledger:next in the same turn is refused, and the turn still continues the old task', async ($, on) => {
  const w = world(on, `${WORKTREES}/old`, { [pathOf('old')]: ledgerText('old') }, IDEA_REPLIES, IDEA_FILES)
  on('command.run', { command: 'ledger:next' }, async () => ({ text: '' }))
  await $.command.run({ command: 'ledger:next', args: '' })

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'idea' })

  expect(ran.deny).toBe(
    'This turn already ends with /ledger:next, which clears the session and continues task old, so /ledger:go idea was not started and nothing was written. A turn switches tasks only once: run /ledger:go idea after the session clears.',
  )
  expect(w.commands).toEqual([])
  expect(w.skills).toEqual([])
  expect(w.armed).toEqual([{ mode: 'next', slug: 'old', ledger: pathOf('old') }])
  await expectGoTo($, w, 'old')
})

test('the Skill tool names ledger:go with a leading slash too', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)

  await $.tool.call({ tool: 'Skill', skill: ' /ledger:go', args: 'idea' })

  expect(w.skills).toEqual([{ skill: ' /ledger:go', args: `task: idea\nledger: none\npromoted: ${WORKTREES}/idea` }])
  await expectGoTo($, w, 'idea')
})

test('a Skill call of ledger:go that is denied after the hook ran disarms the clear, and names the promoted worktree', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)
  w.denySkill('The user rejected this skill.')

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'idea' })

  expect(w.skills).toEqual([{ skill: 'ledger:go', args: `task: idea\nledger: none\npromoted: ${WORKTREES}/idea` }])
  expect(ran.deny).toBe(
    `Promoted backlog task idea: its branch, worktree and ledger are at ${WORKTREES}/idea. Then the Skill call was denied: The user rejected this skill. The session was not cleared.`,
  )
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
})

test('a Skill call of ledger:go that is denied after the hook ran names the parked marker it removed and the parent it marked', async ($, on) => {
  const parkedChild = ledgerText('child-a', { parent: 'epic' }).replace('## Next step\n', '## Next step\nParked: 2026-10-01 — waiting on review\n')
  const w = world(on, '/repo', { ...CHILD_IN_WORKTREE, [pathOf('child-a')]: parkedChild }, {
    [START('epic', 'child-a')]: exit(0, `started child-a in ${pathOf('epic')}\n`),
  })
  w.denySkill('The user rejected this skill.')

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'child-a' })

  expect(ran.deny).toBe(
    `Removed the parked marker from child-a. Marked child-a started in ${pathOf('epic')}. Then the Skill call was denied: The user rejected this skill. The session was not cleared.`,
  )
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
})

test('a Skill call of ledger:go that the person rejects after the hook ran disarms the clear, and names the promoted worktree in the result and the log', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)
  w.rejectSkill("The user doesn't want to proceed with this tool use.")

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'idea' })

  const message = `Promoted backlog task idea: its branch, worktree and ledger are at ${WORKTREES}/idea. Then the Skill call was denied: The user doesn't want to proceed with this tool use. The session was not cleared.`
  expect(ran.isError).toBe(true)
  expect(ran.text).toBe(message)
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([`log: ${message}`])
})

test('a Skill call of ledger:go that the person rejects before it changed anything passes the rejection on unchanged', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('solo')]: ledgerText('solo') }, {})
  w.rejectSkill("The user doesn't want to proceed with this tool use.")

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'solo' })

  expect(ran.isError).toBe(true)
  expect(ran.text).toBe("The user doesn't want to proceed with this tool use.")
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
})

test('a Skill call of ledger:go that is denied before it changed anything passes the denial on unchanged', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('solo')]: ledgerText('solo') }, {})
  w.denySkill('The user rejected this skill.')

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'solo' })

  expect(ran.deny).toBe('The user rejected this skill.')
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
})

// Known limit, pinned so a change shows: a hook's $.state.get returns its own last write here, so disarm cannot see
// the /ledger:next arm and clears it too. Unverified in the engine; the cost is one missed clear. Wanted: that clear stays.
test('known limit: a Skill call of ledger:go denied after /ledger:next armed its clear meanwhile also clears that clear', async ($, on) => {
  const pending = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  // Registered before the world's Skill tool, so the Skill call of ledger:go waits beneath the plugin until released.
  on('tool.call', { tool: 'Skill' }, async (_, e, next) => {
    pending.resolve()
    await released.promise
    return next(e)
  })
  const w = world(on, `${WORKTREES}/old`, { [pathOf('old')]: ledgerText('old'), [pathOf('solo')]: ledgerText('solo') }, {})
  on('command.run', { command: 'ledger:next' }, async () => ({ text: '' }))
  w.denySkill('The user rejected this skill.')

  const call = $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'solo' })
  await pending.promise
  await $.command.run({ command: 'ledger:next', args: '' })
  released.resolve()
  const ran = await call

  expect(ran.deny).toBe('The user rejected this skill.')
  expect(w.armed).toEqual([
    { mode: 'go', slug: 'solo', ledger: pathOf('old') },
    { mode: 'next', slug: 'old', ledger: pathOf('old') },
  ])
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
})

test('a Skill call without a skill name passes through unchanged', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)

  const ran = await $.tool.call({ tool: 'Skill', args: 'idea' })

  expect(ran.deny).toBe(undefined)
  expect(w.skills).toEqual([{ skill: undefined, args: 'idea' }])
  expect(w.commands).toEqual([])
})

test('a Skill call of another skill passes through unchanged', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)
  const skills = ['ledger:update', 'ledger:task', 'frontend-design']

  for (const skill of skills) await $.tool.call({ tool: 'Skill', skill, args: 'idea' })

  expect(w.skills).toEqual(skills.map(skill => ({ skill, args: 'idea' })))
  expect(w.commands).toEqual([])
  expect(w.armed).toEqual([])
})

test('a Skill call of another skill that throws after /ledger:go leaves the switch armed', async ($, on) => {
  const w = world(on, '/repo', { [pathOf('solo')]: ledgerText('solo') }, {})
  await $.command.run({ command: 'ledger:go', args: 'solo' })
  w.breakDownstream()

  // The harness answers a throwing test hook with its own HooksError, not the Skill tool's error, so only rejection is asserted.
  await expect($.tool.call({ tool: 'Skill', skill: 'frontend-design', args: 'idea' })).rejects.toThrow()

  expect(w.skills).toEqual([{ skill: 'frontend-design', args: 'idea' }])
  await expectGoTo($, w, 'solo')
})

test('a Skill call of another skill that throws after /ledger:next leaves the clear armed', async ($, on) => {
  const w = world(on, `${WORKTREES}/old`, { [pathOf('old')]: ledgerText('old') }, {})
  on('command.run', { command: 'ledger:next' }, async () => ({ text: '' }))
  await $.command.run({ command: 'ledger:next', args: '' })
  w.breakDownstream()

  // The harness answers a throwing test hook with its own HooksError, not the Skill tool's error, so only rejection is asserted.
  await expect($.tool.call({ tool: 'Skill', skill: 'frontend-design', args: 'idea' })).rejects.toThrow()

  expect(w.skills).toEqual([{ skill: 'frontend-design', args: 'idea' }])
  await expectGoTo($, w, 'old')
})

for (const args of ['task: idea', 'ledger: none']) {
  test(`a Skill call of ledger:go with args "${args}" is refused, and asks for a slug`, async ($, on) => {
    const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)

    const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args })

    expect(ran.deny).toBe(
      args === 'task: idea'
        ? `/ledger:go takes a task slug, such as idea, not the task: and ledger: lines it writes itself. ${UNCHANGED}`
        : `/ledger:go takes a task slug, such as <slug>, not the task: and ledger: lines it writes itself. ${UNCHANGED}`,
    )
    expect(w.skills).toEqual([])
    expect(w.commands).toEqual([])
    await expectNothingChanged($, w)
  })
}

test('a Skill call of ledger:go with args in the task: and ledger: form is refused, and asks for a slug', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: `task: idea\nledger: none\npromoted: ${WORKTREES}/idea` })

  expect(ran.deny).toBe(`/ledger:go takes a task slug, such as idea, not the task: and ledger: lines it writes itself. ${UNCHANGED}`)
  expect(w.skills).toEqual([])
  expect(w.commands).toEqual([])
  await expectNothingChanged($, w)
})

test('a typed /ledger:go whose args the hook already wrote passes through unchanged', async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)
  const args = `task: idea\nledger: none\npromoted: ${WORKTREES}/idea`

  await $.command.run({ command: 'ledger:go', args })

  expect(w.markdownArgs()).toBe(args)
  expect(w.commands).toEqual([])
  expect(w.armed).toEqual([])
})

test("a subagent's Skill call of ledger:go is refused, because only the main session can switch tasks", async ($, on) => {
  const w = world(on, '/repo', {}, IDEA_REPLIES, IDEA_FILES)

  const ran = await $.tool.call({ tool: 'Skill', skill: 'ledger:go', args: 'idea', agentId: 'a1' })

  expect(ran.deny).toBe(`Only the main session can switch tasks with /ledger:go. ${UNCHANGED}`)
  expect(w.skills).toEqual([])
  expect(w.commands).toEqual([])
  await expectNothingChanged($, w)
})

const LIB_WORKTREE = '/lib/.claude/worktrees/parser'
const PROMOTE_IN = (main: string, slug: string) => `bin/cc-task-new --repo ${main} --promote ${slug}`
const promotedIn = (main: string, slug: string): Reply =>
  exit(0, `worktree ${main}/.claude/worktrees/${slug}\nbranch   ${slug}\nbase     origin/main @ abc1234\nledger   ${main}/.claude/worktrees/${slug}/.claude/ledger.md\n`)
const EPIC_WITH_LIB_CHILD = { [pathOf('epic')]: ledgerText('epic', { children: '- busy\n- parser @ /lib' }) }
const staysHere = (child: string, worktree: string) =>
  `The session was not cleared and stays here, because a session cannot move to another repository. To continue in ${child}, this session sends a subagent to work in ${worktree}, by its absolute path. The operator can also open a session there and type go ${child}.`

for (const via of ['typed', 'Skill'] as const) {
  test(`/ledger:go <parent> (${via}) promotes a picked child in another repository there, marks it started, and does not move the session`, async ($, on) => {
    const w = world(on, `${WORKTREES}/epic`, EPIC_WITH_LIB_CHILD, {
      [NEXT('epic')]: exit(0, 'epic parser@/lib\n'),
      [PROMOTE_IN('/lib', 'parser')]: promotedIn('/lib', 'parser'),
      [START('epic', 'parser@/lib')]: exit(0, `started parser@/lib in ${pathOf('epic')}\n`),
    })

    const { refusal } = await startVia(via, $, w, 'epic')

    expect(refusal).toBe(
      `Picked child task parser of epic. It belongs to the repository at /lib, so it was promoted there: its branch, worktree and ledger are at ${LIB_WORKTREE}. Marked parser started in ${pathOf('epic')}. ${staysHere('parser', LIB_WORKTREE)}`,
    )
    expect(w.commands).toEqual([NEXT('epic'), PROMOTE_IN('/lib', 'parser'), START('epic', 'parser@/lib')].map(key => ({ key, cwd: `${WORKTREES}/epic` })))
    await expectNothingChanged($, w)
  })
}

test('/ledger:go <parent> names the parent in another repository of a picked grandchild there, and passes on a failed mark', async ($, on) => {
  const w = world(on, '/repo', EPIC_WITH_LIB_CHILD, {
    [NEXT('epic')]: exit(0, 'epic phase@/lib leaf@/lib\n'),
    [PROMOTE_IN('/lib', 'leaf')]: promotedIn('/lib', 'leaf'),
    [START('phase@/lib', 'leaf@/lib')]: exit(1, '', 'boom\n'),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(text).toBe(
    `Picked child task leaf of phase @ /lib. It belongs to the repository at /lib, so it was promoted there: its branch, worktree and ledger are at /lib/.claude/worktrees/leaf. Could not mark leaf started in its parent phase @ /lib: boom. ${staysHere('leaf', '/lib/.claude/worktrees/leaf')}`,
  )
  await expectNothingChanged($, w)
})

test('/ledger:go <parent> says why a picked child in another repository could not be promoted, and changes nothing else', async ($, on) => {
  const w = world(on, '/repo', EPIC_WITH_LIB_CHILD, {
    [NEXT('epic')]: exit(0, 'epic parser@/lib\n'),
    [PROMOTE_IN('/lib', 'parser')]: exit(1, '', 'branch already exists: parser\n'),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'epic' })

  expect(text).toBe(`Could not start backlog task parser @ /lib. branch already exists: parser. ${UNCHANGED}`)
  expect(keys(w.commands)).toEqual([NEXT('epic'), PROMOTE_IN('/lib', 'parser')])
  await expectNothingChanged($, w)
})

const PLAN = '## Plan\n| # | step | status | owner | note |\n|---|------|--------|-------|------|\n| 1 | build | done | me | |\n\n'
const childLedger = (parent: string, status = 'done'): string =>
  ledgerText('child-a', { parent }).replace('## Next step', PLAN.replace('| done |', `| ${status} |`) + '## Next step')
const RETIRE_LINE = 'Task child-a is finished. Run `/ledger:retire child-a --dry-run` to see what blocks retiring it.'
const KID_LINE = 'Parent epic has a child task that has not started: kid. Start it with `/ledger:go epic`.'

async function nextFromChild($: EngineInterface, on: On, ledger: string, replies: Record<string, Reply>) {
  const w = world(on, `${WORKTREES}/child-a`, { [pathOf('child-a')]: ledger }, replies)
  on('command.run', { command: 'ledger:next' }, async () => ({ text: '' }))
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)
  return w
}

const nextChildCases: [name: string, parent: string, next: Reply, line: string][] = [
  ['names the child task that has not started', 'epic', exit(0, 'epic kid\n'), KID_LINE],
  ['names the leaf under a nested parent', 'epic', exit(0, 'epic phase kid\n'), KID_LINE],
  ['says when no child task is left to start', 'epic', exit(0, 'epic\n'), 'Parent epic has no child task left to start.'],
  [
    'names a parent in another repository as it is typed',
    'epic @ /lib',
    exit(0, 'epic@/lib kid@/lib\n'),
    'Parent epic@/lib has a child task that has not started: kid@/lib. Start it with `/ledger:go epic@/lib`.',
  ],
]

for (const [name, parent, next, line] of nextChildCases) {
  test(`/ledger:next on a finished child task ${name}, after the retire line`, async ($, on) => {
    const argument = parent.replace(' @ ', '@')
    const w = await nextFromChild($, on, childLedger(parent), { [NEXT(argument)]: next })

    expect(w.calls).toEqual(['clear', `log: ${RETIRE_LINE}`, `log: ${line}`, 'submit: go child-a'])
    expect(w.commands.filter(({ key }) => key === NEXT(argument))).toEqual([{ key: NEXT(argument), cwd: `${WORKTREES}/child-a` }])
  })
}

test('/ledger:next on a finished child task logs only the retire line when the parent lookup fails', async ($, on) => {
  const w = await nextFromChild($, on, childLedger('epic'), { [NEXT('epic')]: exit(1, '', 'no parent epic\n') })

  expect(w.calls).toEqual(['clear', `log: ${RETIRE_LINE}`, 'submit: go child-a'])
})

test('/ledger:next on a child task with open steps looks up no parent', async ($, on) => {
  const w = await nextFromChild($, on, childLedger('epic', 'todo'), { [NEXT('epic')]: exit(0, 'epic kid\n') })

  expect(w.calls).toEqual(['clear', 'submit: go child-a'])
  expect(keys(w.commands)).not.toContain(NEXT('epic'))
})

test('/ledger:next on a finished task without a parent logs only the retire line', async ($, on) => {
  const w = await nextFromChild($, on, childLedger('epic').replace('- parent: epic\n', ''), {})

  expect(w.calls).toEqual(['clear', `log: ${RETIRE_LINE}`, 'submit: go child-a'])
  expect(keys(w.commands).filter(key => key.startsWith('bin/cc-ledger-parent'))).toEqual([])
})

test('/ledger:go from a finished child task logs only the retire line and looks up no next child', async ($, on) => {
  const w = world(
    on,
    `${WORKTREES}/child-a`,
    { [pathOf('child-a')]: childLedger('epic'), [pathOf('other')]: ledgerText('other') },
    { [NEXT('epic')]: exit(0, 'epic kid\n') },
  )

  await $.command.run({ command: 'ledger:go', args: 'other' })
  await $.turn.complete(turnEnd)

  expect(w.calls).toEqual(['clear', `log: ${RETIRE_LINE}`, 'submit: go other'])
  expect(keys(w.commands)).not.toContain(NEXT('epic'))
})
