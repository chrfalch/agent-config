import { basename } from './worktrees'

export type RetireArgs = { kind: 'retire'; slug: string | null; confirmed: boolean; forced: boolean } | { kind: 'usage' }

export const RETIRE_USAGE =
  'Usage: /ledger:retire [<slug>] [--yes] [--force]. Without --yes it only shows what would be retired. Run /ledger to see each slug.'

export function parseRetireArgs(args: string): RetireArgs {
  const words = args.split(/\s+/).filter(word => word !== '')
  const flags = words.filter(word => word.startsWith('-'))
  const slugs = words.filter(word => !word.startsWith('-'))
  if (slugs.length > 1 || flags.some(flag => flag !== '--yes' && flag !== '--force')) return { kind: 'usage' }
  return { kind: 'retire', slug: slugs[0] ?? null, confirmed: flags.includes('--yes'), forced: flags.includes('--force') }
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

export type MergedPr = { kind: 'merged'; number: number } | { kind: 'none' } | { kind: 'unknown'; error: string }

export function parseMergedPr(stdout: string): MergedPr {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    parsed = null
  }
  if (!Array.isArray(parsed)) return { kind: 'unknown', error: 'gh pr list printed something that is not a JSON list' }
  const [first]: unknown[] = parsed
  if (first === undefined) return { kind: 'none' }
  const { number } = (first ?? {}) as Record<string, unknown>
  return typeof number === 'number' ? { kind: 'merged', number } : { kind: 'unknown', error: 'gh pr list printed a PR without a number' }
}

export type WorktreeState = {
  path: string
  mainCheckout: string
  /** Empty on a detached HEAD, as `git branch --show-current` prints it. */
  branch: string
  defaultBranch: string
  /** Commits ahead of origin/<defaultBranch>, or why git could not count them. */
  ahead: number | { error: string }
  dirty: number
  mergedPr: MergedPr
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** Why retiring needs --force; empty when it does not. A gh failure counts as no merged PR, and an unknown ahead count as commits ahead. */
export function retireBlockers({ dirty, ahead, mergedPr }: WorktreeState): string[] {
  const hasCommitsAhead = typeof ahead !== 'number' || ahead > 0
  return [
    dirty > 0 ? `it has ${plural(dirty, 'uncommitted change')}` : '',
    hasCommitsAhead && mergedPr.kind !== 'merged' ? 'its branch is not merged' : '',
  ].filter(reason => reason !== '')
}

const isoDate = (date: Date): string =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-')

/** Where cc-worktree-retire copies the ledger, named the way the script names it. */
export function archivePath({ path, mainCheckout, branch }: WorktreeState, today: Date): string {
  const slug = branch.split('/').at(-1) || basename(path)
  return `~/.claude/ledger-archive/${basename(mainCheckout)}/${isoDate(today)}-${slug}.md`
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

export function formatPlan(slug: string, state: WorktreeState, today: Date): string {
  const blockers = retireBlockers(state)
  return [
    `**Retire ${slug}** — nothing done yet`,
    `- worktree: ${state.path}`,
    `- branch: ${state.branch || 'detached HEAD'} · ${aheadLabel(state)} · ${prLabel(state.mergedPr)}`,
    `- uncommitted changes: ${state.dirty || 'none'}`,
    `- archive: ${archivePath(state, today)}`,
    "- then: git worktree remove, and the worktree's cc-dd-path build folders are deleted",
    '',
    blockers.length === 0 ? 'Add --yes to retire it.' : `Add --yes --force to retire it: ${blockers.join(' and ')}`,
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

export function formatRetired(slug: string, stdout: string, isCwdRemoved: boolean): string {
  const lines = [`**Retired ${slug}**`, ...scriptLines(stdout)]
  if (isCwdRemoved) {
    lines.push('', "This session's working directory was removed with the worktree. Continue another task with /ledger:go <slug>, or run /ledger:close.")
  }
  return lines.join('\n')
}

export function formatRetireFailed(failure: string, stdout: string): string {
  return [`cc-worktree-retire ${failure}`, ...scriptLines(stdout)].join('\n')
}
