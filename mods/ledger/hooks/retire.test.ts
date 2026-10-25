import { expect, test } from 'claude-code/testing'

import {
  archivePath,
  defaultBranchOf,
  formatPlan,
  formatRetired,
  formatRetireFailed,
  isBranchMerged,
  isInside,
  keptBranchReason,
  notRetiredMessage,
  parseCount,
  parseGitDirs,
  parseMergedPr,
  parseRetireArgs,
  retireBlockers,
  RETIRE_USAGE,
  worktreeOf,
  type WorktreeState,
} from './retire'

test('parseRetireArgs takes an optional slug and the flags in any order', () => {
  expect(parseRetireArgs('')).toEqual({ kind: 'retire', slug: null, dryRun: false, forced: false })
  expect(parseRetireArgs('  ')).toEqual({ kind: 'retire', slug: null, dryRun: false, forced: false })
  expect(parseRetireArgs('fix-login')).toEqual({ kind: 'retire', slug: 'fix-login', dryRun: false, forced: false })
  expect(parseRetireArgs('--force fix-login')).toEqual({ kind: 'retire', slug: 'fix-login', dryRun: false, forced: true })
  expect(parseRetireArgs('--dry-run')).toEqual({ kind: 'retire', slug: null, dryRun: true, forced: false })
  expect(parseRetireArgs('--force fix-login --dry-run')).toEqual({ kind: 'retire', slug: 'fix-login', dryRun: true, forced: true })
})

test('parseRetireArgs still takes --yes, and it changes nothing', () => {
  expect(parseRetireArgs('--yes')).toEqual(parseRetireArgs(''))
  expect(parseRetireArgs('--force --yes fix-login')).toEqual(parseRetireArgs('--force fix-login'))
  expect(parseRetireArgs('fix-login --yes --dry-run')).toEqual(parseRetireArgs('fix-login --dry-run'))
})

test('parseRetireArgs answers with usage for a second word or an unknown flag', () => {
  expect(parseRetireArgs('fix-login new-api')).toEqual({ kind: 'usage' })
  expect(parseRetireArgs('fix-login --yess')).toEqual({ kind: 'usage' })
  expect(parseRetireArgs('fix-login --dry')).toEqual({ kind: 'usage' })
  expect(parseRetireArgs('-y')).toEqual({ kind: 'usage' })
})

test('the usage text names --dry-run for a preview, --force for blockers, and where the slugs are', () => {
  expect(RETIRE_USAGE).toBe(
    'Usage: /ledger:retire [<slug>] [--dry-run] [--force]. --dry-run only shows what would be retired. --force retires a task with uncommitted changes or unmerged work. Run /ledger to see each slug.',
  )
})

test('worktreeOf is the folder that holds .claude/ledger.md', () => {
  expect(worktreeOf('/repo/.claude/worktrees/fix login/.claude/ledger.md')).toBe('/repo/.claude/worktrees/fix login')
})

test('parseGitDirs reads the git dir and the common dir, one per line', () => {
  expect(parseGitDirs('/repo/.git/worktrees/wt\n/repo/.git\n')).toEqual({ gitDir: '/repo/.git/worktrees/wt', commonDir: '/repo/.git' })
  expect(parseGitDirs('/repo/.git\n')).toBe(null)
  expect(parseGitDirs('')).toBe(null)
})

test('defaultBranchOf strips origin/ and falls back to main', () => {
  expect(defaultBranchOf('origin/develop\n')).toBe('develop')
  expect(defaultBranchOf(null)).toBe('main')
  expect(defaultBranchOf('\n')).toBe('main')
})

test('parseCount reads a whole number and nothing else', () => {
  expect(parseCount('3\n')).toBe(3)
  expect(parseCount('0')).toBe(0)
  expect(parseCount('')).toBe(null)
  expect(parseCount('fatal')).toBe(null)
})

