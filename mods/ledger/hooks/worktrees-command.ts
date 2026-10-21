import type { EngineInterface, FsStat } from 'claude-code'

import { summarize } from './ledger'
import { sessionFolder } from './lookup'
import {
  basename,
  classifyDerivedData,
  derivedDataPrefix,
  dirtyCount,
  folderLabel,
  formatDerivedData,
  formatOrphanPlan,
  formatPruned,
  formatPrunedOrphans,
  formatPrunePlan,
  formatTable,
  ignoredBuildFolders,
  isDirectChild,
  isDiskConnected,
  isEmptyFolder,
  isOrphan,
  isOwnXcodeFolder,
  ledgerRole,
  parseCommand,
  parseMainWorktree,
  parsePrs,
  parseWorktrees,
  prLabel,
  pruneBase,
  realPathProblem,
  shortDate,
  sizeGb,
  USAGE,
  volumeOf,
  workspacePathOf,
  type DerivedDataEntry,
  type DerivedDataFolder,
  type PruneFolder,
  type PruneScope,
  type PullRequest,
  type RepoLayout,
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

export async function lookUpPrs($: EngineInterface, branch: string, cwd: string): Promise<PrLookup> {
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

async function ledgerCell($: EngineInterface, ledger: string): Promise<Pick<WorktreeRow, 'hasLedger' | 'ledgerRole'>> {
  if (!(await isFile($, ledger))) return { hasLedger: false }
  try {
    const role = ledgerRole(summarize(await $.fs.read(ledger), '', 0))
    return role === undefined ? { hasLedger: true } : { hasLedger: true, ledgerRole: role }
  } catch {
    return { hasLedger: true }
  }
}

async function probe($: EngineInterface, { path, branch }: Worktree, cwd: string): Promise<{ row: WorktreeRow; prError?: string }> {
  const [du, status, log, ledger, { prs, error }] = await Promise.all([
    run($, ['du', '-sk', path], cwd),
    run($, ['git', '-C', path, 'status', '--porcelain'], cwd),
    run($, ['git', '-C', path, 'log', '-1', '--format=%cs'], cwd),
    ledgerCell($, `${path}/.claude/ledger.md`),
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
    ...ledger,
    pr: prLabel(prs),
  }
  return { row, prError: error }
}

async function linkedWorktrees($: EngineInterface, cwd: string): Promise<RepoLayout & { error?: string }> {
  const list = await run($, ['git', 'worktree', 'list', '--porcelain', '-z'], cwd)
  if (list.failure !== undefined) return { main: null, worktrees: [], error: `Could not list worktrees. git worktree list ${list.failure}` }
  const listed = parseWorktrees(list.stdout)
  const present = await Promise.all(listed.map(({ path }) => $.fs.exists(path)))
  return { main: parseMainWorktree(list.stdout), worktrees: listed.filter((_, index) => present[index]) }
}

async function table($: EngineInterface, worktrees: Worktree[], cwd: string): Promise<string> {
  const probes = await Promise.all(worktrees.map(worktree => probe($, worktree, cwd)))
  return formatTable(
    probes.map(({ row }) => row),
    probes.find(({ prError }) => prError !== undefined)?.prError,
  )
}

async function derivedDataPath($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('HOME')
  return home?.startsWith('/') ? `${home}/Library/Developer/Xcode/DerivedData` : null
}

async function pruneScope($: EngineInterface, root: string): Promise<PruneScope> {
  return { root, derivedData: await derivedDataPath($), prefix: await derivedDataPrefix(root) }
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

function resolve($: EngineInterface, path: string): Promise<FsStat | undefined> {
  return $.fs.stat(path, { resolve: true }).catch(() => undefined)
}

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

async function deleteFolder($: EngineInterface, folder: PruneFolder, problem: string | undefined, cwd: string): Promise<string | undefined> {
  if (problem !== undefined) return `Skipped ${folder.path}: ${problem}`
  const { failure } = await run($, ['rm', '-rf', '--', folder.path], cwd)
  return failure === undefined ? undefined : `Could not delete ${folder.label}: rm ${failure}`
}

async function prune($: EngineInterface, worktrees: Worktree[], name: string, dryRun: boolean, cwd: string): Promise<string> {
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
  if (dryRun || folders.length === 0) return formatPrunePlan(name, folders)

  const failures = await Promise.all(folders.map(async folder => deleteFolder($, folder, await deletionProblem($, folder.path, scope), cwd)))
  return formatPruned(
    name,
    folders.filter((_, index) => failures[index] === undefined),
    failures.filter(failure => failure !== undefined),
  )
}

async function isVolumeConnected($: EngineInterface, volume: string, cwd: string): Promise<boolean> {
  // An absolute path, because GNU coreutils can come first on PATH, and its stat -f reports on the file system instead.
  const [own, volumes, link] = await Promise.all([
    run($, ['/usr/bin/stat', '-L', '-f', '%d', volume], cwd),
    run($, ['/usr/bin/stat', '-f', '%d', '/Volumes'], cwd),
    resolve($, volume),
  ])
  return isDiskConnected({ device: okStdout(own), volumesDevice: okStdout(volumes), linkTarget: link?.isLink ? (link.realPath ?? null) : null })
}

async function readDerivedDataEntry($: EngineInterface, derivedData: string, name: string, cwd: string): Promise<DerivedDataEntry> {
  // plutil reads the binary and the XML form Xcode writes alike, and fails when the file or the key is missing.
  const plist = await run($, ['plutil', '-extract', 'WorkspacePath', 'raw', '-o', '-', `${derivedData}/${name}/info.plist`], cwd)
  const workspacePath = workspacePathOf(okStdout(plist))
  if (workspacePath === null) return { name, workspacePath, exists: false, diskConnected: true }
  const volume = volumeOf(workspacePath)
  const [exists, diskConnected] = await Promise.all([$.fs.exists(workspacePath), volume === null || isVolumeConnected($, volume, cwd)])
  return { name, workspacePath, exists, diskConnected }
}

async function derivedDataFolders($: EngineInterface, derivedData: string | null, layout: RepoLayout, cwd: string): Promise<DerivedDataFolder[]> {
  if (derivedData === null) return []
  const entries = await $.fs.list(derivedData).catch(() => [])
  return Promise.all(
    entries
      .filter(({ kind }) => kind === 'dir')
      .map(async ({ name }) => {
        const path = `${derivedData}/${name}`
        const [entry, du] = await Promise.all([readDerivedDataEntry($, derivedData, name, cwd), run($, ['du', '-sk', path], cwd)])
        return { path, label: name, sizeGb: sizeGb(du.stdout), group: classifyDerivedData(entry, layout) }
      }),
  )
}

async function derivedDataReport($: EngineInterface, layout: RepoLayout, cwd: string): Promise<string> {
  return formatDerivedData(await derivedDataFolders($, await derivedDataPath($), layout, cwd))
}

/** Why `rm -rf` must not touch the folder: it must really be a folder directly inside DerivedData, and still be an orphan now; undefined when it may. */
async function orphanDeletionProblem($: EngineInterface, path: string, derivedData: string, layout: RepoLayout, cwd: string): Promise<string | undefined> {
  if (!isDirectChild(path, derivedData)) return `it is not directly inside ${derivedData}.`
  const [own, allowed] = await Promise.all([resolve($, path), resolve($, derivedData)])
  if (own?.isLink) return 'it is a symbolic link.'
  if (own?.realPath === undefined) return 'its real path could not be resolved.'
  if (allowed?.realPath === undefined) return `the real path of ${derivedData} could not be resolved.`
  if (!isDirectChild(own.realPath, allowed.realPath)) return `it resolves to ${own.realPath}, which is not directly inside ${allowed.realPath}.`
  const entry = await readDerivedDataEntry($, derivedData, basename(path), cwd)
  return isOrphan(entry, layout) ? undefined : 'it is no longer an orphan.'
}

async function pruneOrphans($: EngineInterface, layout: RepoLayout, dryRun: boolean, cwd: string): Promise<string> {
  const derivedData = await derivedDataPath($)
  const orphans = (await derivedDataFolders($, derivedData, layout, cwd)).filter(({ group }) => group.kind === 'orphan')
  if (dryRun || derivedData === null || orphans.length === 0) return formatOrphanPlan(orphans)

  const failures = await Promise.all(
    orphans.map(async folder => deleteFolder($, folder, await orphanDeletionProblem($, folder.path, derivedData, layout, cwd), cwd)),
  )
  return formatPrunedOrphans(
    orphans.filter((_, index) => failures[index] === undefined),
    failures.filter(failure => failure !== undefined),
  )
}

/** The text /ledger:worktrees answers with for the arguments the operator typed. */
export async function worktreesCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseCommand(args)
  if (command.kind === 'usage') return USAGE
  const { path: cwd } = await sessionFolder($)
  const { error, ...layout } = await linkedWorktrees($, cwd)
  if (error !== undefined) return error
  switch (command.kind) {
    case 'table':
      return table($, layout.worktrees, cwd)
    case 'prune':
      return prune($, layout.worktrees, command.name, command.dryRun, cwd)
    case 'derived-data':
      return derivedDataReport($, layout, cwd)
    case 'prune-orphans':
      return pruneOrphans($, layout, command.dryRun, cwd)
  }
}
