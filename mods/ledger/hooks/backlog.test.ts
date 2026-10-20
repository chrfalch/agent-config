import type { EngineInterface, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

const WORKTREES = '/repo/.claude/worktrees'
const FIX_LOGIN_TREE = `${WORKTREES}/fix-login`
const FIX_LOGIN = `${FIX_LOGIN_TREE}/.claude/ledger.md`
const PROMOTED = `${WORKTREES}/new-idea/.claude/ledger.md`
const UNCHANGED = 'Nothing was written, and the session was not cleared.'

const ledgerText = (slug: string, next = 'Write the plan.'): string => `# Task ledger — ${slug}\n\n## Goal\nA goal.\n\n## Next step\n${next}\n`

const backlogEntry = (slug: string, extra: Record<string, string> = {}) => ({
  repo: 'repo',
  slug,
  path: `/home/.claude/ledger-backlog/repo/${slug}.md`,
  branch: '',
  status: 'backlog',
  main: '/repo',
  created: '2026-10-01T00:00:00.000Z',
  updated: '2026-10-01T00:00:00.000Z',
  ...extra,
})

const PROMOTE_OUTPUT = `worktree ${WORKTREES}/new-idea\nbranch   new-idea\nbase     origin/main @ abc1234\nledger   ${PROMOTED}\n`

// The scripts are keyed by folder and name, because the plugin root differs from machine to machine.
const scriptKey = (argv: readonly string[]): string => [(argv[0] ?? '').split('/').slice(-2).join('/'), ...argv.slice(1)].join(' ')

const REGISTRY = 'bin/cc-ledgers list --json'
const PROMOTE = (slug: string) => `bin/cc-task-new --promote ${slug}`
const COMMON_DIR = 'git rev-parse --path-format=absolute --git-common-dir'

type Call = { key: string; cwd?: string }

type Options = { promotedLedger?: string; broken?: 'read' | 'write' | 'state' }

function world(on: On, cwd: string, ledgers: string[], replies: Record<string, Reply>, { promotedLedger = ledgerText('new-idea'), broken }: Options = {}) {
  const calls: string[] = []
  const commands: Call[] = []
  const armed: unknown[] = []
  const writes: string[] = []
  let isMarkdownReached = false
  let markdownArgs: string | undefined
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string } }) => {
    if (e.argv[0] === 'bash') return exit(0, ledgers.join('\n'))
    const key = scriptKey(e.argv)
    commands.push({ key, cwd: e.init?.cwd })
    return replies[key] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => {
    if (e.path !== PROMOTED) return { value: ledgerText('fast-steps') }
    return broken === 'read' ? { deny: 'EACCES: ledger unreadable' } : { value: promotedLedger }
  })
  on('fs.write', async (_, e) => {
    if (broken === 'write') return { deny: 'EACCES: ledger read-only' }
    writes.push(e.path)
    return { value: undefined }
  })
  on('state.set', async (_, e, next) => {
    if (broken === 'state' && e.value !== null) return { deny: 'EACCES: state unwritable' }
    if (e.plugin === 'ledger' && e.key === 'armed' && e.value !== null) armed.push(e.value)
    return next(e)
  })
  on('command.run', { command: 'ledger:go' }, async (_, e) => {
    isMarkdownReached = true
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
  return {
    calls,
    commands,
    armed,
    writes,
    isMarkdownReached: () => isMarkdownReached,
    markdownArgs: () => markdownArgs,
  }
}

type World = ReturnType<typeof world>

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

/** A refusal writes no file, arms nothing, runs no markdown command, and neither clears nor submits when the turn ends. */
async function expectNothingChanged($: EngineInterface, w: World): Promise<void> {
  expect(w.writes).toEqual([])
  expect(w.armed).toEqual([])
  expect(w.isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual([])
}

const registry = (...entries: object[]): Reply => exit(0, JSON.stringify(entries))

test('/ledger:go to a backlog task promotes it in this repo, then continues there like any task', async ($, on) => {
  const w = world(on, `${FIX_LOGIN_TREE}/src`, [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea')),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
  })

  await $.command.run({ command: 'ledger:go', args: ' new-idea ' })

  expect(w.commands).toEqual([
    { key: REGISTRY, cwd: undefined },
    { key: COMMON_DIR, cwd: `${FIX_LOGIN_TREE}/src` },
    { key: PROMOTE('new-idea'), cwd: `${FIX_LOGIN_TREE}/src` },
  ])
  expect(w.isMarkdownReached()).toBe(true)
  expect(w.markdownArgs()).toBe(`task: new-idea\nledger: ${FIX_LOGIN}\npromoted: ${WORKTREES}/new-idea`)
  expect(w.armed).toEqual([{ mode: 'go', slug: 'new-idea', ledger: FIX_LOGIN }])
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual(['clear', 'submit: go new-idea'])
})

test('/ledger:go to a backlog task from the main checkout continues with no ledger to write', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea')),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
  })

  await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands).toEqual([
    { key: REGISTRY, cwd: undefined },
    { key: COMMON_DIR, cwd: '/repo' },
    { key: PROMOTE('new-idea'), cwd: '/repo' },
  ])
  expect(w.markdownArgs()).toBe(`task: new-idea\nledger: none\npromoted: ${WORKTREES}/new-idea`)
  expect(w.armed).toEqual([{ mode: 'go', slug: 'new-idea' }])
  await $.turn.complete(turnEnd)
  expect(w.calls).toEqual(['clear', 'submit: go new-idea'])
})

