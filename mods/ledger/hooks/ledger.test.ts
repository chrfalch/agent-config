import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { activeLedger, folderSlug, format, formatAll, ledgerPaths, lookupFailedMessage, retireHint, summarize } from './ledger'

const LEDGER = `# Task ledger — fast-steps

## Goal
Prototype two ideas.

## Plan (approved 2026-10-08)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | baseline runs | done, result negative | me | |
| 2 | runner: tsc | todo | runner | |

## Next step
Ask user: commit + PR.
`

test('the current step is the first plan row that is not done', () => {
  expect(summarize(LEDGER, 'folder', 0)).toEqual({
    slug: 'fast-steps',
    editedMs: 0,
    goal: 'Prototype two ideas.',
    current: { number: '2', step: 'runner: tsc', status: 'todo' },
    next: 'Ask user: commit + PR.',
  })
})

test('a plan with every row done says so', () => {
  const done = LEDGER.replace('| todo |', '| done |')
  expect(summarize(done, 'folder', 0).current).toBe('all done')
})

test('a title without a slug uses the folder name', () => {
  expect(summarize('# Task ledger\n- item\n', 'folder', 0).slug).toBe('folder')
  expect(summarize('# Task ledger — \n', 'folder', 0).slug).toBe('folder')
})

test('a title with a hyphen still gives the slug', () => {
  expect(summarize('# Task ledger - foo\n', 'folder', 0).slug).toBe('foo')
})

test('format draws a heading and one bullet per field, leaving out empty ones', () => {
  const ledger = { slug: 's', editedMs: new Date(2026, 9, 9, 8, 5).getTime(), goal: '', current: { number: '2', step: 'tsc', status: 'todo' }, next: '' }
  expect(format(ledger)).toBe('#### s · edited 2026-10-09 08:05\n- **Now:** step 2 · tsc — *todo*')
})

test('formatAll counts the ledgers above them', () => {
  const ledger = { slug: 's', editedMs: 0, goal: 'g', current: null, next: 'n' }
  expect(formatAll([ledger, ledger]).split('\n')[0]).toBe('**Task ledgers** · 2 ledgers, newest first')
})

test('ledgerPaths keeps each non-empty line of the script output, trimmed', () => {
  expect(ledgerPaths('/a/.claude/ledger.md\n  /b/wt/.claude/ledger.md \n\n')).toEqual(['/a/.claude/ledger.md', '/b/wt/.claude/ledger.md'])
})

test('ledgerPaths finds no ledgers in empty output', () => {
  expect(ledgerPaths('')).toEqual([])
  expect(ledgerPaths('\n')).toEqual([])
})

test('folderSlug names the folder that holds .claude/ledger.md', () => {
  expect(folderSlug('/a/b/wt/.claude/ledger.md')).toBe('wt')
  expect(folderSlug('/x/repo with spaces/.claude/ledger.md')).toBe('repo with spaces')
})

test('/ledger reports a lookup script that cannot run instead of failing', async ($, on) => {
  on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', async () => ({ deny: 'spawn bash ENOENT' }))
  const { text } = await $.command.run({ command: 'ledger' })
  expect(text).toContain('Could not list task ledgers.')
  expect(text).toContain('spawn bash ENOENT')
})

const WORKTREES = '/repo/.claude/worktrees'
const FIX_LOGIN = `${WORKTREES}/fix-login/.claude/ledger.md`
const NEW_API = `${WORKTREES}/new-api/.claude/ledger.md`

test('activeLedger finds none when cwd is outside every worktree', () => {
  expect(activeLedger([FIX_LOGIN, NEW_API], '/repo')).toEqual({ kind: 'none' })
  expect(activeLedger([FIX_LOGIN], `${WORKTREES}/fix-login-2`)).toEqual({ kind: 'none' })
  expect(activeLedger([], '/repo')).toEqual({ kind: 'none' })
})

test('activeLedger finds the ledger of the worktree cwd is in or under', () => {
  expect(activeLedger([FIX_LOGIN, NEW_API], `${WORKTREES}/fix-login`)).toEqual({ kind: 'one', path: FIX_LOGIN })
  expect(activeLedger([FIX_LOGIN, NEW_API], `${WORKTREES}/new-api/src/lib`)).toEqual({ kind: 'one', path: NEW_API })
})

test('activeLedger reports several when nested worktrees both hold cwd', () => {
  const nested = `${WORKTREES}/fix-login/.claude/worktrees/inner/.claude/ledger.md`
  expect(activeLedger([FIX_LOGIN, nested], `${WORKTREES}/fix-login/.claude/worktrees/inner`)).toEqual({
    kind: 'several',
    paths: [FIX_LOGIN, nested],
  })
})