test('parseMergedPr finds the first merged PR, or none, or says why it cannot tell', () => {
  expect(parseMergedPr('[]')).toEqual({ kind: 'none' })
  expect(parseMergedPr('[{"number":51,"headRefOid":"c51"},{"number":40,"headRefOid":"c40"}]')).toEqual({ kind: 'merged', number: 51, heads: ['c51', 'c40'] })
  expect(parseMergedPr('Loading...')).toEqual({ kind: 'unknown', error: 'gh pr list printed something that is not a JSON list' })
  expect(parseMergedPr('{"number":5}')).toEqual({ kind: 'unknown', error: 'gh pr list printed something that is not a JSON list' })
})

const HEAD = 'c0ffee1'

const CLEAN: WorktreeState = {
  path: '/repo/.claude/worktrees/fix-login',
  mainCheckout: '/repo',
  branch: 'me/fix-login',
  head: HEAD,
  defaultBranch: 'main',
  ahead: 0,
  dirty: 0,
  mergedPr: { kind: 'none' },
}

test('retireBlockers is empty for a clean worktree with no commits ahead', () => {
  expect(retireBlockers(CLEAN)).toEqual([])
})

test('retireBlockers names uncommitted changes, counted', () => {
  expect(retireBlockers({ ...CLEAN, dirty: 1 })).toEqual(['it has 1 uncommitted change'])
  expect(retireBlockers({ ...CLEAN, dirty: 3 })).toEqual(['it has 3 uncommitted changes'])
})

test('a branch with commits ahead is unmerged unless a merged PR exists', () => {
  expect(retireBlockers({ ...CLEAN, ahead: 2 })).toEqual(['its branch is not merged'])
  expect(retireBlockers({ ...CLEAN, ahead: 2, mergedPr: { kind: 'merged', number: 7, heads: [] } })).toEqual([])
  expect(retireBlockers({ ...CLEAN, ahead: 2, mergedPr: { kind: 'unknown', error: 'gh: auth' } })).toEqual(['its branch is not merged'])
  expect(retireBlockers({ ...CLEAN, ahead: 0, mergedPr: { kind: 'unknown', error: 'gh: auth' } })).toEqual([])
})

const OCT_5 = new Date(2026, 9, 5, 23, 30)

test('archivePath names the archive after the main checkout and the last segment of the branch', () => {
  expect(archivePath(CLEAN, OCT_5)).toBe('~/.claude/ledger-archive/repo/2026-10-05-fix-login.md')
  expect(archivePath({ ...CLEAN, branch: '' }, OCT_5)).toBe('~/.claude/ledger-archive/repo/2026-10-05-fix-login.md')
  expect(archivePath({ ...CLEAN, branch: '', path: '/elsewhere/detached-wt' }, OCT_5)).toBe('~/.claude/ledger-archive/repo/2026-10-05-detached-wt.md')
})

test('formatPlan for a clean, merged worktree gives the command that retires it', () => {
  expect(formatPlan('fast-steps', { ...CLEAN, ahead: 1, mergedPr: { kind: 'merged', number: 24, heads: [HEAD] } }, OCT_5)).toBe(
    [
      '**Retire fast-steps** — nothing done yet',
      '- worktree: /repo/.claude/worktrees/fix-login',
      '- branch: me/fix-login · 1 commit ahead of origin/main · merged PR #24',
      '- uncommitted changes: none',
      '- archive: ~/.claude/ledger-archive/repo/2026-10-05-fix-login.md',
      "- then: git worktree remove, and the worktree's cc-dd-path build folders are deleted",
      '- local branch: me/fix-login is deleted, because it is merged',
      '',
      'Run `/ledger:retire fast-steps` to retire it.',
    ].join('\n'),
  )
})

test('formatPlan lists the evidence folder next to the archived ledger when the worktree has evidence', () => {
  const lines = formatPlan('fast-steps', CLEAN, OCT_5, { hasEvidence: true }).split('\n')
  expect(lines.slice(4, 6)).toEqual([
    '- archive: ~/.claude/ledger-archive/repo/2026-10-05-fix-login.md',
    '- evidence: /repo/.claude/worktrees/fix-login/.claude/evidence/ is copied to ~/.claude/ledger-archive/repo/2026-10-05-fix-login/',
  ])
  expect(formatPlan('fast-steps', CLEAN, OCT_5)).not.toContain('evidence')
})

