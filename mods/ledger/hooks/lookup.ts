import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { activeLedger, folderSlug, ledgerPaths, summarize, type ActiveLedger, type BranchState, type LedgerSummary } from './ledger'
import { defaultBranchOf, dirname, isInside, parseCount, stateFailedMessage } from './retire'
import { basename, parseWorktrees, type Worktree } from './worktrees'
import { lookUpPrs } from './worktrees-command'

export type Found = { path: string; slug: string; mtimeMs: number }

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type Ran = { stdout: string; stderr: string; failure?: string; exitCode?: number }

export async function run($: EngineInterface, argv: string[], cwd: string): Promise<Ran> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd })
    return exitCode === 0 ? { stdout, stderr } : { stdout, stderr, exitCode, failure: `failed (exit ${exitCode}): ${stderr.trim()}` }
  } catch (error) {
    return { stdout: '', stderr: '', failure: `did not run: ${message(error)}` }
  }
}

/**
 * The folder to run commands in. `removed` is the session's own folder when it no longer exists, as after /ledger:retire
 * from inside the worktree; `path` is then the nearest folder above it that does.
 */
export type SessionFolder = { path: string; removed?: string }

async function exists($: EngineInterface, path: string): Promise<boolean> {
  return $.fs.stat(path).then(() => true, () => false)
}

export async function sessionFolder($: EngineInterface): Promise<SessionFolder> {
  const cwd = await $.session.cwd()
  if (await exists($, cwd)) return { path: cwd }
  for (let folder = cwd; folder !== '/'; ) {
    folder = dirname(folder) || '/'
    if (await exists($, folder)) return { path: folder, removed: cwd }
  }
  // Not even / is there, so fs.stat itself is failing, which says nothing about the session folder.
  return { path: cwd }
}

/** The ledger of the session's own task. A removed session folder has none: a ledger above it belongs to another task. */
export const sessionLedger = (found: Found[], folder: SessionFolder): ActiveLedger =>
  folder.removed === undefined ? activeLedger(found.map(({ path }) => path), folder.path) : { kind: 'none' }