type World = {
  /** clear, ui.log and prompt.submit, in the order they ran. */
  calls: string[]
  /** Every git and gh command run. */
  commands: string[][]
  isMarkdownReached: () => boolean
  markdownArgs: () => string | undefined
  /** Replaces the text of the FIX_LOGIN ledger, as the model does when it writes the ledger. */
  writeLedger: (text: string) => void
}

type Broken = 'spawn' | 'lookup' | 'read' | 'markdown' | 'clear' | 'submit'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const exit = (exitCode: number, stdout: string, stderr = ''): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})
const ok = (stdout: string): Reply => exit(0, stdout)

type Replies = Record<string, Reply>

// The ledger at NEW_API has no slug in its title, so its slug is its folder name; every other ledger is fast-steps.
const UNTITLED = LEDGER.replace('# Task ledger — fast-steps', '# Task ledger')

function world(on: On, cwd: string, ledgers: string[], command: string, broken?: Broken, replies: Replies = {}): World {
  const calls: string[] = []
  const commands: string[][] = []
  let isMarkdownReached = false
  let markdownArgs: string | undefined
  let fixLogin = LEDGER
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e) => {
    if (e.argv[0] !== 'bash') {
      commands.push([...e.argv])
      return replies[JSON.stringify(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
    }
    if (broken === 'spawn') return { deny: 'spawn bash ENOENT' }
    return broken === 'lookup' ? exit(1, '', 'not a repository') : ok(ledgers.join('\n'))
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => {
    if (broken === 'read') return { deny: 'EACCES: ledger unreadable' }
    return { value: e.path === NEW_API ? UNTITLED : e.path === FIX_LOGIN ? fixLogin : LEDGER }
  })
  on('command.run', { command }, async (_, e) => {
    isMarkdownReached = true
    markdownArgs = e.args
    if (broken === 'markdown') throw new Error('markdown command failed')
    return { text: '' }
  })
  on('command.run', { command: 'clear' }, async () => {
    calls.push('clear')
    if (broken === 'clear') throw new Error('clear refused')
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => {
    calls.push(`submit: ${e.text}`)
    if (broken === 'submit') throw new Error('submit refused')
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
    isMarkdownReached: () => isMarkdownReached,
    markdownArgs: () => markdownArgs,
    writeLedger: text => {
      fixLogin = text
    },
  }
}

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('/ledger:close outside a task worktree answers with why, and clears nothing', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, '/repo', [FIX_LOGIN], 'ledger:close')
  const { text } = await $.command.run({ command: 'ledger:close', args: '' })
  expect(text).toContain('/repo')
  expect(text).toContain('/ledger:task')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:close in several nested worktrees names each and clears nothing', async ($, on) => {
  const inner = `${WORKTREES}/fix-login/.claude/worktrees/inner`
  const { calls, isMarkdownReached } = world(on, inner, [FIX_LOGIN, `${inner}/.claude/ledger.md`], 'ledger:close')
  const { text } = await $.command.run({ command: 'ledger:close', args: '' })
  expect(text).toContain('fix-login')
  expect(text).toContain('inner')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:close in a task worktree runs the command, then clears after the answer', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:close')
  await $.command.run({ command: 'ledger:close', args: '' })
  expect(isMarkdownReached()).toBe(true)
  expect(calls).toEqual([])
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear'])
})

