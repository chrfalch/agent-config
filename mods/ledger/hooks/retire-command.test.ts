import type { EngineInterface, On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { isoDate } from './ledger'
import { RETIRE_USAGE } from './retire'
import { retireLedger } from './retire-command'

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
const LEDGER_BACKLOG = ['bash', 'hooks/ledger-list.sh', 'backlog']
const retireScript = (...rest: string[]): string[] => ['bash', 'bin/cc-worktree-retire', ...rest]

const SCRIPT_OUTPUT = 'archived /Users/me/.claude/ledger-archive/repo/2026-10-05-fix-login.md\nremoved  /repo/.claude/worktrees/fix-login\n'
const DELETED_OUTPUT = `${SCRIPT_OUTPUT}deleted  branch me/fix-login\n`

const HEAD = 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe'
const mergedPr = (headRefOid: string): Reply => ok(JSON.stringify([{ number: 24, headRefOid }]))

type WorktreeReplies = { status?: Reply; branch?: Reply; head?: Reply; originHead?: Reply; ahead?: Reply; gh?: Reply; dirs?: Reply; aheadOf?: string }

function worktreeReplies(worktree: string, branch: string, overrides: WorktreeReplies = {}): Replies {
  const git = (...args: string[]) => ['git', '-C', worktree, ...args]
  return replies(
    [git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'), overrides.dirs ?? ok(`/repo/.git/worktrees/${branch.split('/').at(-1)}\n/repo/.git\n`)],
    [git('status', '--porcelain'), overrides.status ?? ok('')],
    [git('branch', '--show-current'), overrides.branch ?? ok(`${branch}\n`)],
    [git('rev-parse', '--verify', '--quiet', 'HEAD'), overrides.head ?? ok(`${HEAD}\n`)],
    [git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), overrides.originHead ?? ok('origin/main\n')],
    [git('rev-list', '--count', `origin/main..${overrides.aheadOf ?? HEAD}`), overrides.ahead ?? ok('0\n')],
    [['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid'], overrides.gh ?? ok('[]')],
  )
}

/** `removed` is a folder fs.stat no longer finds, as after /ledger:retire removed the worktree. `files` replaces a ledger's whole text. */
type Setup = {
  cwd: string
  ledgers?: string[]
  titles?: Record<string, string>
  files?: Record<string, string>
  replies?: Replies
  removed?: string
  /** Worktrees whose .claude/evidence/ folder holds a file. */
  evidence?: string[]
}

function world(
  on: On,
  { cwd, ledgers = [ledgerOf(FIX_LOGIN), ledgerOf(NEW_API)], titles = {}, files = {}, replies: extra = {}, removed, evidence = [] }: Setup,
): Call[] {
  const calls: Call[] = []
  const known: Replies = {
    ...replies([LEDGER_LIST, ok(ledgers.join('\n'))], [LEDGER_BACKLOG, ok('')], [retireScript(FIX_LOGIN), ok(SCRIPT_OUTPUT)], [retireScript(FIX_LOGIN, '--force'), ok(SCRIPT_OUTPUT)],
      [retireScript(FIX_LOGIN, '--delete-branch', HEAD), ok(DELETED_OUTPUT)],
      [retireScript(FIX_LOGIN, '--delete-branch', HEAD, '--force'), ok(DELETED_OUTPUT)],
    ),
    ...worktreeReplies(FIX_LOGIN, 'me/fix-login'),
    ...worktreeReplies(NEW_API, 'me/new-api'),
    ...extra,
  }
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e: { argv: string[]; init?: { cwd?: string } }) => {
    calls.push({ argv: e.argv, cwd: e.init?.cwd })
    return known[argvKey(e.argv)] ?? { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async (_, e) =>
    e.path === removed ? { deny: `ENOENT: no such file or directory, stat '${e.path}'` } : { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } },
  )
  on('fs.list', async (_, e: { path: string }) =>
    evidence.some(worktree => e.path === `${worktree}/.claude/evidence`)
      ? { value: [{ name: 'xcodebuild-red.log', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }
      : { deny: `ENOENT: no such file or directory, scandir '${e.path}'` },
  )
  on('fs.read', async (_, e) => {
    const file = files[e.path]
    if (file !== undefined) return { value: file }
    const title = titles[e.path] ?? (e.path === ledgerOf(FIX_LOGIN) ? 'fast-steps' : 'new-api')
    return { value: `# Task ledger — ${title}\n\n## Goal\nSomething.\n` }
  })
  return calls
}

const ranScript = (calls: Call[]): Call[] => calls.filter(({ argv }) => argv[1]?.endsWith('/bin/cc-worktree-retire'))

const NEEDS_FORCE = 'Retiring it needs --force: its branch is not merged. Run `/ledger:retire fast-steps --force` to retire it anyway.'

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

test('/ledger:retire <slug> --dry-run shows the plan for that task and runs only read-only commands', async ($, on) => {
  const calls = world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'new-api --dry-run' })
  const lines = text.split('\n')
  expect(lines[0]).toBe('**Retire new-api** — nothing done yet')
  expect(lines[1]).toBe(`- worktree: ${NEW_API}`)
  expect(lines[2]).toBe('- branch: me/new-api · no commits ahead · no merged PR')
  expect(lines[3]).toBe('- uncommitted changes: none')
  expect(lines[4]).toMatch(/^- archive: ~\/\.claude\/ledger-archive\/repo\/\d{4}-\d{2}-\d{2}-new-api\.md$/)
  expect(lines.at(-1)).toBe('Run `/ledger:retire new-api` to retire it.')
  expect(ranScript(calls)).toEqual([])
  expect(calls.filter(({ argv }) => argv[0] === 'git').every(({ cwd }) => cwd === NEW_API)).toBe(true)
})