test('formatPlan for dirty, unmerged work says why it needs --force', () => {
  const state: WorktreeState = { ...CLEAN, dirty: 2, ahead: 3, defaultBranch: 'develop', mergedPr: { kind: 'unknown', error: 'gh pr list failed (exit 4): auth required' } }
  const lines = formatPlan('fast-steps', state, OCT_5).split('\n')
  expect(lines[2]).toBe('- branch: me/fix-login · 3 commits ahead of origin/develop · could not check PRs: gh pr list failed (exit 4): auth required')
  expect(lines[3]).toBe('- uncommitted changes: 2')
  expect(lines.at(-1)).toBe(
    'Retiring it needs --force: it has 2 uncommitted changes and its branch is not merged. Run `/ledger:retire fast-steps --force` to retire it anyway.',
  )
})

test('an ahead count git could not give counts as unmerged unless a merged PR exists, and the plan says why', () => {
  const unknown: WorktreeState = { ...CLEAN, ahead: { error: "fatal: bad revision 'origin/main..HEAD'" } }
  expect(retireBlockers(unknown)).toEqual(['its branch is not merged'])
  expect(retireBlockers({ ...unknown, mergedPr: { kind: 'merged', number: 7, heads: [] } })).toEqual([])
  expect(formatPlan('fast-steps', unknown, OCT_5).split('\n')[2]).toBe(
    "- branch: me/fix-login · could not compare with origin/main: fatal: bad revision 'origin/main..HEAD' · no merged PR",
  )
})

test('formatPlan shows a detached HEAD with no commits ahead and no merged PR', () => {
  const lines = formatPlan('fast-steps', { ...CLEAN, branch: '' }, OCT_5).split('\n')
  expect(lines[2]).toBe('- branch: detached HEAD · no commits ahead · no merged PR')
})

test('notRetiredMessage gives the reasons and the way past them', () => {
  expect(notRetiredMessage(['its branch is not merged'])).toBe(
    'Not retired: its branch is not merged. Add --force to retire it anyway. Uncommitted changes are lost with the worktree.',
  )
})

test('isInside holds for the folder itself and anything under it, not for a sibling with the same prefix', () => {
  expect(isInside('/repo/wt', '/repo/wt')).toBe(true)
  expect(isInside('/repo/wt/src', '/repo/wt')).toBe(true)
  expect(isInside('/repo/wt-2', '/repo/wt')).toBe(false)
  expect(isInside('/repo', '/repo/wt')).toBe(false)
})

const SCRIPT_OUTPUT = 'archived /Users/me/.claude/ledger-archive/repo/2026-10-05-fix-login.md\nremoved  /repo/.claude/worktrees/fix-login\n'

test('formatRetired lists each line the script printed', () => {
  expect(formatRetired('fast-steps', SCRIPT_OUTPUT, false)).toBe(
    [
      '**Retired fast-steps**',
      '- archived /Users/me/.claude/ledger-archive/repo/2026-10-05-fix-login.md',
      '- removed  /repo/.claude/worktrees/fix-login',
    ].join('\n'),
  )
})

test('formatRetired says when the session lost its working directory', () => {
  expect(formatRetired('fast-steps', SCRIPT_OUTPUT, true).split('\n').at(-1)).toBe(
    "This session's working directory was removed with the worktree. Continue another task with /ledger:go <slug>, or run /ledger:close.",
  )
})

test('formatRetireFailed gives the failure, then what the script did before it', () => {
  expect(formatRetireFailed('failed (exit 128): fatal: contains modified files', 'archived /a.md\n')).toBe(
    ['cc-worktree-retire failed (exit 128): fatal: contains modified files', '- archived /a.md'].join('\n'),
  )
  expect(formatRetireFailed('did not run: spawn bash ENOENT', '')).toBe('cc-worktree-retire did not run: spawn bash ENOENT')
})

