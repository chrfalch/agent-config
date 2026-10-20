import type { EngineInterface, ProcessRunResult } from 'claude-code'

import { folderSlug, ledgerPaths, summarize } from './ledger'
import { isInside } from './retire'
import { basename, parseWorktrees } from './worktrees'

export type Found = { path: string; slug: string; mtimeMs: number }

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

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

export async function titleSlug($: EngineInterface, path: string): Promise<string> {
  return summarize(await $.fs.read(path), folderSlug(path), 0).slug
}
