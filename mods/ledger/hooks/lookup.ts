import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { folderSlug, ledgerPaths, summarize, type BranchState } from './ledger'
import { defaultBranchOf, isInside, parseCount, stateFailedMessage } from './retire'
import { basename, parseWorktrees } from './worktrees'
import { lookUpPrs } from './worktrees-command'

export type Found = { path: string; slug: string; mtimeMs: number }

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type Ran = { stdout: string; stderr: string; failure?: string }

export async function run($: EngineInterface, argv: string[], cwd: string): Promise<Ran> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd })
    return exitCode === 0 ? { stdout, stderr } : { stdout, stderr, failure: `failed (exit ${exitCode}): ${stderr.trim()}` }
  } catch (error) {
    return { stdout: '', stderr: '', failure: `did not run: ${message(error)}` }
  }
}

// The SessionStart hook's own lookup, so /ledger and the hook always agree on which ledgers exist.
export async function findLedgers($: EngineInterface): Promise<Found[] | { error: string }> {
  const script = `${$.plugin.root}/../../hooks/ledger-list.sh`
  const cwd = await $.session.cwd()
  let result: ProcessRunResult
  try {
    result = await $.process.run(['bash', script, 'paths'], { cwd })
  } catch (error) {
    return { error: `${script} did not run: ${message(error)}` }
  }
  const { exitCode, stdout, stderr } = result
  if (exitCode !== 0) return { error: `${script} failed (exit ${exitCode}): ${stderr.trim()}` }
  const found = await Promise.all(
    ledgerPaths(stdout).map(async path => ({ path, slug: folderSlug(path), mtimeMs: (await $.fs.stat(path)).mtimeMs })),
  )
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * Whether `word` names a linked worktree other than the one holding `cwd`: its folder, its branch, or its branch without the owner prefix.
 * False from the main checkout, and when git cannot list the worktrees.
 */
export async function namesOtherWorktree($: EngineInterface, word: string, cwd: string): Promise<boolean> {
  let result: ProcessRunResult
  try {
    result = await $.process.run(['git', 'worktree', 'list', '--porcelain', '-z'], { cwd })
  } catch {
    return false
  }
  if (result.exitCode !== 0) return false
  const worktrees = parseWorktrees(result.stdout)
  // The longest match, because a task worktree can sit inside another one.
  const [own] = worktrees.filter(({ path }) => isInside(cwd, path)).sort((a, b) => b.path.length - a.path.length)
  if (own === undefined) return false
  return worktrees.some(({ path, branch }) => path !== own.path && [basename(path), branch, branch.split('/').at(-1)].includes(word))
}

export type BranchRead = {
  /** Empty on a detached HEAD, as `git branch --show-current` prints it. */
  branch: string
  /** The commit HEAD points at; empty on a branch with no commits yet. */
  head: string
  defaultBranch: string
  /** Commits ahead of origin/<defaultBranch>, or why git could not count them. */
  ahead: number | { error: string }
}

/** The branch checked out in `worktree`, and how far it is ahead of origin's default branch. */
export async function readBranch($: EngineInterface, worktree: string): Promise<BranchRead | { error: string }> {
  const git = (...args: string[]) => run($, ['git', '-C', worktree, ...args], worktree)
  const [branch, head, originHead] = await Promise.all([
    git('branch', '--show-current'),
    git('rev-parse', '--verify', '--quiet', 'HEAD'),
    git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
  ])
  if (branch.failure !== undefined) return { error: stateFailedMessage(worktree, 'git branch --show-current', branch.failure) }
  // Not a stop: a branch made with `git switch --orphan` has no commit yet, and counts as unmerged.
  const headSha = head.failure === undefined ? head.stdout.trim() : ''
  const defaultBranch = defaultBranchOf(originHead.failure === undefined ? originHead.stdout : null)

  // Not a stop: with no origin/<default> to compare with, the branch counts as unmerged instead.
  // Counted at the commit read above, so the merge check and the branch delete describe the same commit.
  const aheadRun = await git('rev-list', '--count', `origin/${defaultBranch}..${headSha || 'HEAD'}`)
  const ahead =
    aheadRun.failure === undefined
      ? (parseCount(aheadRun.stdout) ?? { error: `git rev-list printed "${aheadRun.stdout.trim()}", not a count` })
      : { error: aheadRun.stderr.trim() || aheadRun.failure }
  return { branch: branch.stdout.trim(), head: headSha, defaultBranch, ahead }
}

/** The branch checked out in `worktree`, or null when git or gh cannot tell, or HEAD is detached. */
export async function lookUpBranch($: EngineInterface, worktree: string): Promise<BranchState | null> {
  const read = await readBranch($, worktree)
  if ('error' in read || read.branch === '' || typeof read.ahead !== 'number') return null
  const { prs } = await lookUpPrs($, read.branch, worktree)
  return prs === null ? null : { ahead: read.ahead, prs }
}

export async function titleSlug($: EngineInterface, path: string): Promise<string> {
  return summarize(await $.fs.read(path), folderSlug(path), 0).slug
}
