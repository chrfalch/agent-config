import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { RETIRE_USAGE } from './retire'

type Reply = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: false; isStderrTruncated: false } } | { deny: string }

const ok = (stdout: string): Reply => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const exit = (exitCode: number, stdout: string, stderr: string): Reply => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

type Replies = Record<string, Reply>
type Call = { argv: string[]; cwd?: string }

// A bash script is keyed by its folder and name, because the plugin root differs from machine to machine.
const argvKey = (argv: readonly string[]): string =>
  JSON.stringify(argv[0] === 'bash' ? ['bash', (argv[1] ?? '').split('/').slice(-2).join('/'), ...argv.slice(2)] : argv)

const replies = (...entries: [argv: string[], reply: Reply][]): Replies => Object.fromEntries(entries.map(([argv, reply]) => [argvKey(argv), reply]))

const REPO = '/repo'
const FIX_LOGIN = '/repo/.claude/worktrees/fix-login'
const NEW_API = '/repo/.claude/worktrees/new-api'
const ledgerOf = (worktree: string): string => `${worktree}/.claude/ledger.md`

const LEDGER_LIST = ['bash', 'hooks/ledger-list.sh', 'paths']
const retireScript = (...rest: string[]): string[] => ['bash', 'bin/cc-worktree-retire', ...rest]

const SCRIPT_OUTPUT = 'archived /Users/me/.claude/ledger-archive/repo/2026-10-05-fix-login.md\nremoved  /repo/.claude/worktrees/fix-login\n'

type WorktreeReplies = { status?: Reply; branch?: Reply; originHead?: Reply; ahead?: Reply; gh?: Reply; dirs?: Reply }

function worktreeReplies(worktree: string, branch: string, overrides: WorktreeReplies = {}): Replies {
  const git = (...args: string[]) => ['git', '-C', worktree, ...args]
  return replies(
    [git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'), overrides.dirs ?? ok(`/repo/.git/worktrees/${branch.split('/').at(-1)}\n/repo/.git\n`)],
    [git('status', '--porcelain'), overrides.status ?? ok('')],
    [git('branch', '--show-current'), overrides.branch ?? ok(`${branch}\n`)],
    [git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), overrides.originHead ?? ok('origin/main\n')],
    [git('rev-list', '--count', 'origin/main..HEAD'), overrides.ahead ?? ok('0\n')],
    [['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number'], overrides.gh ?? ok('[]')],
  )
}

type Setup = { cwd: string; ledgers?: string[]; titles?: Record<string, string>; replies?: Replies }

function world(on: On, { cwd, ledgers = [ledgerOf(FIX_LOGIN), ledgerOf(NEW_API)], titles = {}, replies: extra = {} }: Setup): Call[] {
  const calls: Call[] = []
  const known: Replies = {
    ...replies([LEDGER_LIST, ok(ledgers.join('\n'))], [retireScript(FIX_LOGIN), ok(SCRIPT_OUTPUT)], [retireScript(FIX_LOGIN, '--force'), ok(SCRIPT_OUTPUT)]),
    ...worktreeReplies(FIX_LOGIN, 'me/fix-login'),
    ...worktreeReplies(NEW_API, 'me/new-api'),
    ...extra,
  }
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string } }) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd })
    return known[argvKey(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => {
    const title = titles[e.path] ?? (e.path === ledgerOf(FIX_LOGIN) ? 'fast-steps' : 'new-api')
    return { value: `# Task ledger — ${title}\n\n## Goal\nSomething.\n` }
  })
  return calls
}

const ranScript = (calls: Call[]): Call[] => calls.filter(({ argv }) => argv[1]?.endsWith('/bin/cc-worktree-retire'))

test('/ledger:retire with a stray word answers with usage and runs nothing', async ($, on) => {
  const calls = world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps extra' })
  expect(text).toBe(RETIRE_USAGE)
  expect(calls).toEqual([])
})