test('/ledger:retire <slug> --dry-run lists the evidence folder it would archive, and copies nothing', async ($, on) => {
  const calls = world(on, { cwd: REPO, evidence: [NEW_API] })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'new-api --dry-run' })
  expect(text.split('\n')[5]).toMatch(
    /^- evidence: \/repo\/\.claude\/worktrees\/new-api\/\.claude\/evidence\/ is copied to ~\/\.claude\/ledger-archive\/repo\/\d{4}-\d{2}-\d{2}-new-api\/$/,
  )
  expect(ranScript(calls)).toEqual([])
  expect(calls.every(({ argv }) => argv[0] === 'git' || argv[0] === 'gh' || argv[1]?.endsWith('hooks/ledger-list.sh'))).toBe(true)
})

test('/ledger:retire <slug> --dry-run of a worktree without evidence names no evidence folder', async ($, on) => {
  world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'new-api --dry-run' })
  expect(text).not.toContain('evidence')
})

test('/ledger:retire --dry-run without a slug in a task worktree plans that task', async ($, on) => {
  world(on, { cwd: `${FIX_LOGIN}/src`, ledgers: [ledgerOf(FIX_LOGIN)] })
  const { text } = await $.command.run({ command: 'ledger:retire', args: '--dry-run' })
  expect(text.split('\n')[0]).toBe('**Retire fast-steps** — nothing done yet')
})