// The same folder name as this session's main checkout, and another one: only the full path decides.
for (const [repo, main] of [
  ['repo', '/elsewhere/repo'],
  ['app', '/elsewhere/app'],
]) {
  test(`/ledger:go to a backlog task whose main checkout is ${main} names it, runs no promotion and clears nothing`, async ($, on) => {
    const w = world(on, `${FIX_LOGIN_TREE}/src`, [FIX_LOGIN], {
      [REGISTRY]: registry(backlogEntry('new-idea', { repo, main })),
      [COMMON_DIR]: exit(0, '/repo/.git\n'),
      [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
    })

    const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

    expect(text).toContain(repo)
    expect(text).toContain(main)
    expect(text).toContain('/ledger:go new-idea')
    expect(text).toContain('from a session in that repository')
    expect(text).toContain(UNCHANGED)
    expect(w.commands.map(call => call.key)).toEqual([REGISTRY, COMMON_DIR])
    await expectNothingChanged($, w)
  })
}

test('/ledger:go promotes when one of several backlog tasks with the slug belongs to this main checkout', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea', { repo: 'app', main: '/elsewhere/app' }), backlogEntry('new-idea')),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
  })

  await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands.map(call => call.key)).toContain(PROMOTE('new-idea'))
  expect(w.markdownArgs()).toBe(`task: new-idea\nledger: none\npromoted: ${WORKTREES}/new-idea`)
})

test('/ledger:go runs the promotion for a backlog task that names no main checkout, and passes on its refusal', async ($, on) => {
  const { main: _, ...noMain } = backlogEntry('new-idea', { main: '' })
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(noMain),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(4, '', 'backlog ledger /home/.claude/ledger-backlog/repo/new-idea.md has no main line\n'),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands.map(call => call.key)).toContain(PROMOTE('new-idea'))
  expect(text).toContain('has no main line')
  await expectNothingChanged($, w)
})

test('/ledger:go when git cannot tell the main checkout runs the promotion, and passes on the script refusing it', async ($, on) => {
  const refusal = 'backlog task new-idea belongs to /elsewhere/repo; run /ledger:go new-idea from a session in that repository'
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea', { main: '/elsewhere/repo' })),
    [COMMON_DIR]: exit(128, '', 'fatal: not a git repository\n'),
    [PROMOTE('new-idea')]: exit(3, '', `${refusal}\n`),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands.map(call => call.key)).toEqual([REGISTRY, COMMON_DIR, PROMOTE('new-idea')])
  expect(text).toContain(refusal)
  expect(text).toContain(UNCHANGED)
  await expectNothingChanged($, w)
})

test('/ledger:go refuses with the script message when promotion fails for another reason', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea')),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(1, '', 'branch already exists: new-idea\n'),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands.map(call => call.key)).toEqual([REGISTRY, COMMON_DIR, PROMOTE('new-idea')])
  expect(text).toContain('new-idea')
  expect(text).toContain('branch already exists: new-idea')
  expect(text).toContain(UNCHANGED)
  await expectNothingChanged($, w)
})

test('/ledger:go refuses when promotion succeeds but names no ledger', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea')),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(0, 'done\n'),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands.map(call => call.key)).toEqual([REGISTRY, COMMON_DIR, PROMOTE('new-idea')])
  expect(text).toContain('new-idea')
  expect(text).toContain('printed no ledger path')
  await expectNothingChanged($, w)
})