test('/ledger:next clears, then submits go <slug> from the ledger title', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login/src`, [FIX_LOGIN], 'ledger:next')
  await $.command.run({ command: 'ledger:next', args: '' })
  expect(isMarkdownReached()).toBe(true)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go fast-steps'])
})

test('an interrupted turn disarms without clearing', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:next')
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete({ ...turnEnd, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  expect(calls).toEqual([])
})

test('a subagent turn ending leaves the command armed', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:close')
  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete({ ...turnEnd, agentId: 'a1' })
  expect(calls).toEqual([])
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear'])
})

test('a command that fails after the ledger was found clears nothing', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:next', 'markdown')
  await $.command.run({ command: 'ledger:next', args: '' }).catch(() => undefined)
  expect(isMarkdownReached()).toBe(true)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

for (const command of ['ledger:close', 'ledger:next']) {
  test(`/${command} reports a failed ledger lookup and clears nothing`, async ($, on) => {
    const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], command, 'lookup')
    const { text } = await $.command.run({ command, args: '' })
    const [before, after] = lookupFailedMessage('|').split('|')
    expect(text.startsWith(before)).toBe(true)
    expect(text.endsWith(after)).toBe(true)
    expect(text).toContain('failed (exit 1): not a repository')
    expect(isMarkdownReached()).toBe(false)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([])
  })

  test(`/${command} reports a lookup script that cannot run and clears nothing`, async ($, on) => {
    const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], command, 'spawn')
    const { text } = await $.command.run({ command, args: '' })
    expect(text.startsWith("Could not check this task's ledger.")).toBe(true)
    expect(text).toContain('did not run')
    expect(text).toContain('spawn bash ENOENT')
    expect(isMarkdownReached()).toBe(false)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([])
  })
}

test('a failure before the command runs answers with the reason and stays disarmed', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:next', 'read')
  const { text } = await $.command.run({ command: 'ledger:next', args: '' })
  expect(text.startsWith("Could not check this task's ledger.")).toBe(true)
  expect(text).toContain('EACCES: ledger unreadable')
  expect(text).not.toContain('[object Object]')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:close names the failed clear and does not ask for go', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:close', 'clear')
  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)
  expect(calls.slice(0, -1)).toEqual(['clear'])
  expect(calls.at(-1)).toMatch(/^log: \/ledger:close could not clear the session: .+\. Run \/clear\.$/)
})

test('/ledger:next names the failed clear and asks for go <slug>', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:next', 'clear')
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)
  expect(calls.slice(0, -1)).toEqual(['clear'])
  expect(calls.at(-1)).toMatch(/^log: \/ledger:next could not clear the session: .+\. Run \/clear, then say: go fast-steps\.$/)
})

test('/ledger:next names the failed prompt after the clear worked', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN], 'ledger:next', 'submit')
  await $.command.run({ command: 'ledger:next', args: '' })
  await $.turn.complete(turnEnd)
  expect(calls.slice(0, -1)).toEqual(['clear', 'submit: go fast-steps'])
  expect(calls.at(-1)).toMatch(/^log: \/ledger:next cleared the session but could not send "go fast-steps": .+\. Say: go fast-steps\.$/)
})

test('/ledger:help prints one line per /ledger command, in order, without a model turn', async ($, on) => {
  const { isMarkdownReached } = world(on, '/repo', [], 'ledger:help')
  const { text } = await $.command.run({ command: 'ledger:help', args: '' })
  const commands = text.split('\n').map(line => line.match(/^- `(\/ledger[^`]*)` — \S/)?.[1])
  expect(commands).toEqual([
    '/ledger',
    '/ledger:task',
    '/ledger:update',
    '/ledger:next',
    '/ledger:close',
    '/ledger:go <slug>',
    '/ledger:park [<slug>] <reason>',
    '/ledger:parent [<slug>]',
    '/ledger:worktrees',
    '/ledger:retire [<slug>]',
    '/ledger:archive [<term>]',
    '/ledger:all',
    '/ledger:help',
  ])
  expect(isMarkdownReached()).toBe(false)
})

for (const args of ['', '   ']) {
  test(`/ledger:go with ${args ? 'only spaces' : 'no slug'} prints the usage and clears nothing`, async ($, on) => {
    const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:go')
    const { text } = await $.command.run({ command: 'ledger:go', args })
    expect(text.startsWith('Usage: /ledger:go <slug>')).toBe(true)
    expect(isMarkdownReached()).toBe(false)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([])
  })
}

test('/ledger:go to a slug no ledger has names the task ledgers and clears nothing', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:go')
  const { text } = await $.command.run({ command: 'ledger:go', args: 'fast' })
  expect(text).toContain('"fast"')
  expect(text).toContain('fast-steps, new-api')
  expect(text).toContain('Nothing was written, and the session was not cleared.')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:go to a slug two ledgers share names both and clears nothing', async ($, on) => {
  const twin = `${WORKTREES}/twin/.claude/ledger.md`
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, twin], 'ledger:go')
  const { text } = await $.command.run({ command: 'ledger:go', args: 'fast-steps' })
  expect(text).toContain(FIX_LOGIN)
  expect(text).toContain(twin)
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:go from a task worktree runs the command, then clears and submits go <target>', async ($, on) => {
  const { calls, isMarkdownReached, markdownArgs } = world(on, `${WORKTREES}/fix-login/src`, [FIX_LOGIN, NEW_API], 'ledger:go')
  const armed: unknown[] = []
  on('state.set', async (_, e, next) => {
    if (e.plugin === 'ledger' && e.key === 'armed') armed.push(e.value)
    return next(e)
  })
  await $.command.run({ command: 'ledger:go', args: '  new-api ' })
  expect(isMarkdownReached()).toBe(true)
  expect(markdownArgs()).toBe(`task: new-api\nledger: ${FIX_LOGIN}`)
  expect(armed).toEqual([{ mode: 'go', slug: 'new-api', ledger: FIX_LOGIN }])
  expect(calls).toEqual([])
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go new-api'])
})