test('/ledger:retire without a slug outside every task worktree asks for one', async ($, on) => {
  world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire' })
  expect(text).toBe('No task ledger in or above /repo. Give a slug: /ledger:retire <slug>. Run /ledger to see each slug.')
})

test('/ledger:retire without a slug in nested task worktrees names each', async ($, on) => {
  const inner = `${FIX_LOGIN}/.claude/worktrees/inner`
  world(on, { cwd: inner, ledgers: [ledgerOf(FIX_LOGIN), ledgerOf(inner)] })
  const { text } = await $.command.run({ command: 'ledger:retire', args: '' })
  expect(text).toContain('Several task ledgers hold')
  expect(text).toContain('fix-login, inner')
  expect(text).toContain('Nothing was retired.')
  expect(text).not.toContain('session was not cleared')
})

test('/ledger:retire reports a ledger lookup that fails', async ($, on) => {
  world(on, { cwd: REPO, replies: replies([LEDGER_LIST, exit(1, '', 'not a repository')]) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toContain('Could not list task ledgers.')
  expect(text).toContain('not a repository')
})

test('/ledger:retire with an unknown slug lists the slugs there are', async ($, on) => {
  world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'nope' })
  expect(text).toContain('No task ledger is named "nope".')
  expect(text).toContain('fast-steps, new-api')
  expect(text).toContain('Nothing was retired.')
  expect(text).not.toContain('session was not cleared')
})

test('/ledger:retire with a slug two ledgers share names both paths', async ($, on) => {
  world(on, { cwd: REPO, titles: { [ledgerOf(NEW_API)]: 'fast-steps' } })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toContain('Several task ledgers are named "fast-steps"')
  expect(text).toContain(ledgerOf(NEW_API))
  expect(text).toContain('Nothing was retired.')
  expect(text).not.toContain('session was not cleared')
})

test('/ledger:retire <slug> shows the plan for that task and runs only read-only commands', async ($, on) => {
  const calls = world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'new-api' })
  const lines = text.split('\n')
  expect(lines[0]).toBe('**Retire new-api** — nothing done yet')
  expect(lines[1]).toBe(`- worktree: ${NEW_API}`)
  expect(lines[2]).toBe('- branch: me/new-api · no commits ahead · no merged PR')
  expect(lines[3]).toBe('- uncommitted changes: none')
  expect(lines[4]).toMatch(/^- archive: ~\/\.claude\/ledger-archive\/repo\/\d{4}-\d{2}-\d{2}-new-api\.md$/)
  expect(lines.at(-1)).toBe('Add --yes to retire it.')
  expect(ranScript(calls)).toEqual([])
  expect(calls.filter(({ argv }) => argv[0] === 'git').every(({ cwd }) => cwd === NEW_API)).toBe(true)
})

test('/ledger:retire without a slug in a task worktree plans that task', async ($, on) => {
  world(on, { cwd: `${FIX_LOGIN}/src`, ledgers: [ledgerOf(FIX_LOGIN)] })
  const { text } = await $.command.run({ command: 'ledger:retire', args: '' })
  expect(text.split('\n')[0]).toBe('**Retire fast-steps** — nothing done yet')
})

test('/ledger:retire refuses a ledger in the main checkout', async ($, on) => {
  const dirs = ok('/repo/.claude/worktrees/fix-login/.git\n/repo/.claude/worktrees/fix-login/.git\n')
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { dirs }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes --force' })
  expect(text).toBe(`${FIX_LOGIN} is the main checkout, not a linked worktree. /ledger:retire removes only linked worktrees.`)
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire stops when a git command fails', async ($, on) => {
  const status = exit(128, '', 'fatal: index corrupt')
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(text).toBe(`Could not read the state of ${FIX_LOGIN}. git status --porcelain failed (exit 128): fatal: index corrupt`)
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire counts commits against main when origin/HEAD is not set', async ($, on) => {
  const originHead = exit(128, '', 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')
  world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { originHead, ahead: ok('1\n'), gh: ok('[{"number":24}]') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text.split('\n')[2]).toBe('- branch: me/fix-login · 1 commit ahead of origin/main · merged PR #24')
})

test('/ledger:retire still plans when git cannot compare with origin, and counts the branch as unmerged', async ($, on) => {
  const ahead = exit(128, '', "fatal: bad revision 'origin/main..HEAD'\n")
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  const lines = text.split('\n')
  expect(lines[2]).toBe("- branch: me/fix-login · could not compare with origin/main: fatal: bad revision 'origin/main..HEAD' · no merged PR")
  expect(lines.at(-1)).toBe('Add --yes --force to retire it: its branch is not merged')
  const refused = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(refused.text).toContain('Not retired: its branch is not merged.')
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire --yes retires when git cannot compare with origin but the PR is merged', async ($, on) => {
  const ahead = exit(128, '', "fatal: bad revision 'origin/main..HEAD'")
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead, gh: ok('[{"number":24}]') }) })
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN]])
})