test('/ledger:retire refuses a ledger in the main checkout', async ($, on) => {
  const dirs = ok('/repo/.claude/worktrees/fix-login/.git\n/repo/.claude/worktrees/fix-login/.git\n')
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { dirs }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --force' })
  expect(text).toBe(`${FIX_LOGIN} is the main checkout, not a linked worktree. /ledger:retire removes only linked worktrees.`)
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire stops when a git command fails', async ($, on) => {
  const status = exit(128, '', 'fatal: index corrupt')
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toBe(`Could not read the state of ${FIX_LOGIN}. git status --porcelain failed (exit 128): fatal: index corrupt`)
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire counts commits against main when origin/HEAD is not set', async ($, on) => {
  const originHead = exit(128, '', 'fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')
  world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { originHead, ahead: ok('1\n'), gh: ok('[{"number":24}]') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(text.split('\n')[2]).toBe('- branch: me/fix-login · 1 commit ahead of origin/main · merged PR #24')
})

test('/ledger:retire --dry-run still plans when git cannot compare with origin, and counts the branch as unmerged', async ($, on) => {
  const ahead = exit(128, '', "fatal: bad revision 'origin/main..HEAD'\n")
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  const lines = text.split('\n')
  expect(lines[2]).toBe("- branch: me/fix-login · could not compare with origin/main: fatal: bad revision 'origin/main..HEAD' · no merged PR")
  expect(lines.at(-1)).toBe(NEEDS_FORCE)
  const refused = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(refused.text).toContain('Not retired: its branch is not merged.')
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire retires when git cannot compare with origin but the PR is merged', async ($, on) => {
  const ahead = exit(128, '', "fatal: bad revision 'origin/main..HEAD'")
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead, gh: mergedPr(HEAD) }) })
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--delete-branch', HEAD]])
})

test('/ledger:retire keeps the branch when git cannot compare with origin and the merged PR ends elsewhere', async ($, on) => {
  const ahead = exit(128, '', "fatal: bad revision 'origin/main..HEAD'")
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead, gh: mergedPr('0ld0001') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN]])
  expect(text.split('\n').at(-1)).toBe('- kept branch me/fix-login, because it has commits that are not in its merged PR')
})

test('/ledger:retire counts unmerged work when gh cannot be asked, and shows why', async ($, on) => {
  const gh = exit(4, '', 'gh auth login required')
  world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n'), gh }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(text).toContain('could not check PRs: gh pr list failed (exit 4): gh auth login required')
  expect(text.split('\n').at(-1)).toBe(NEEDS_FORCE)
})

test('/ledger:retire on a clean, merged worktree runs the script from the main checkout', async ($, on) => {
  const calls = world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toBe(
    [
      '**Retired fast-steps**',
      '- archived /Users/me/.claude/ledger-archive/repo/2026-10-05-fix-login.md',
      '- removed  /repo/.claude/worktrees/fix-login',
      '- deleted  branch me/fix-login',
    ].join('\n'),
  )
  const [script, ...more] = ranScript(calls)
  expect(more).toEqual([])
  expect(script?.argv.slice(2)).toEqual([FIX_LOGIN, '--delete-branch', HEAD])
  expect(script?.argv[1]?.endsWith('/../../bin/cc-worktree-retire')).toBe(true)
  expect(script?.cwd).toBe(REPO)
})

test('/ledger:retire --yes retires the same way as no flag', async ($, on) => {
  const calls = world(on, { cwd: REPO })
  const plain = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  const yes = await $.command.run({ command: 'ledger:retire', args: '--yes fast-steps' })
  expect(yes.text).toBe(plain.text)
  const [first, second, ...more] = ranScript(calls)
  expect(more).toEqual([])
  expect(second).toEqual(first)
})

test('/ledger:retire --dry-run --force on blocked work only shows the plan', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status: ok(' M a.ts\n'), ahead: ok('2\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run --force' })
  expect(text.split('\n')[0]).toBe('**Retire fast-steps** — nothing done yet')
  expect(text.split('\n').at(-1)).toBe(
    'Retiring it needs --force: it has 1 uncommitted change and its branch is not merged. Run `/ledger:retire fast-steps --force` to retire it anyway.',
  )
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire refuses uncommitted changes without --force', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status: ok(' M a.ts\n?? b.ts\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toBe('Not retired: it has 2 uncommitted changes. Add --force to retire it anyway. Uncommitted changes are lost with the worktree.')
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire refuses an unmerged branch without --force', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toContain('Not retired: its branch is not merged.')
  expect(ranScript(calls)).toEqual([])
})

test('/ledger:retire retires commits ahead when their PR is merged', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n'), gh: mergedPr(HEAD) }) })
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--delete-branch', HEAD]])
})

