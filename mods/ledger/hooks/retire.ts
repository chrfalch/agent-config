import { isoDate } from './ledger'
import { basename } from './worktrees'

export type RetireArgs = { kind: 'retire'; slug: string | null; dryRun: boolean; forced: boolean } | { kind: 'usage' }

export const RETIRE_USAGE =
  'Usage: /ledger:retire [<slug>] [--dry-run] [--force]. --dry-run only shows what would be retired. --force retires a task with uncommitted changes or unmerged work. Run /ledger to see each slug.'

/** `--yes` is still accepted from before retiring was the default, and changes nothing. */
const RETIRE_FLAGS = new Set(['--dry-run', '--force', '--yes'])

export function parseRetireArgs(args: string): RetireArgs {
  const words = args.split(/\s+/).filter(word => word !== '')
  const flags = words.filter(word => word.startsWith('-'))
  const slugs = words.filter(word => !word.startsWith('-'))
  if (slugs.length > 1 || flags.some(flag => !RETIRE_FLAGS.has(flag))) return { kind: 'usage' }
  return { kind: 'retire', slug: slugs[0] ?? null, dryRun: flags.includes('--dry-run'), forced: flags.includes('--force') }
}

export const worktreeOf = (ledgerPath: string): string => ledgerPath.split('/').slice(0, -2).join('/')

export const dirname = (path: string): string => path.split('/').slice(0, -1).join('/')

export function noTaskMessage(cwd: string): string {
  return `No task ledger in or above ${cwd}. Give a slug: /ledger:retire <slug>. Run /ledger to see each slug.`
}

export function mainCheckoutMessage(path: string): string {
  return `${path} is the main checkout, not a linked worktree. /ledger:retire removes only linked worktrees.`
}

export function stateFailedMessage(worktree: string, command: string, failure: string): string {
  return `Could not read the state of ${worktree}. ${command} ${failure}`
}

/** Reads `git rev-parse --path-format=absolute --git-dir --git-common-dir`; the two are equal only in the main checkout. */
export function parseGitDirs(stdout: string): { gitDir: string; commonDir: string } | null {
  const [gitDir, commonDir] = stdout.split('\n').filter(line => line !== '')
  return gitDir === undefined || commonDir === undefined ? null : { gitDir, commonDir }
}

export function defaultBranchOf(originHead: string | null): string {
  return originHead?.trim().replace(/^origin\//, '') || 'main'
}

export function parseCount(stdout: string): number | null {
  const text = stdout.trim()
  return /^\d+$/.test(text) ? Number(text) : null
}

/** `heads` holds the head commit of each merged PR from a branch with this name. */
export type MergedPr = { kind: 'merged'; number: number; heads: string[] } | { kind: 'none' } | { kind: 'unknown'; error: string }

/** Reads `gh pr list --json number,headRefOid`. */
export function parseMergedPr(stdout: string): MergedPr {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    parsed = null
  }
  if (!Array.isArray(parsed)) return { kind: 'unknown', error: 'gh pr list printed something that is not a JSON list' }
  const prs = parsed.map(pr => (pr ?? {}) as Record<string, unknown>)
  const [first] = prs
  if (first === undefined) return { kind: 'none' }
  if (typeof first.number !== 'number') return { kind: 'unknown', error: 'gh pr list printed a PR without a number' }
  const heads = prs.map(({ headRefOid }) => headRefOid).filter(head => typeof head === 'string')
  return { kind: 'merged', number: first.number, heads }
}

