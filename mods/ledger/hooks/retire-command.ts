import type { EngineInterface } from 'claude-code'

import { activeLedger, folderSlug, severalLedgersMessage, sharedSlugMessage, unknownTaskMessage } from './ledger'
import { findLedgers, message, titleSlug } from './lookup'
import {
  defaultBranchOf,
  dirname,
  formatPlan,
  formatRetired,
  formatRetireFailed,
  isBranchMerged,
  isInside,
  keptBranchReason,
  mainCheckoutMessage,
  noTaskMessage,
  notRetiredMessage,
  parseCount,
  parseGitDirs,
  parseMergedPr,
  parseRetireArgs,
  RETIRE_USAGE,
  retireBlockers,
  stateFailedMessage,
  worktreeOf,
  type MergedPr,
  type WorktreeState,
} from './retire'

type Ran = { stdout: string; stderr: string; failure?: string }

async function run($: EngineInterface, argv: string[], cwd: string): Promise<Ran> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd })
    return exitCode === 0 ? { stdout, stderr } : { stdout, stderr, failure: `failed (exit ${exitCode}): ${stderr.trim()}` }
  } catch (error) {
    return { stdout: '', stderr: '', failure: `did not run: ${message(error)}` }
  }
}

type Target = { slug: string; ledgerPath: string } | { text: string }

const UNRETIRED = 'Nothing was retired.'

async function findTarget($: EngineInterface, slug: string | null, cwd: string): Promise<Target> {
  const found = await findLedgers($)
  if ('error' in found) return { text: `Could not list task ledgers. ${found.error}` }
  const paths = found.map(({ path }) => path)
  if (slug === null) {
    const active = activeLedger(paths, cwd)
    if (active.kind === 'none') return { text: noTaskMessage(cwd) }
    if (active.kind === 'several') return { text: severalLedgersMessage(cwd, active.paths.map(folderSlug), UNRETIRED) }
    return { slug: await titleSlug($, active.path), ledgerPath: active.path }
  }
  const slugs = await Promise.all(paths.map(path => titleSlug($, path)))
  const matches = paths.filter((_, index) => slugs[index] === slug)
  const [match] = matches
  if (match === undefined) return { text: unknownTaskMessage(slug, slugs, UNRETIRED) }
  if (matches.length > 1) return { text: sharedSlugMessage(slug, matches, UNRETIRED) }
  return { slug, ledgerPath: match }
}

type Read = { stdout: string } | { error: string }

async function readGit($: EngineInterface, worktree: string, args: string[]): Promise<Read> {
  const { stdout, failure } = await run($, ['git', '-C', worktree, ...args], worktree)
  return failure === undefined ? { stdout } : { error: stateFailedMessage(worktree, `git ${args.join(' ')}`, failure) }
}

async function lookUpMergedPr($: EngineInterface, branch: string, cwd: string): Promise<MergedPr> {
  if (branch === '') return { kind: 'none' }
  const { stdout, failure } = await run($, ['gh', 'pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid'], cwd)
  return failure === undefined ? parseMergedPr(stdout) : { kind: 'unknown', error: `gh pr list ${failure}` }
}

async function readState($: EngineInterface, path: string): Promise<WorktreeState | { error: string }> {
  const dirsArgs = ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']
  const dirsRead = await readGit($, path, dirsArgs)
  if ('error' in dirsRead) return dirsRead
  const dirs = parseGitDirs(dirsRead.stdout)
  if (dirs === null) return { error: stateFailedMessage(path, `git ${dirsArgs.join(' ')}`, `printed "${dirsRead.stdout.trim()}", not two paths`) }
  if (dirs.gitDir === dirs.commonDir) return { error: mainCheckoutMessage(path) }

  const [status, branch, head, originHead] = await Promise.all([
    readGit($, path, ['status', '--porcelain']),
    readGit($, path, ['branch', '--show-current']),
    run($, ['git', '-C', path, 'rev-parse', '--verify', '--quiet', 'HEAD'], path),
    readGit($, path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
  ])
  if ('error' in status) return status
  if ('error' in branch) return branch
  const branchName = branch.stdout.trim()
  // Not a stop: a branch made with `git switch --orphan` has no commit yet, and counts as unmerged.
  const headSha = head.failure === undefined ? head.stdout.trim() : ''
  const defaultBranch = defaultBranchOf('error' in originHead ? null : originHead.stdout)

  // Not a stop: with no origin/<default> to compare with, the branch counts as unmerged instead.
  // Counted at the commit read above, so the merge check and the branch delete describe the same commit.
  const [aheadRun, mergedPr] = await Promise.all([
    run($, ['git', '-C', path, 'rev-list', '--count', `origin/${defaultBranch}..${headSha || 'HEAD'}`], path),
    lookUpMergedPr($, branchName, path),
  ])
  const ahead =
    aheadRun.failure === undefined
      ? (parseCount(aheadRun.stdout) ?? { error: `git rev-list printed "${aheadRun.stdout.trim()}", not a count` })
      : { error: aheadRun.stderr.trim() || aheadRun.failure }

  return {
    path,
    mainCheckout: dirname(dirs.commonDir),
    branch: branchName,
    head: headSha,
    defaultBranch,
    ahead,
    dirty: status.stdout.split('\n').filter(line => line !== '').length,
    mergedPr,
  }
}

/** The text /ledger:retire answers with for the arguments the operator typed. */
export async function retireCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseRetireArgs(args)
  if (command.kind === 'usage') return RETIRE_USAGE
  const cwd = await $.session.cwd()
  const target = await findTarget($, command.slug, cwd)
  if ('text' in target) return target.text
  const state = await readState($, worktreeOf(target.ledgerPath))
  if ('error' in state) return state.error
  if (!command.confirmed) return formatPlan(target.slug, state, new Date())
  const blockers = retireBlockers(state)
  if (blockers.length > 0 && !command.forced) return notRetiredMessage(blockers)

  // From the main checkout, because the worktree is gone once the script returns.
  const script = `${$.plugin.root}/../../bin/cc-worktree-retire`
  const deletesBranch = isBranchMerged(state)
  const flags = [...(deletesBranch ? ['--delete-branch', state.head] : []), ...(command.forced ? ['--force'] : [])]
  const { stdout, failure } = await run($, ['bash', script, state.path, ...flags], state.mainCheckout)
  if (failure !== undefined) return formatRetireFailed(failure, stdout)
  const kept = deletesBranch || state.branch === '' ? undefined : { branch: state.branch, reason: keptBranchReason(state) }
  return formatRetired(target.slug, stdout, isInside(cwd, state.path), kept)
}
