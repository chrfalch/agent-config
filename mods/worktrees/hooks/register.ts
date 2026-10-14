import type { EngineInterface, FsStat, Register } from 'claude-code'

import {
  basename,
  derivedDataPrefix,
  dirtyCount,
  folderLabel,
  formatPruned,
  formatPrunePlan,
  formatTable,
  ignoredBuildFolders,
  isEmptyFolder,
  isOwnXcodeFolder,
  parseCommand,
  parsePrs,
  parseWorktrees,
  prLabel,
  pruneBase,
  realPathProblem,
  shortDate,
  sizeGb,
  USAGE,
  type PruneFolder,
  type PruneScope,
  type PullRequest,
  type Worktree,
  type WorktreeRow,
} from './worktrees'

type Ran = { stdout: string; failure?: string }

type PrLookup = { prs: PullRequest[] | null; error?: string }

async function run($: EngineInterface, argv: string[], cwd: string): Promise<Ran> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv, { cwd })
    return exitCode === 0 ? { stdout } : { stdout, failure: `failed (exit ${exitCode}): ${stderr.trim()}` }
  } catch (error) {
    return { stdout: '', failure: `did not run: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const okStdout = ({ stdout, failure }: Ran): string | null => (failure === undefined ? stdout : null)

async function lookUpPrs($: EngineInterface, branch: string, cwd: string): Promise<PrLookup> {
  if (branch === '') return { prs: [] }
  const { stdout, failure } = await run($, ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,number'], cwd)
  if (failure !== undefined) return { prs: null, error: `gh pr list ${failure}` }
  const prs = parsePrs(stdout)
  return prs ? { prs } : { prs: null, error: 'gh pr list printed something that is not a JSON list' }
}

async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

async function probe($: EngineInterface, { path, branch }: Worktree, cwd: string): Promise<{ row: WorktreeRow; prError?: string }> {
  const [du, status, log, hasLedger, { prs, error }] = await Promise.all([
    run($, ['du', '-sk', path], cwd),
    run($, ['git', '-C', path, 'status', '--porcelain'], cwd),
    run($, ['git', '-C', path, 'log', '-1', '--format=%cs'], cwd),
    isFile($, `${path}/.claude/ledger.md`),
    lookUpPrs($, branch, cwd),
  ])
  const statusStdout = okStdout(status)
  const logStdout = okStdout(log)
  const row = {
    name: basename(path),
    // du exits non-zero when it cannot read some file, yet still prints the total of what it could.
    sizeGb: sizeGb(du.stdout),
    lastCommit: logStdout === null ? null : shortDate(logStdout),
    dirty: statusStdout === null ? null : dirtyCount(statusStdout),
    hasLedger,
    pr: prLabel(prs),
  }
  return { row, prError: error }
}

async function linkedWorktrees($: EngineInterface, cwd: string): Promise<{ worktrees: Worktree[]; error?: string }> {
  const list = await run($, ['git', 'worktree', 'list', '--porcelain', '-z'], cwd)
  if (list.failure !== undefined) return { worktrees: [], error: `Could not list worktrees. git worktree list ${list.failure}` }
  const listed = parseWorktrees(list.stdout)
  const present = await Promise.all(listed.map(({ path }) => $.fs.exists(path)))
  return { worktrees: listed.filter((_, index) => present[index]) }
}

async function table($: EngineInterface, worktrees: Worktree[], cwd: string): Promise<string> {
  const probes = await Promise.all(worktrees.map(worktree => probe($, worktree, cwd)))
  return formatTable(
    probes.map(({ row }) => row),
    probes.find(({ prError }) => prError !== undefined)?.prError,
  )
}

async function pruneScope($: EngineInterface, root: string): Promise<PruneScope> {
  const home = await $.env.get('HOME')
  return {
    root,
    derivedData: home?.startsWith('/') ? `${home}/Library/Developer/Xcode/DerivedData` : null,
    prefix: await derivedDataPrefix(root),
  }
}

async function xcodeBuildFolders($: EngineInterface, { derivedData, prefix }: PruneScope): Promise<string[]> {
  if (derivedData === null) return []
  try {
    const entries = await $.fs.list(derivedData)
    return entries.filter(({ name, kind }) => kind === 'dir' && isOwnXcodeFolder(name, prefix)).map(({ name }) => `${derivedData}/${name}`)
  } catch {
    return []
  }
}

const resolve = ($: EngineInterface, path: string): Promise<FsStat | undefined> => $.fs.stat(path, { resolve: true }).catch(() => undefined)

/** Why `rm -rf` must not touch the path, judged on where it really lands rather than how it is spelled; undefined when it may. */
async function deletionProblem($: EngineInterface, path: string, scope: PruneScope): Promise<string | undefined> {
  const base = pruneBase(path, scope)
  if (base === null) return 'it is not a build folder of this worktree.'
  const [own, allowed] = await Promise.all([resolve($, path), resolve($, base)])
  if (own?.isLink) return 'it is a symbolic link.'
  if (own?.realPath === undefined) return 'its real path could not be resolved.'
  if (allowed?.realPath === undefined) return `the real path of ${base} could not be resolved.`
  return realPathProblem(own.realPath, allowed.realPath)
}

async function deleteFolder($: EngineInterface, folder: PruneFolder, scope: PruneScope, cwd: string): Promise<string | undefined> {
  const problem = await deletionProblem($, folder.path, scope)
  if (problem !== undefined) return `Skipped ${folder.path}: ${problem}`
  const { failure } = await run($, ['rm', '-rf', '--', folder.path], cwd)
  return failure === undefined ? undefined : `Could not delete ${folder.label}: rm ${failure}`
}

async function prune($: EngineInterface, worktrees: Worktree[], name: string, confirmed: boolean, cwd: string): Promise<string> {
  const [match, ...others] = worktrees.filter(({ path }) => basename(path) === name)
  if (match === undefined) {
    const names = worktrees.map(({ path }) => basename(path)).join(', ') || 'none'
    return `No linked worktree named "${name}". Worktrees: ${names}`
  }
  if (others.length > 0) return `Two or more linked worktrees are named "${name}": ${[match, ...others].map(({ path }) => path).join(', ')}`

  const scope = await pruneScope($, match.path)
  const [ignored, xcodePaths] = await Promise.all([
    run($, ['git', '-C', match.path, 'status', '--ignored', '--porcelain'], cwd),
    xcodeBuildFolders($, scope),
  ])
  if (ignored.failure !== undefined) return `Could not read the ignored files of ${name}. git status ${ignored.failure}`
  const sized = await Promise.all(
    [...ignoredBuildFolders(ignored.stdout, match.path), ...xcodePaths].map(async path => ({
      path,
      label: folderLabel(path, match.path),
      sizeGb: sizeGb((await run($, ['du', '-sk', path], cwd)).stdout),
    })),
  )
  const folders = sized.filter(folder => !isEmptyFolder(folder))
  if (!confirmed || folders.length === 0) return formatPrunePlan(name, folders)

  const failures = await Promise.all(folders.map(folder => deleteFolder($, folder, scope, cwd)))
  return formatPruned(
    name,
    folders.filter((_, index) => failures[index] === undefined),
    failures.filter(failure => failure !== undefined),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'worktrees',
      description:
        "Show each linked git worktree's size, last commit, dirty files, ledger and PR, largest first. `prune <name>` lists a worktree's build folders; add `--yes` to delete them.",
      argumentHint: '[prune <name> [--yes]]',
    })
    return next(e)
  })

  on('command.run', { command: 'worktrees' }, async ($, e) => {
    // Typed as always a string, but `claude plugin test` leaves it undefined when the caller omits it.
    const command = parseCommand(e.args ?? '')
    if (command.kind === 'usage') return { text: USAGE }
    const cwd = await $.session.cwd()
    const { worktrees, error } = await linkedWorktrees($, cwd)
    if (error !== undefined) return { text: error }
    return {
      text: command.kind === 'table' ? await table($, worktrees, cwd) : await prune($, worktrees, command.name, command.confirmed, cwd),
    }
  })
}