export type WorktreeState = {
  path: string
  mainCheckout: string
  /** Empty on a detached HEAD, as `git branch --show-current` prints it. */
  branch: string
  /** The commit HEAD points at; empty on a branch with no commits yet. */
  head: string
  defaultBranch: string
  /** Commits ahead of origin/<defaultBranch>, or why git could not count them. */
  ahead: number | { error: string }
  dirty: number
  mergedPr: MergedPr
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** A gh failure counts as no merged PR, and an unknown ahead count as commits ahead. */
const isWorkMerged = ({ ahead, mergedPr }: WorktreeState): boolean => ahead === 0 || mergedPr.kind === 'merged'

const isHeadMerged = ({ head, mergedPr }: WorktreeState): boolean => head !== '' && mergedPr.kind === 'merged' && mergedPr.heads.includes(head)

/**
 * Whether retiring may delete the local branch at `head`. The script deletes it without git's merge check, because a squash-merged
 * branch is never an ancestor of main, and keeps it when it no longer points at `head`.
 * A merged PR counts only when it ended at HEAD: the branch name may have been reused, or committed to after the merge.
 */
export const isBranchMerged = (state: WorktreeState): boolean => state.branch !== '' && (state.ahead === 0 || isHeadMerged(state))

/** Why retiring keeps a branch that isBranchMerged does not hold for. */
export function keptBranchReason(state: WorktreeState): string {
  if (state.head === '') return 'it has no commits yet'
  return isWorkMerged(state) ? 'it has commits that are not in its merged PR' : 'it is not merged'
}

/** Why retiring needs --force; empty when it does not. */
export function retireBlockers(state: WorktreeState): string[] {
  return [
    state.dirty > 0 ? `it has ${plural(state.dirty, 'uncommitted change')}` : '',
    isWorkMerged(state) ? '' : 'its branch is not merged',
  ].filter(reason => reason !== '')
}

const archiveCopy = (repo: string, slug: string, today: Date): string => `~/.claude/ledger-archive/${repo}/${isoDate(today)}-${slug}.md`

/** Where cc-worktree-retire copies the ledger, named the way the script names it. */
export function archivePath({ path, mainCheckout, branch }: WorktreeState, today: Date): string {
  return archiveCopy(basename(mainCheckout), branch.split('/').at(-1) || basename(path), today)
}

function prLabel(mergedPr: MergedPr): string {
  switch (mergedPr.kind) {
    case 'merged':
      return `merged PR #${mergedPr.number}`
    case 'none':
      return 'no merged PR'
    case 'unknown':
      return `could not check PRs: ${mergedPr.error}`
  }
}

function aheadLabel({ ahead, defaultBranch }: WorktreeState): string {
  if (typeof ahead !== 'number') return `could not compare with origin/${defaultBranch}: ${ahead.error}`
  return ahead === 0 ? 'no commits ahead' : `${plural(ahead, 'commit')} ahead of origin/${defaultBranch}`
}

function planFooter(slug: string, blockers: string[]): string {
  if (blockers.length === 0) return `Run \`/ledger:retire ${slug}\` to retire it.`
  return `Retiring it needs --force: ${blockers.join(' and ')}. Run \`/ledger:retire ${slug} --force\` to retire it anyway.`
}

/** `footer: false` leaves out the /ledger:retire command that carries out the plan, for the dashboard, which has its own. */
export function formatPlan(slug: string, state: WorktreeState, today: Date, { footer = true }: { footer?: boolean } = {}): string {
  return [
    `**Retire ${slug}** — nothing done yet`,
    `- worktree: ${state.path}`,
    `- branch: ${state.branch || 'detached HEAD'} · ${aheadLabel(state)} · ${prLabel(state.mergedPr)}`,
    `- uncommitted changes: ${state.dirty || 'none'}`,
    `- archive: ${archivePath(state, today)}`,
    "- then: git worktree remove, and the worktree's cc-dd-path build folders are deleted",
    ...(state.branch ? [`- local branch: ${state.branch} is ${isBranchMerged(state) ? 'deleted, because it is merged' : `kept, because ${keptBranchReason(state)}`}`] : []),
    ...(footer ? ['', planFooter(slug, retireBlockers(state))] : []),
  ].join('\n')
}

/** `ledgerPath` is ~/.claude/ledger-backlog/<repo>/<slug>.md; cc-worktree-retire names the copy after that folder and file. */
export function formatBacklogPlan(slug: string, ledgerPath: string, today: Date): string {
  return [
    `**Retire ${slug}** — nothing done yet`,
    `- backlog ledger: ${ledgerPath}`,
    `- archive: ${archiveCopy(basename(dirname(ledgerPath)), basename(ledgerPath).replace(/\.md$/, ''), today)}`,
    '- then: the backlog ledger is deleted. A backlog task has no worktree or branch to remove.',
    '',
    planFooter(slug, []),
  ].join('\n')
}

export function notRetiredMessage(blockers: string[]): string {
  return `Not retired: ${blockers.join(' and ')}. Add --force to retire it anyway. Uncommitted changes are lost with the worktree.`
}

export const isInside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`)

const scriptLines = (stdout: string): string[] =>
  stdout
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => `- ${line.trimEnd()}`)

/** `kept` is the branch the script was not asked to delete, and why. */
export function formatRetired(slug: string, stdout: string, isCwdRemoved: boolean, kept?: { branch: string; reason: string }): string {
  const lines = [`**Retired ${slug}**`, ...scriptLines(stdout)]
  if (kept) lines.push(`- kept branch ${kept.branch}, because ${kept.reason}`)
  if (isCwdRemoved) {
    lines.push('', "This session's working directory was removed with the worktree. Continue another task with /ledger:go <slug>, or run /ledger:close.")
  }
  return lines.join('\n')
}

export function formatRetireFailed(failure: string, stdout: string): string {
  return [`cc-worktree-retire ${failure}`, ...scriptLines(stdout)].join('\n')
}