test('/ledger:go outside every task worktree still clears and submits go <target>', async ($, on) => {
  const { calls, isMarkdownReached, markdownArgs } = world(on, '/repo', [FIX_LOGIN, NEW_API], 'ledger:go')
  await $.command.run({ command: 'ledger:go', args: 'fast-steps' })
  expect(isMarkdownReached()).toBe(true)
  expect(markdownArgs()).toBe('task: fast-steps\nledger: none')
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go fast-steps'])
})

test('/ledger:go to the current task behaves like /ledger:next', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:go')
  await $.command.run({ command: 'ledger:go', args: 'fast-steps' })
  expect(isMarkdownReached()).toBe(true)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go fast-steps'])
})

test('/ledger:go in several nested worktrees names each and clears nothing', async ($, on) => {
  const inner = `${WORKTREES}/fix-login/.claude/worktrees/inner`
  const { calls, isMarkdownReached } = world(on, inner, [FIX_LOGIN, `${inner}/.claude/ledger.md`, NEW_API], 'ledger:go')
  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-api' })
  expect(text).toContain('fix-login')
  expect(text).toContain('inner')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:go reports a failed ledger lookup and clears nothing', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:go', 'lookup')
  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-api' })
  expect(text.startsWith("Could not check this task's ledger.")).toBe(true)
  expect(text).toContain('failed (exit 1): not a repository')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:go names the failed clear and asks for go <target>', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:go', 'clear')
  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)
  expect(calls.slice(0, -1)).toEqual(['clear'])
  expect(calls.at(-1)).toMatch(/^log: \/ledger:go could not clear the session: .+\. Run \/clear, then say: go new-api\.$/)
})

test('/ledger:go names the failed prompt after the clear worked', async ($, on) => {
  const { calls } = world(on, `${WORKTREES}/fix-login`, [FIX_LOGIN, NEW_API], 'ledger:go', 'submit')
  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)
  expect(calls.slice(0, -1)).toEqual(['clear', 'submit: go new-api'])
  expect(calls.at(-1)).toMatch(/^log: \/ledger:go cleared the session but could not send "go new-api": .+\. Say: go new-api\.$/)
})

const DONE = LEDGER.replace('| todo |', '| done |')
const MERGED_LINE = 'Task fast-steps is finished and merged. Retire it with `/ledger:retire fast-steps --yes`.'
const OPEN_PR_LINE = 'Task fast-steps is finished. After PR #31 merges, run `/ledger:retire fast-steps --yes`.'
const UNMERGED_LINE = 'Task fast-steps is finished. Run `/ledger:retire fast-steps` to see what blocks retiring it.'

test('retireHint tells a merged task to retire', () => {
  expect(retireHint('fast-steps', { ahead: 0, prs: [] })).toBe(MERGED_LINE)
  expect(retireHint('fast-steps', { ahead: 4, prs: [{ state: 'MERGED', number: 30 }] })).toBe(MERGED_LINE)
})

test('retireHint names the open PR of a task that is not merged', () => {
  expect(retireHint('fast-steps', { ahead: 4, prs: [{ state: 'OPEN', number: 31 }] })).toBe(OPEN_PR_LINE)
})

test('retireHint sends a task with no open or merged PR to the retire dry run', () => {
  expect(retireHint('fast-steps', { ahead: 4, prs: [] })).toBe(UNMERGED_LINE)
  expect(retireHint('fast-steps', { ahead: 4, prs: [{ state: 'CLOSED', number: 29 }] })).toBe(UNMERGED_LINE)
  expect(retireHint('fast-steps', null)).toBe(UNMERGED_LINE)
})

const FIX_LOGIN_TREE = `${WORKTREES}/fix-login`
const fixLoginGit = (...args: string[]): string[] => ['git', '-C', FIX_LOGIN_TREE, ...args]
const FIX_LOGIN_PRS = ['gh', 'pr', 'list', '--head', 'me/fix-login', '--state', 'all', '--json', 'state,number']