async function listLedgers($: EngineInterface, mode: 'paths' | 'backlog', slugOf: (path: string) => string): Promise<Found[] | { error: string }> {
  const script = `${$.plugin.root}/../../hooks/ledger-list.sh`
  const { path: cwd } = await sessionFolder($)
  let result: ProcessRunResult
  try {
    result = await $.process.run(['bash', script, mode], { cwd })
  } catch (error) {
    return { error: `${script} did not run: ${message(error)}` }
  }
  const { exitCode, stdout, stderr } = result
  if (exitCode !== 0) return { error: `${script} failed (exit ${exitCode}): ${stderr.trim()}` }
  const found = await Promise.all(ledgerPaths(stdout).map(async path => ({ path, slug: slugOf(path), mtimeMs: (await $.fs.stat(path)).mtimeMs })))
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

// The SessionStart hook's own lookup, so /ledger and the hook always agree on which ledgers exist.
export function findLedgers($: EngineInterface): Promise<Found[] | { error: string }> {
  return listLedgers($, 'paths', folderSlug)
}

/** The backlog ledgers of the repository the session is in, matched on its main checkout as cc-task-new and cc-ledger-parent do. */
export function findBacklogLedgers($: EngineInterface): Promise<Found[] | { error: string }> {
  return listLedgers($, 'backlog', path => basename(path).replace(/\.md$/, ''))
}

function summarizeAll($: EngineInterface, found: Found[]): Promise<LedgerSummary[]> {
  return Promise.all(found.map(async ({ path, slug, mtimeMs }) => summarize(await $.fs.read(path), slug, mtimeMs)))
}

async function otherWorktreeLedgers($: EngineInterface): Promise<Map<string, LedgerSummary>> {
  const { path: cwd } = await sessionFolder($)
  const found = await Promise.all((await otherWorktrees($, cwd)).map(({ path }) => ledgerIn($, path)))
  // Another session can remove a worktree between the stat and the read; its ledger is then skipped, not an error.
  const summaries = await Promise.all(
    found
      .filter(ledger => ledger !== undefined)
      .map(({ path, slug, mtimeMs }) => $.fs.read(path).then(text => summarize(text, slug, mtimeMs), () => undefined)),
  )
  return new Map(summaries.filter(summary => summary !== undefined).map(summary => [summary.slug, summary]))
}

/**
 * The unlisted ledgers that are the parent of a listed task, the parent of that parent, and so on. A parent is looked up
 * in the backlog, marked as backlog, then in the other worktrees, whose ledgers findLedgers does not list from a linked
 * worktree. Each walk up stops at a parent that is listed or seen before, or that has no ledger in either place.
 */
export async function unlistedAncestors($: EngineInterface, listed: LedgerSummary[]): Promise<LedgerSummary[] | { error: string }> {
  const seen = new Set(listed.map(({ slug }) => slug))
  if (listed.every(({ parent }) => parent === undefined || seen.has(parent))) return []
  const found = await findBacklogLedgers($)
  if ('error' in found) return found
  const backlog = new Map<string, LedgerSummary>()
  for (const summary of await summarizeAll($, found)) if (!backlog.has(summary.slug)) backlog.set(summary.slug, { ...summary, isBacklog: true })
  let active: Map<string, LedgerSummary> | undefined
  const ancestors: LedgerSummary[] = []
  for (const ledger of listed) {
    for (let parent = ledger.parent; parent !== undefined && !seen.has(parent); ) {
      seen.add(parent)
      const ancestor = backlog.get(parent) ?? (active ??= await otherWorktreeLedgers($)).get(parent)
      if (ancestor) ancestors.push(ancestor)
      parent = ancestor?.parent
    }
  }
  return ancestors
}

/** The linked worktrees other than the one holding `cwd`; none from the main checkout, and when git cannot list them. */
async function otherWorktrees($: EngineInterface, cwd: string): Promise<Worktree[]> {
  let result: ProcessRunResult
  try {
    result = await $.process.run(['git', 'worktree', 'list', '--porcelain', '-z'], { cwd })
  } catch {
    return []
  }
  if (result.exitCode !== 0) return []
  const worktrees = parseWorktrees(result.stdout)
  // The longest match, because a task worktree can sit inside another one.
  const [own] = worktrees.filter(({ path }) => isInside(cwd, path)).sort((a, b) => b.path.length - a.path.length)
  return own === undefined ? [] : worktrees.filter(({ path }) => path !== own.path)
}

async function ledgerIn($: EngineInterface, worktree: string): Promise<Found | undefined> {
  const path = `${worktree}/.claude/ledger.md`
  const stat = await $.fs.stat(path).catch(() => undefined)
  return stat?.kind === 'file' ? { path, slug: folderSlug(path), mtimeMs: stat.mtimeMs } : undefined
}

const namesWorktree = ({ path, branch }: Worktree, word: string): boolean => [basename(path), branch, branch.split('/').at(-1)].includes(word)

/** A worktree named by its folder or branch; `slug` is its task's, absent when it has no ledger. */
export type NamedWorktree = { path: string; slug?: string }

export type OtherWorktreeMatch = { ledgers: Found[]; worktree?: NamedWorktree }

/**
 * From a linked worktree, findLedgers lists only its own ledger; this finds the ledgers in the other linked worktrees whose slug is
 * `word`, the same slug a match from the main checkout needs. When none matches and `word` names one of those worktrees by its
 * folder, its branch, or its branch without the owner prefix, `worktree` is that one.
 */
export async function lookUpOtherWorktrees($: EngineInterface, word: string, cwd: string): Promise<OtherWorktreeMatch> {
  const worktrees = await Promise.all(
    (await otherWorktrees($, cwd)).map(async worktree => {
      const ledger = await ledgerIn($, worktree.path)
      return { worktree, ledger, slug: ledger && (await titleSlug($, ledger.path)) }
    }),
  )
  const ledgers = worktrees.flatMap(({ ledger, slug }) => (ledger && slug === word ? [ledger] : []))
  if (ledgers.length > 0) return { ledgers }
  const named = worktrees.find(({ worktree }) => namesWorktree(worktree, word))
  return named ? { ledgers: [], worktree: { path: named.worktree.path, slug: named.slug } } : { ledgers: [] }
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
