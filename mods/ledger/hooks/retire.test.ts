import { expect, test } from 'claude-code/testing'

import {
  archivePath,
  defaultBranchOf,
  formatPlan,
  formatRetired,
  formatRetireFailed,
  isInside,
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

test('parseRetireArgs takes an optional slug and the two flags in any order', () => {
  expect(parseRetireArgs('')).toEqual({ kind: 'retire', slug: null, confirmed: false, forced: false })
  expect(parseRetireArgs('  ')).toEqual({ kind: 'retire', slug: null, confirmed: false, forced: false })
  expect(parseRetireArgs('fix-login')).toEqual({ kind: 'retire', slug: 'fix-login', confirmed: false, forced: false })
  expect(parseRetireArgs('--force --yes fix-login')).toEqual({ kind: 'retire', slug: 'fix-login', confirmed: true, forced: true })
  expect(parseRetireArgs('--yes')).toEqual({ kind: 'retire', slug: null, confirmed: true, forced: false })
})

test('parseRetireArgs answers with usage for a second word or an unknown flag', () => {
  expect(parseRetireArgs('fix-login new-api')).toEqual({ kind: 'usage' })
  expect(parseRetireArgs('fix-login --yess')).toEqual({ kind: 'usage' })
  expect(parseRetireArgs('-y')).toEqual({ kind: 'usage' })
})

test('the usage text says what happens without --yes and where the slugs are', () => {
  expect(RETIRE_USAGE).toContain('Usage: /ledger:retire [<slug>] [--yes] [--force]. Without --yes it only shows what would be retired.')
  expect(RETIRE_USAGE).toContain('/ledger')
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
  expect(parseMergedPr('[{"number":51},{"number":40}]')).toEqual({ kind: 'merged', number: 51 })
  expect(parseMergedPr('Loading...')).toEqual({ kind: 'unknown', error: 'gh pr list printed something that is not a JSON list' })
  expect(parseMergedPr('{"number":5}')).toEqual({ kind: 'unknown', error: 'gh pr list printed something that is not a JSON list' })
})

const CLEAN: WorktreeState = {
  path: '/repo/.claude/worktrees/fix-login',
  mainCheckout: '/repo',
  branch: 'me/fix-login',
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
  expect(retireBlockers({ ...CLEAN, ahead: 2, mergedPr: { kind: 'merged', number: 7 } })).toEqual([])
  expect(retireBlockers({ ...CLEAN, ahead: 2, mergedPr: { kind: 'unknown', error: 'gh: auth' } })).toEqual(['its branch is not merged'])
  expect(retireBlockers({ ...CLEAN, ahead: 0, mergedPr: { kind: 'unknown', error: 'gh: auth' } })).toEqual([])
})

const OCT_5 = new Date(2026, 9, 5, 23, 30)

test('archivePath names the archive after the main checkout and the last segment of the branch', () => {
  expect(archivePath(CLEAN, OCT_5)).toBe('~/.claude/ledger-archive/repo/2026-10-05-fix-login.md')
  expect(archivePath({ ...CLEAN, branch: '' }, OCT_5)).toBe('~/.claude/ledger-archive/repo/2026-10-05-fix-login.md')
  expect(archivePath({ ...CLEAN, branch: '', path: '/elsewhere/detached-wt' }, OCT_5)).toBe('~/.claude/ledger-archive/repo/2026-10-05-detached-wt.md')
})

test('formatPlan for a clean, merged worktree asks only for --yes', () => {
  expect(formatPlan('fast-steps', { ...CLEAN, ahead: 1, mergedPr: { kind: 'merged', number: 24 } }, OCT_5)).toBe(
    [
      '**Retire fast-steps** — nothing done yet',
      '- worktree: /repo/.claude/worktrees/fix-login',
      '- branch: me/fix-login · 1 commit ahead of origin/main · merged PR #24',
      '- uncommitted changes: none',
      '- archive: ~/.claude/ledger-archive/repo/2026-10-05-fix-login.md',
      "- then: git worktree remove, and the worktree's cc-dd-path build folders are deleted",
      '',
      'Add --yes to retire it.',
    ].join('\n'),
  )
})

test('formatPlan for dirty, unmerged work asks for --yes --force and says why', () => {
  const state: WorktreeState = { ...CLEAN, dirty: 2, ahead: 3, defaultBranch: 'develop', mergedPr: { kind: 'unknown', error: 'gh pr list failed (exit 4): auth required' } }
  const lines = formatPlan('fast-steps', state, OCT_5).split('\n')
  expect(lines[2]).toBe('- branch: me/fix-login · 3 commits ahead of origin/develop · could not check PRs: gh pr list failed (exit 4): auth required')
  expect(lines[3]).toBe('- uncommitted changes: 2')
  expect(lines.at(-1)).toBe('Add --yes --force to retire it: it has 2 uncommitted changes and its branch is not merged')
})

test('an ahead count git could not give counts as unmerged unless a merged PR exists, and the plan says why', () => {
  const unknown: WorktreeState = { ...CLEAN, ahead: { error: "fatal: bad revision 'origin/main..HEAD'" } }
  expect(retireBlockers(unknown)).toEqual(['its branch is not merged'])
  expect(retireBlockers({ ...unknown, mergedPr: { kind: 'merged', number: 7 } })).toEqual([])
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