test('/ledger:retire deletes the branch when any of its merged PRs ends at HEAD', async ($, on) => {
  const gh = ok(JSON.stringify([{ number: 31, headRefOid: '0ld0001' }, { number: 24, headRefOid: HEAD }]))
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n'), gh }) })
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--delete-branch', HEAD]])
})

test('/ledger:retire counts commits ahead at the HEAD it read, so a commit that lands later cannot change the check', async ($, on) => {
  const git = (...args: string[]) => ['git', '-C', FIX_LOGIN, ...args]
  const movedSinceRead = replies([git('rev-list', '--count', 'origin/main..HEAD'), ok('3\n')])
  const calls = world(on, { cwd: REPO, replies: { ...worktreeReplies(FIX_LOGIN, 'me/fix-login'), ...movedSinceRead } })
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--delete-branch', HEAD]])
})

test('/ledger:retire retires the worktree but keeps a branch with commits after its PR merged', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('3\n'), gh: mergedPr('0ld0001') }) })
  const plan = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(plan.text.split('\n')).toContain('- local branch: me/fix-login is kept, because it has commits that are not in its merged PR')
  expect(plan.text.split('\n').at(-1)).toBe('Run `/ledger:retire fast-steps` to retire it.')
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN]])
  expect(text.split('\n').at(-1)).toBe('- kept branch me/fix-login, because it has commits that are not in its merged PR')
})

const UNBORN: WorktreeReplies = { head: exit(1, '', ''), aheadOf: 'HEAD', ahead: exit(128, '', "fatal: ambiguous argument 'origin/main..HEAD'") }

test('/ledger:retire on a branch with no commits yet needs --force and keeps the branch', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', UNBORN) })
  const plan = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(plan.text.split('\n')).toContain('- local branch: me/fix-login is kept, because it has no commits yet')
  expect(plan.text.split('\n').at(-1)).toBe(NEEDS_FORCE)
  const refused = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(refused.text).toContain('Not retired: its branch is not merged.')
  expect(ranScript(calls)).toEqual([])
  await $.command.run({ command: 'ledger:retire', args: 'fast-steps --force' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--force']])
})

test('/ledger:retire keeps a branch with no commits yet even when a merged PR reports no head', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ...UNBORN, gh: mergedPr('') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN]])
  expect(text.split('\n').at(-1)).toBe('- kept branch me/fix-login, because it has no commits yet')
})

test('/ledger:retire --force passes --force to the script', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status: ok(' M a.ts\n'), ahead: ok('2\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --force' })
  expect(text.split('\n')[0]).toBe('**Retired fast-steps**')
  expect(text.split('\n').at(-1)).toBe('- kept branch me/fix-login, because it is not merged')
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--force']])
})

test('/ledger:retire reports a script that fails, with what it printed first', async ($, on) => {
  const failed = exit(128, 'archived /a.md\n', "fatal: '/repo/.claude/worktrees/fix-login' contains modified or untracked files\n")
  world(on, { cwd: REPO, replies: replies([retireScript(FIX_LOGIN, '--delete-branch', HEAD), failed]) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).toBe(
    ["cc-worktree-retire failed (exit 128): fatal: '/repo/.claude/worktrees/fix-login' contains modified or untracked files", '- archived /a.md'].join('\n'),
  )
})

test('/ledger:retire from inside the worktree says the session lost its working directory', async ($, on) => {
  world(on, { cwd: `${FIX_LOGIN}/src`, ledgers: [ledgerOf(FIX_LOGIN)] })
  const { text } = await $.command.run({ command: 'ledger:retire', args: '' })
  expect(text.split('\n')[0]).toBe('**Retired fast-steps**')
  expect(text.split('\n').at(-1)).toBe(
    "This session's working directory was removed with the worktree. Continue another task with /ledger:go <slug>, or run /ledger:close.",
  )
})

test('/ledger:retire from a session folder removed earlier looks up ledgers from the folder above it', async ($, on) => {
  const gone = '/repo/.claude/worktrees/gone'
  const calls = world(on, { cwd: gone, removed: gone })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text.split('\n')[0]).toBe('**Retired fast-steps**')
  expect(text).not.toContain('working directory')
  expect(calls.filter(({ argv }) => argv[1]?.endsWith('/hooks/ledger-list.sh')).map(({ cwd }) => cwd)).toEqual(['/repo/.claude/worktrees'])
})