test('isBranchMerged holds with no commits ahead or a merged PR that ends at HEAD, and never for a detached HEAD', () => {
  expect(isBranchMerged(CLEAN)).toBe(true)
  expect(isBranchMerged({ ...CLEAN, ahead: 2, mergedPr: { kind: 'merged', number: 24, heads: [HEAD] } })).toBe(true)
  expect(isBranchMerged({ ...CLEAN, ahead: 2, mergedPr: { kind: 'merged', number: 24, heads: ['0ld0001', HEAD] } })).toBe(true)
  expect(isBranchMerged({ ...CLEAN, ahead: 2, mergedPr: { kind: 'merged', number: 24, heads: ['0ld0001'] } })).toBe(false)
  expect(isBranchMerged({ ...CLEAN, ahead: { error: 'bad revision' }, mergedPr: { kind: 'merged', number: 24, heads: [HEAD] } })).toBe(true)
  expect(isBranchMerged({ ...CLEAN, ahead: { error: 'bad revision' }, mergedPr: { kind: 'merged', number: 24, heads: ['0ld0001'] } })).toBe(false)
  expect(isBranchMerged({ ...CLEAN, ahead: 2 })).toBe(false)
  expect(isBranchMerged({ ...CLEAN, ahead: { error: 'bad revision' } })).toBe(false)
  expect(isBranchMerged({ ...CLEAN, ahead: 2, mergedPr: { kind: 'unknown', error: 'auth required' } })).toBe(false)
  expect(isBranchMerged({ ...CLEAN, branch: '' })).toBe(false)
})

test('formatPlan says an unmerged branch is kept, and names no branch for a detached HEAD', () => {
  expect(formatPlan('fast-steps', { ...CLEAN, ahead: 2 }, OCT_5).split('\n')).toContain('- local branch: me/fix-login is kept, because it is not merged')
  expect(formatPlan('fast-steps', { ...CLEAN, branch: '' }, OCT_5)).not.toContain('local branch')
})

test('formatPlan retires a branch whose PR merged before its last commit, and keeps the branch', () => {
  const lines = formatPlan('fast-steps', { ...CLEAN, ahead: 3, mergedPr: { kind: 'merged', number: 24, heads: ['0ld0001'] } }, OCT_5).split('\n')
  expect(lines).toContain('- local branch: me/fix-login is kept, because it has commits that are not in its merged PR')
  expect(lines.at(-1)).toBe('Run `/ledger:retire fast-steps` to retire it.')
})

test('keptBranchReason says why the branch is kept', () => {
  expect(keptBranchReason({ ...CLEAN, ahead: 2 })).toBe('it is not merged')
  expect(keptBranchReason({ ...CLEAN, ahead: 2, mergedPr: { kind: 'merged', number: 24, heads: ['0ld0001'] } })).toBe(
    'it has commits that are not in its merged PR',
  )
})

test('formatRetired says which branch it kept, before the working directory note', () => {
  const lines = formatRetired('fast-steps', SCRIPT_OUTPUT, true, { branch: 'me/fix-login', reason: 'it is not merged' }).split('\n')
  expect(lines.slice(3)).toEqual([
    '- kept branch me/fix-login, because it is not merged',
    '',
    "This session's working directory was removed with the worktree. Continue another task with /ledger:go <slug>, or run /ledger:close.",
  ])
})

test('formatPlan without its footer ends at the plan and names no flag, for the dashboard', () => {
  const dirty: WorktreeState = { ...CLEAN, dirty: 2, ahead: 3 }
  for (const state of [CLEAN, dirty]) {
    const lines = formatPlan('fast-steps', state, OCT_5, { footer: false }).split('\n')
    expect(lines).toEqual(formatPlan('fast-steps', state, OCT_5).split('\n').slice(0, -2))
    expect(lines.join('\n')).not.toMatch(/--yes|--dry-run|--force/)
  }
})