function branchReplies({ ahead = ok('2\n'), prs = ok('[]') }: { ahead?: Reply; prs?: Reply } = {}): Replies {
  const entries: [string[], Reply][] = [
    [fixLoginGit('branch', '--show-current'), ok('me/fix-login\n')],
    [fixLoginGit('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), ok('origin/main\n')],
    [fixLoginGit('rev-list', '--count', 'origin/main..HEAD'), ahead],
    [FIX_LOGIN_PRS, prs],
  ]
  return Object.fromEntries(entries.map(([argv, reply]) => [JSON.stringify(argv), reply]))
}

// /ledger:next continues the finished task; /ledger:go here moves from it to new-api.
const continuations = [
  { command: 'ledger:next', args: '', go: 'go fast-steps' },
  { command: 'ledger:go', args: 'new-api', go: 'go new-api' },
]

for (const { command, args, go } of continuations) {
  const finishedCases: [name: string, replies: Replies, line: string][] = [
    ['with no commits ahead of origin', branchReplies({ ahead: ok('0\n') }), MERGED_LINE],
    ['with a merged PR', branchReplies({ prs: ok('[{"state":"MERGED","number":30}]') }), MERGED_LINE],
    ['with an open PR', branchReplies({ prs: ok('[{"state":"OPEN","number":31}]') }), OPEN_PR_LINE],
    ['with no PR', branchReplies(), UNMERGED_LINE],
    ['when gh fails', branchReplies({ prs: exit(1, '', 'gh: not logged in') }), UNMERGED_LINE],
    ['when git cannot run', {}, UNMERGED_LINE],
  ]
  for (const [name, replies, line] of finishedCases) {
    test(`/${command} on a finished task ${name} logs one retire line between the clear and ${go}`, async ($, on) => {
      const { calls, writeLedger } = world(on, FIX_LOGIN_TREE, [FIX_LOGIN, NEW_API], command, undefined, replies)
      writeLedger(DONE)
      await $.command.run({ command, args })
      await $.turn.complete(turnEnd)
      expect(calls).toEqual(['clear', `log: ${line}`, `submit: ${go}`])
    })
  }

  test(`/${command} on a task with open steps logs no retire line and runs no git`, async ($, on) => {
    const { calls, commands } = world(on, FIX_LOGIN_TREE, [FIX_LOGIN, NEW_API], command, undefined, branchReplies({ ahead: ok('0\n') }))
    await $.command.run({ command, args })
    await $.turn.complete(turnEnd)
    expect(calls).toEqual(['clear', `submit: ${go}`])
    expect(commands).toEqual([])
  })

  test(`/${command} reads the ledger again at the end of the turn, after the model finished its last step`, async ($, on) => {
    const { calls, writeLedger } = world(on, FIX_LOGIN_TREE, [FIX_LOGIN, NEW_API], command, undefined, branchReplies({ ahead: ok('0\n') }))
    await $.command.run({ command, args })
    writeLedger(DONE)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual(['clear', `log: ${MERGED_LINE}`, `submit: ${go}`])
  })

  test(`/${command} logs no retire line when the clear fails`, async ($, on) => {
    const { calls, writeLedger } = world(on, FIX_LOGIN_TREE, [FIX_LOGIN, NEW_API], command, 'clear', branchReplies({ ahead: ok('0\n') }))
    writeLedger(DONE)
    await $.command.run({ command, args })
    await $.turn.complete(turnEnd)
    expect(calls.slice(0, -1)).toEqual(['clear'])
    expect(calls.at(-1)).toContain('could not clear the session')
  })
}

test('/ledger:go from outside every task worktree logs no retire line', async ($, on) => {
  const { calls, commands, writeLedger } = world(on, '/repo', [FIX_LOGIN, NEW_API], 'ledger:go', undefined, branchReplies({ ahead: ok('0\n') }))
  writeLedger(DONE)
  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go new-api'])
  expect(commands).toEqual([])
})

test('/ledger:go to the current task logs no retire line', async ($, on) => {
  const { calls, commands, writeLedger } = world(on, FIX_LOGIN_TREE, [FIX_LOGIN, NEW_API], 'ledger:go', undefined, branchReplies({ ahead: ok('0\n') }))
  writeLedger(DONE)
  await $.command.run({ command: 'ledger:go', args: 'fast-steps' })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go fast-steps'])
  expect(commands).toEqual([])
})

test('/ledger:close logs no retire line', async ($, on) => {
  const { calls, writeLedger } = world(on, FIX_LOGIN_TREE, [FIX_LOGIN, NEW_API], 'ledger:close', undefined, branchReplies({ ahead: ok('0\n') }))
  writeLedger(DONE)
  await $.command.run({ command: 'ledger:close', args: '' })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear'])
})