test('/ledger:retire from the main checkout leaves out the working directory note', async ($, on) => {
  world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps' })
  expect(text).not.toContain('working directory')
})

test('/ledger:retire <slug> --dry-run says the merged branch is deleted', async ($, on) => {
  world(on, { cwd: REPO })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'new-api --dry-run' })
  expect(text.split('\n')).toContain('- local branch: me/new-api is deleted, because it is merged')
})

test('/ledger:retire <slug> --dry-run says an unmerged branch is kept', async ($, on) => {
  world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { ahead: ok('2\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(text.split('\n')).toContain('- local branch: me/fix-login is kept, because it is not merged')
})

test('/ledger:retire --force on a merged branch with uncommitted changes still deletes the branch', async ($, on) => {
  const calls = world(on, { cwd: REPO, replies: worktreeReplies(FIX_LOGIN, 'me/fix-login', { status: ok(' M a.ts\n') }) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --force' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[FIX_LOGIN, '--delete-branch', HEAD, '--force']])
  expect(text).not.toContain('kept branch')
})

// The test kit's `$` drives commands, so a direct call gets an engine that answers only what retireLedger may use.
function fakeEngine(known: Replies): { engine: EngineInterface; calls: Call[] } {
  const calls: Call[] = []
  const engine = {
    process: {
      run: async (argv: string[], init?: { cwd?: string }) => {
        calls.push({ argv, cwd: init?.cwd })
        const reply = known[argvKey(argv)]
        if (reply === undefined || 'deny' in reply) throw new Error(`unexpected command: ${JSON.stringify(argv)}`)
        return reply.value
      },
    },
    session: { cwd: async () => REPO },
    plugin: { root: '/plugins/ledger' },
  }
  return { engine: engine as unknown as EngineInterface, calls }
}

test('retireLedger retires the worktree of the ledger it is given, without looking up its slug', async () => {
  const { engine, calls } = fakeEngine({
    ...worktreeReplies(FIX_LOGIN, 'me/fix-login'),
    ...worktreeReplies(NEW_API, 'me/new-api'),
    ...replies([retireScript(NEW_API, '--delete-branch', HEAD), ok('removed  /repo/.claude/worktrees/new-api\n')]),
  })
  const text = await retireLedger(engine, 'fast-steps', ledgerOf(NEW_API), { dryRun: false, forced: false })
  expect(text.split('\n')[0]).toBe('**Retired fast-steps**')
  expect(ranScript(calls).map(({ argv }) => argv[2])).toEqual([NEW_API])
})

const IDEA = '/home/.claude/ledger-backlog/repo/idea.md'
const IDEA_OUTPUT = `archived /home/.claude/ledger-archive/repo/2026-10-21-idea.md\nremoved  ${IDEA}\n`

function backlogWorld(on: On, extra: Replies = {}, files: Record<string, string> = {}): Call[] {
  return world(on, {
    cwd: REPO,
    titles: { [IDEA]: 'idea' },
    files,
    replies: { ...replies([LEDGER_BACKLOG, ok(`${IDEA}\n`)], [retireScript(IDEA), ok(IDEA_OUTPUT)], [retireScript(IDEA, '--force'), ok(IDEA_OUTPUT)]), ...extra },
  })
}

test('/ledger:retire <slug> --dry-run of a backlog task shows what it archives, and that there is no worktree or branch', async ($, on) => {
  const calls = backlogWorld(on)
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'idea --dry-run' })
  expect(text).toBe(
    [
      '**Retire idea** — nothing done yet',
      `- backlog ledger: ${IDEA}`,
      `- archive: ~/.claude/ledger-archive/repo/${isoDate(new Date())}-idea.md`,
      '- then: the backlog ledger is deleted. A backlog task has no worktree or branch to remove.',
      '',
      'Run `/ledger:retire idea` to retire it.',
    ].join('\n'),
  )
  expect(calls.map(({ argv }) => argv[0])).toEqual(['bash', 'bash'])
})

test('/ledger:retire <slug> of a backlog task runs the script on its ledger and reports what it did', async ($, on) => {
  const calls = backlogWorld(on)
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'idea' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[IDEA]])
  expect(text).toBe(['**Retired idea**', '- archived /home/.claude/ledger-archive/repo/2026-10-21-idea.md', `- removed  ${IDEA}`].join('\n'))
})

