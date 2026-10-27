import type { EngineInterface } from 'claude-code'

import { backlogUncheckedMessage, folderSlug, severalLedgersMessage, sharedSlugMessage, summarize, taskName, unknownTaskMessage } from './ledger'
import { findBacklogLedgers, findLedgers, readBranch, run, sessionFolder, sessionLedger, titleSlug, type SessionFolder } from './lookup'
import { scriptPath } from './registry'
import {
  dirname,
  formatBacklogPlan,
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

type Target = { slug: string; ledgerPath: string; isBacklog?: true } | { text: string }

const UNRETIRED = 'Nothing was retired.'

async function findBacklogTarget($: EngineInterface, slug: string, activeSlugs: string[]): Promise<Target> {
  const tasks = activeSlugs.map(name => ({ slug: name }))
  const found = await findBacklogLedgers($)
  if ('error' in found) return { text: backlogUncheckedMessage(slug, tasks, found.error, UNRETIRED) }
  const slugs = await Promise.all(found.map(async ({ path, slug: fileSlug }) => summarize(await $.fs.read(path), fileSlug, 0).slug))
  const matches = found.filter((_, index) => slugs[index] === slug).map(({ path }) => path)
  const [match] = matches
  if (match === undefined) return { text: unknownTaskMessage(slug, tasks, UNRETIRED) }
  if (matches.length > 1) return { text: sharedSlugMessage(slug, matches, UNRETIRED) }
  return { slug, ledgerPath: match, isBacklog: true }
}

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
  if (match === undefined) return findBacklogTarget($, slug, slugs)
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
  const folder = await sessionFolder($)
  const target = await findTarget($, command.slug, folder)
  if ('text' in target) return target.text
  if (target.isBacklog) return retireBacklogLedger($, target.slug, target.ledgerPath, command, folder.path)
  return retireLedger($, target.slug, target.ledgerPath, command)
}

type RetireFlags = { dryRun: boolean; forced: boolean }

// Only for the plan: an unreadable ledger shows no children, and cc-worktree-retire still refuses a parent with active ones.
async function activeChildrenOf($: EngineInterface, ledgerPath: string): Promise<string[]> {
  const text = await $.fs.read(ledgerPath).catch(() => '')
  return (summarize(text, '', 0).children ?? []).filter(({ retired }) => retired === undefined).map(taskName)
}

// Only for the plan: cc-worktree-retire checks the folder again when it archives it.
async function hasEvidenceIn($: EngineInterface, worktree: string): Promise<boolean> {
  const entries = await $.fs.list(`${worktree}/.claude/evidence`).catch(() => [])
  return entries.length > 0
}

/** Plans or retires the backlog task whose ledger is `ledgerPath`: it has no worktree or branch, only the ledger. */
async function retireBacklogLedger(
  $: EngineInterface,
  slug: string,
  ledgerPath: string,
  { dryRun, forced }: RetireFlags,
  cwd: string,
): Promise<string> {
  if (dryRun) return formatBacklogPlan(slug, ledgerPath, new Date(), await activeChildrenOf($, ledgerPath))
  const { stdout, failure } = await run($, ['bash', scriptPath($, 'cc-worktree-retire'), ledgerPath, ...(forced ? ['--force'] : [])], cwd)
  return failure === undefined ? formatRetired(slug, stdout, false) : formatRetireFailed(failure, stdout)
}

/** Plans or retires the worktree that holds `ledgerPath`, named `slug` in the text. */
export async function retireLedger(
  $: EngineInterface,
  slug: string,
  ledgerPath: string,
  { dryRun, forced }: RetireFlags,
): Promise<string> {
  const state = await readState($, worktreeOf(ledgerPath))
  if ('error' in state) return state.error
  if (dryRun) {
    const [activeChildren, hasEvidence] = await Promise.all([activeChildrenOf($, ledgerPath), hasEvidenceIn($, state.path)])
    return formatPlan(slug, state, new Date(), { activeChildren, hasEvidence })
  }
  const blockers = retireBlockers(state)
  if (blockers.length > 0 && !forced) return notRetiredMessage(blockers)

  // From the main checkout, because the worktree is gone once the script returns.
  const deletesBranch = isBranchMerged(state)
  const flags = [...(deletesBranch ? ['--delete-branch', state.head] : []), ...(forced ? ['--force'] : [])]
  const { stdout, failure } = await run($, ['bash', scriptPath($, 'cc-worktree-retire'), state.path, ...flags], state.mainCheckout)
  if (failure !== undefined) return formatRetireFailed(failure, stdout)
  const kept = deletesBranch || state.branch === '' ? undefined : { branch: state.branch, reason: keptBranchReason(state) }
  // The session's own folder, not sessionFolder's fallback: the question is whether this retire removed it.
  return formatRetired(slug, stdout, isInside(await $.session.cwd(), state.path), kept)
}