test('/ledger:retire counts unmerged work when gh cannot be asked, and shows why', async ($, on) => {
  const gh = exit(4, '', 'gh auth login required')
  world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n'), gh }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toContain('could not check PRs: gh pr list failed (exit 4): gh auth login required')
  expect(text.split('\n').at(-1)).toBe('Add --yes --force to retire it: its branch is not merged')
})

test('/ledger:retire --yes on a clean, merged worktree runs the script from the main checkout', async ($, on) => {
  const calls = world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: '--yes fast-steps' })
  expect(text).toBe(
    [
      '**Retired fast-steps**',
      '- archived /Users/me/.claude/ledger-archive/repo/2026-10-05-fix-login.md',
      '- removed  /repo/.claude/worktrees/fix-login',
    ].join('\n'),
  )
  const [script, ...more] = ranScript(calls)
  expect(more).toEqual([])
  expect(script?.argv.slice(2)).toEqual([FIX_LOGIN])
  expect(script?.argv[1]?.endsWith('/../../bin/cc-worktree-retire')).toBe(true)
  expect(script?.cwd).toBe(REPO)
})

test('/ledger:retire --yes refuses uncommitted changes without --force', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status: ok(' M a.ts\n?? b.ts\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(text).toBe('Not retired: it has 2 uncommitted changes. Add --force to retire it anyway. Uncommitted changes are lost with the worktree.')
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire --yes refuses an unmerged branch without --force', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(text).toContain('Not retired: its branch is not merged.')
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire --yes retires commits ahead when their PR is merged', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n'), gh: ok('[{"number":24}]') }) })
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN]])
})

test('/ledger:retire --yes --force passes --force to the script', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status: ok(' M a.ts\n'), ahead: ok('2\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --force --yes' })
  expect(text.split('\n')[0]).toBe('**Retired fast-steps**')
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--force']])
})

test('/ledger:retire --yes reports a script that fails, with what it printed first', async ($, on) => {
  const failed = exit(128, 'archived /a.md\n', "fatal: '/repo/.claude/worktrees/fix-login' contains modified or untracked files\n")
  world(on, { cwd: REPO, replies: replies([retireScript(FIX_LOGIN), failed]) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(text).toBe(
    ["cc-worktree-retire failed (exit 128): fatal: '/repo/.claude/worktrees/fix-login' contains modified or untracked files", '- archived /a.md'].join('\n'),
  )
})

test('/ledger:retire --yes from inside the worktree says the session lost its working directory', async ($, on) => {
  world(on, { cwd: `${FIX_LOGIN}/src`, ledgers: [ledgerOf(FIX_LOGIN)] })
  const { text } = await $.command.run({ command: 'ledger:retire', args: '--yes' })
  expect(text.split('\n')[0]).toBe('**Retired fast-steps**')
  expect(text.split('\n').at(-1)).toBe(
    "This session's working directory was removed with the worktree. Continue another task with /ledger:go <slug>, or run /ledger:close.",
  )
})

test('/ledger:retire --yes from the main checkout leaves out the working directory note', async ($, on) => {
  world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --yes' })
  expect(text).not.toContain('working directory')
})