for (const { step, broken, promotedLedger } of [
  { step: 'ledger read', broken: 'read', promotedLedger: undefined },
  { step: 'state write', broken: 'state', promotedLedger: undefined },
  { step: 'parked-marker write', broken: 'write', promotedLedger: ledgerText('new-idea', 'Parked: 2026-10-01 — waiting on the API review\nWrite the plan.') },
] as const) {
  test(`/ledger:go names the new worktree when the ${step} after a successful promotion fails`, async ($, on) => {
    const w = world(
      on,
      '/repo',
      [FIX_LOGIN],
      { [REGISTRY]: registry(backlogEntry('new-idea')), [COMMON_DIR]: exit(0, '/repo/.git\n'), [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT) },
      { broken, promotedLedger },
    )

    const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

    expect(text).toContain('Promoted backlog task new-idea')
    expect(text).toContain(`${WORKTREES}/new-idea`)
    expect(text).toContain('EACCES')
    expect(text).not.toContain('Nothing was written')
    await expectNothingChanged($, w)
  })
}

test('/ledger:go with no registry entry for the slug still promotes a backlog ledger the registry missed', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
  })

  await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(w.commands.map(call => call.key)).toContain(PROMOTE('new-idea'))
  expect(w.markdownArgs()).toBe(`task: new-idea\nledger: none\npromoted: ${WORKTREES}/new-idea`)
})

test('/ledger:go with no registry entry and no backlog ledger keeps the unknown-task reply', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(2, '', 'no backlog task new-idea\n'),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(text).toBe(`No task ledger is named "new-idea". ${UNCHANGED} Task ledgers: fast-steps.`)
  expect(w.commands.map(call => call.key)).toContain(PROMOTE('new-idea'))
  await expectNothingChanged($, w)
})

test('/ledger:go with no registry entry passes on the refusal for a backlog ledger of another repo', async ($, on) => {
  const refusal = 'backlog task new-idea belongs to /elsewhere/repo; run /ledger:go new-idea from a session in that repository'
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(),
    [COMMON_DIR]: exit(0, '/repo/.git\n'),
    [PROMOTE('new-idea')]: exit(3, '', `${refusal}\n`),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(text).toContain(refusal)
  expect(text).toContain(UNCHANGED)
  await expectNothingChanged($, w)
})

test('/ledger:go prefers a worktree ledger to a backlog task with the same slug', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('fast-steps')),
    [PROMOTE('fast-steps')]: exit(0, PROMOTE_OUTPUT),
  })

  await $.command.run({ command: 'ledger:go', args: 'fast-steps' })

  expect(w.commands.map(call => call.key)).not.toContain(PROMOTE('fast-steps'))
  expect(w.markdownArgs()).toBe('task: fast-steps\nledger: none')
})

test('/ledger:go does not promote a registry entry that is not in the backlog', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], {
    [REGISTRY]: registry(backlogEntry('new-idea', { status: 'archived' })),
    [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(text).toContain('No task ledger is named "new-idea"')
  expect(w.commands.map(call => call.key)).toEqual([REGISTRY])
  await expectNothingChanged($, w)
})

test('/ledger:go names an unreadable registry when no worktree ledger matches', async ($, on) => {
  const w = world(on, '/repo', [FIX_LOGIN], { [REGISTRY]: exit(1, '', 'cannot read /home/.claude/ledgers.json\n') })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(text).toContain('No task ledger is named "new-idea"')
  expect(text).toContain('cannot read /home/.claude/ledgers.json')
  expect(w.commands.map(call => call.key)).toEqual([REGISTRY])
  await expectNothingChanged($, w)
})

test('/ledger:go in several nested worktrees refuses before it promotes a backlog task', async ($, on) => {
  const inner = `${FIX_LOGIN_TREE}/.claude/worktrees/inner`
  const w = world(on, inner, [FIX_LOGIN, `${inner}/.claude/ledger.md`], {
    [REGISTRY]: registry(backlogEntry('new-idea')),
    [PROMOTE('new-idea')]: exit(0, PROMOTE_OUTPUT),
  })

  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-idea' })

  expect(text).toContain('Several task ledgers hold')
  expect(w.commands.map(call => call.key)).toEqual([REGISTRY])
  await expectNothingChanged($, w)
})

test('/ledger:help says /ledger:task makes only a backlog ledger, and /ledger:go starts it from its repository', async $ => {
  const { text } = await $.command.run({ command: 'ledger:help', args: '' })
  const lines = text.split('\n')
  const task = lines.find(line => line.startsWith('- `/ledger:task`')) ?? ''
  const go = lines.find(line => line.startsWith('- `/ledger:go <slug>`')) ?? ''

  expect(task).toContain('backlog')
  expect(task).toContain('no branch or worktree')
  expect(go).toContain('backlog task')
  expect(go).toContain('its repository')
})