test('/ledger:retire <slug> --force of a backlog task passes --force to the script', async ($, on) => {
  const calls = backlogWorld(on)
  await $.command.run({ command: 'ledger:retire', args: 'idea --force' })
  expect(ranScript(calls).map(({ argv }) => argv.slice(2))).toEqual([[IDEA, '--force']])
})

test('/ledger:retire <slug> of a backlog parent with active children passes on the refusal', async ($, on) => {
  backlogWorld(on, replies([retireScript(IDEA), exit(1, '', 'idea has active children: child-a. Retire them first, or pass --force.\n')]))
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'idea' })
  expect(text).toBe('cc-worktree-retire failed (exit 1): idea has active children: child-a. Retire them first, or pass --force.')
})

test('/ledger:retire <slug> names a worktree task before it looks in the backlog', async ($, on) => {
  const calls = backlogWorld(on)
  await $.command.run({ command: 'ledger:retire', args: 'new-api --dry-run' })
  expect(calls.some(({ argv }) => argv[2] === 'backlog')).toBe(false)
})

test('/ledger:retire with an unknown slug says when the backlog could not be checked', async ($, on) => {
  world(on, { cwd: REPO, replies: replies([LEDGER_BACKLOG, exit(1, '', 'boom')]) })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'nope' })
  expect(text).toStartWith('No task ledger is named "nope". Nothing was retired. Task ledgers: fast-steps, new-api.')
  expect(text).toContain('The backlog could not be checked: ')
  expect(text).toEndWith('boom.')
})

const withChildren = (slug: string, children: string): string => `# Task ledger — ${slug}\n\n## Goal\nSomething.\n\n## Children\n${children}`

test('/ledger:retire <slug> --dry-run of a backlog parent with active children names them and says it needs --force', async ($, on) => {
  backlogWorld(on, {}, { [IDEA]: withChildren('idea', '- child-a\n- old (retired 2026-10-01)\n- child-b\n') })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'idea --dry-run' })
  expect(text.split('\n').at(-1)).toBe(
    'Retiring it needs --force: it has active children (child-a, child-b). Run `/ledger:retire idea --force` to retire it anyway.',
  )
})

test('/ledger:retire <slug> --dry-run of a worktree parent with an active child names it and says it needs --force', async ($, on) => {
  world(on, { cwd: REPO, files: { [ledgerOf(FIX_LOGIN)]: withChildren('fast-steps', '- child-a\n') } })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(text.split('\n').at(-1)).toBe(
    'Retiring it needs --force: it has an active child (child-a). Run `/ledger:retire fast-steps --force` to retire it anyway.',
  )
})

test('/ledger:retire <slug> --dry-run of a parent whose children are all retired needs no --force', async ($, on) => {
  world(on, { cwd: REPO, files: { [ledgerOf(FIX_LOGIN)]: withChildren('fast-steps', '- child-a (retired 2026-10-01)\n') } })
  const { text } = await $.command.run({ command: 'ledger:retire', args: 'fast-steps --dry-run' })
  expect(text.split('\n').at(-1)).toBe('Run `/ledger:retire fast-steps` to retire it.')
})
