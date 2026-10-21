import type { EngineInterface } from 'claude-code'

import { folderSlug, severalLedgersMessage, sharedSlugMessage, unknownTaskMessage } from './ledger'
import { findLedgers, readBranch, run, sessionFolder, sessionLedger, titleSlug, type SessionFolder } from './lookup'
import {
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

type Target = { slug: string; ledgerPath: string } | { text: string }

const UNRETIRED = 'Nothing was retired.'

async function findTarget($: EngineInterface, slug: string | null, folder: SessionFolder): Promise<Target> {
  const found = await findLedgers($)
  if ('error' in found) return { text: `Could not list task ledgers. ${found.error}` }
  const paths = found.map(({ path }) => path)
  if (slug === null) {
    const active = sessionLedger(found, folder)
    if (active.kind === 'none') return { text: noTaskMessage(folder.removed ?? folder.path) }
    if (active.kind === 'several') return { text: severalLedgersMessage(folder.path, active.paths.map(folderSlug), UNRETIRED) }
    return { slug: await titleSlug($, active.path), ledgerPath: active.path }
  }
  const slugs = await Promise.all(paths.map(path => titleSlug($, path)))
  const matches = paths.filter((_, index) => slugs[index] === slug)
  const [match] = matches
  if (match === undefined) return { text: unknownTaskMessage(slug, slugs.map(name => ({ slug: name })), UNRETIRED) }
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

export async function readState($: EngineInterface, path: string): Promise<WorktreeState | { error: string }> {
  const dirsArgs = ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']
  const dirsRead = await readGit($, path, dirsArgs)
  if ('error' in dirsRead) return dirsRead
  const dirs = parseGitDirs(dirsRead.stdout)
  if (dirs === null) return { error: stateFailedMessage(path, `git ${dirsArgs.join(' ')}`, `printed "${dirsRead.stdout.trim()}", not two paths`) }
  if (dirs.gitDir === dirs.commonDir) return { error: mainCheckoutMessage(path) }

  const [status, branch] = await Promise.all([readGit($, path, ['status', '--porcelain']), readBranch($, path)])
  if ('error' in status) return status
  if ('error' in branch) return branch
  return {
    path,
    mainCheckout: dirname(dirs.commonDir),
    ...branch,
    dirty: status.stdout.split('\n').filter(line => line !== '').length,
    mergedPr: await lookUpMergedPr($, branch.branch, path),
  }
}

/** The text /ledger:retire answers with for the arguments the operator typed. */
export async function retireCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseRetireArgs(args)
  if (command.kind === 'usage') return RETIRE_USAGE
  const target = await findTarget($, command.slug, await sessionFolder($))
  if ('text' in target) return target.text
  return retireLedger($, target.slug, target.ledgerPath, command)
}

/** Plans or retires the worktree that holds `ledgerPath`, named `slug` in the text. */
export async function retireLedger(
  $: EngineInterface,
  slug: string,
  ledgerPath: string,
  { confirmed, forced }: { confirmed: boolean; forced: boolean },
): Promise<string> {
  const state = await readState($, worktreeOf(ledgerPath))
  if ('error' in state) return state.error
  if (!confirmed) return formatPlan(slug, state, new Date())
  const blockers = retireBlockers(state)
  if (blockers.length > 0 && !forced) return notRetiredMessage(blockers)

  // From the main checkout, because the worktree is gone once the script returns.
  const script = `${$.plugin.root}/../../bin/cc-worktree-retire`
  const deletesBranch = isBranchMerged(state)
  const flags = [...(deletesBranch ? ['--delete-branch', state.head] : []), ...(forced ? ['--force'] : [])]
  const { stdout, failure } = await run($, ['bash', script, state.path, ...flags], state.mainCheckout)
  if (failure !== undefined) return formatRetireFailed(failure, stdout)
  const kept = deletesBranch || state.branch === '' ? undefined : { branch: state.branch, reason: keptBranchReason(state) }
  // The session's own folder, not sessionFolder's fallback: the question is whether this retire removed it.
  return formatRetired(slug, stdout, isInside(await $.session.cwd(), state.path), kept)
}
