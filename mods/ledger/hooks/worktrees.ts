export type Worktree = { path: string; branch: string }

export type PullRequest = { state: string; number: number }

export type WorktreeRow = {
  name: string
  sizeGb: number | null
  lastCommit: string | null
  dirty: number | null
  hasLedger: boolean
  pr: string
}

/** Reads `git worktree list --porcelain -z`: fields end in NUL and an empty field ends a block, so a path is never quoted. */
const worktreeBlocks = (porcelain: string): string[][] =>
  porcelain
    .split('\0\0')
    .map(block => block.split('\0'))
    .filter(lines => lines.some(line => line.startsWith('worktree ')))

const worktreePath = (lines: string[]): string => lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length) ?? ''

export function parseWorktrees(porcelain: string): Worktree[] {
  return worktreeBlocks(porcelain)
    .slice(1)
    .filter(lines => !lines.some(line => line === 'prunable' || line.startsWith('prunable ')))
    .map(lines => ({
      path: worktreePath(lines),
      branch: lines.find(line => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? '',
    }))
}

/** git lists the main checkout first. */
export function parseMainWorktree(porcelain: string): string | null {
  const [main] = worktreeBlocks(porcelain)
  return main === undefined ? null : worktreePath(main)
}

export const basename = (path: string): string => path.split('/').at(-1) ?? path

export function parsePrs(stdout: string): PullRequest[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed.filter(isPullRequest) : null
}

function isPullRequest(value: unknown): value is PullRequest {
  if (typeof value !== 'object' || value === null) return false
  const { state, number } = value as Record<string, unknown>
  return typeof state === 'string' && typeof number === 'number'
}

export function prLabel(prs: PullRequest[] | null): string {
  if (prs === null) return '?'
  const [pr] = prs
  return pr ? `${pr.state} #${pr.number}` : 'none'
}

export function shortDate(stdout: string): string | null {
  return stdout.trim().match(/^\d{4}-(\d\d-\d\d)$/)?.[1] ?? null
}

export function sizeGb(duStdout: string): number | null {
  const kib = duStdout.match(/^\d+/)?.[0]
  return kib === undefined ? null : (Number(kib) * 1024) / 1e9
}

export function dirtyCount(statusStdout: string): number {
  return statusStdout.split('\n').filter(line => line !== '').length
}

const cell = (value: string | number | null): string => (value === null ? '?' : String(value))

export function formatTable(rows: WorktreeRow[], prError?: string): string {
  if (rows.length === 0) return 'No linked worktrees.'
  const sorted = [...rows].sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1))
  const totalGb = rows.reduce((sum, row) => sum + (row.sizeGb ?? 0), 0)
  const count = rows.length === 1 ? '1 worktree' : `${rows.length} worktrees, largest first`
  return [
    `**Worktrees** · ${count} · ${totalGb.toFixed(1)} GB total`,
    '',
    '| Worktree | Size GB | Last commit | Dirty | Ledger | PR |',
    '|---|---:|---|---:|---|---|',
    ...sorted.map(row => {
      const cells = [row.name, cell(row.sizeGb?.toFixed(1) ?? null), cell(row.lastCommit), cell(row.dirty), row.hasLedger ? 'yes' : 'no', row.pr]
      return `| ${cells.join(' | ')} |`
    }),
    ...(prError ? ['', `PR is ? because ${prError}`] : []),
  ].join('\n')
}

export type WorktreesCommand =
  | { kind: 'table' }
  | { kind: 'prune'; name: string; confirmed: boolean }
  | { kind: 'derived-data' }
  | { kind: 'prune-orphans'; confirmed: boolean }
  | { kind: 'usage' }

export const USAGE = 'Usage: `/ledger:worktrees`, `/ledger:worktrees prune <name> [--yes]`, `/ledger:worktrees derived-data` or `/ledger:worktrees prune-orphans [--yes]`'

export function parseCommand(args: string): WorktreesCommand {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'table' }
  if (trimmed === 'derived-data') return { kind: 'derived-data' }
  const orphans = trimmed.match(/^prune-orphans(\s+--yes)?$/)
  if (orphans !== null) return { kind: 'prune-orphans', confirmed: orphans[1] !== undefined }
  const words = trimmed.match(/^prune\s+(.+)$/s)?.[1]
  if (words === undefined) return { kind: 'usage' }
  const confirmedName = words.match(/^(.+?)\s+--yes$/s)?.[1]
  const name = confirmedName ?? words
  return name === '--yes' ? { kind: 'usage' } : { kind: 'prune', name, confirmed: confirmedName !== undefined }
}

const BUILD_FOLDER_NAMES = new Set(['.build', '.expo-prebuild', '.cache', 'build', '.DerivedData'])

/** Nothing in these is ever pruned: `.claude` holds agent state, and keeping `node_modules` and `Pods` lets a pruned worktree build without reinstalling. */
const KEPT_FOLDER_NAMES = new Set(['.claude', 'node_modules', 'Pods'])

export function ignoredBuildFolders(porcelain: string, root: string): string[] {
  return porcelain
    .split('\n')
    .filter(line => line.startsWith('!! ') && line.endsWith('/'))
    .map(line => line.slice('!! '.length, -1))
    // git quotes a path with special characters in it; such a path is left alone rather than unquoted.
    .filter(path => !path.startsWith('"'))
    .filter(path => {
      const segments = path.split('/')
      return BUILD_FOLDER_NAMES.has(segments.at(-1) ?? '') && !segments.some(segment => KEPT_FOLDER_NAMES.has(segment))
    })
    .map(path => `${root}/${path}`)
}

/** The name prefix bin/cc-dd-path gives this worktree's Xcode build folders: `cc-<basename>-<sha1 of the path, 6 hex>-`. */
export async function derivedDataPrefix(root: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(root)))
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `cc-${basename(root)}-${hex.slice(0, 6)}-`
}

/**
 * Whether a DerivedData folder name is this worktree's: it starts with `prefix`, and what follows has no
 * `<hex6>-` of its own, which would make it another worktree's whose name starts with `<basename>-<hex6>`.
 */
export const isOwnXcodeFolder = (name: string, prefix: string): boolean =>
  name.startsWith(prefix) && !/(^|-)[0-9a-f]{6}-/.test(name.slice(prefix.length))

export type PruneScope = { root: string; derivedData: string | null; prefix: string }

/** The folder a path may be deleted from: the worktree for a folder strictly inside it and outside any kept folder, DerivedData for one of its own Xcode build folders, else null. */
export function pruneBase(path: string, { root, derivedData, prefix }: PruneScope): string | null {
  const segments = path.split('/')
  if (segments.includes('..') || segments.includes('.')) return null
  if (path.startsWith(`${root}/`)) {
    const inside = path.slice(root.length + 1).split('/')
    return inside.every(segment => segment !== '' && !KEPT_FOLDER_NAMES.has(segment)) ? root : null
  }
  if (derivedData === null || !path.startsWith(`${derivedData}/`)) return null
  const name = path.slice(derivedData.length + 1)
  return !name.includes('/') && isOwnXcodeFolder(name, prefix) ? derivedData : null
}

export const isPrunable = (path: string, scope: PruneScope): boolean => pruneBase(path, scope) !== null

/** Why a folder whose real path is `realPath` may not be deleted from the folder whose real path is `realBase`; undefined when it may. */
export function realPathProblem(realPath: string, realBase: string): string | undefined {
  const inside = realPath.startsWith(`${realBase}/`) ? realPath.slice(realBase.length + 1) : ''
  if (inside === '') return `it resolves to ${realPath}, which is not inside ${realBase}.`
  const kept = inside.split('/').find(segment => KEPT_FOLDER_NAMES.has(segment))
  if (kept !== undefined) return `it resolves to ${realPath}, inside a ${kept} folder.`
  return undefined
}

export type PruneFolder = { path: string; label: string; sizeGb: number | null }

/** Whether the folder's size prints as 0.0; an unknown size does not count as empty. */
export const isEmptyFolder = ({ sizeGb }: PruneFolder): boolean => sizeGb !== null && sizeGb < 0.05

const DERIVED_DATA_LABEL = '~/Library/Developer/Xcode/DerivedData'

export const folderLabel = (path: string, root: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : `${DERIVED_DATA_LABEL}/${basename(path)}`

const gb = (folders: PruneFolder[]): string => folders.reduce((sum, { sizeGb }) => sum + (sizeGb ?? 0), 0).toFixed(1)

const folderCount = (folders: PruneFolder[]): string => (folders.length === 1 ? '1 folder' : `${folders.length} folders`)

function pruneTable(folders: PruneFolder[]): string[] {
  const sorted = [...folders].sort((a, b) => (b.sizeGb ?? -1) - (a.sizeGb ?? -1))
  return ['| Folder | Size GB |', '|---|---:|', ...sorted.map(({ label, sizeGb }) => `| ${label} | ${cell(sizeGb?.toFixed(1) ?? null)} |`)]
}

export function formatPrunePlan(name: string, folders: PruneFolder[]): string {
  if (folders.length === 0) return `Nothing to prune in ${name}.`
  return [
    `**Prune ${name}** · dry run · ${gb(folders)} GB in ${folderCount(folders)}`,
    '',
    ...pruneTable(folders),
    '',
    'Folders inside a `.claude` folder are never deleted.',
    '`node_modules` and `Pods` folders are kept, so the worktree still builds.',
    `Run \`/ledger:worktrees prune ${name} --yes\` to delete them.`,
  ].join('\n')
}

export function formatPruned(name: string, deleted: PruneFolder[], failures: string[]): string {
  return [
    `**Pruned ${name}** · ${gb(deleted)} GB freed in ${folderCount(deleted)}`,
    ...(deleted.length > 0 ? ['', ...pruneTable(deleted)] : []),
    ...(failures.length > 0 ? ['', ...failures] : []),
  ].join('\n')
}

/**
 * `workspacePath` is the WorkspacePath of the folder's info.plist as `workspacePathOf` reads it, null when it has none;
 * `exists` says whether that path is on disk, and `diskConnected` whether the disk that holds it is mounted.
 */
export type DerivedDataEntry = { name: string; workspacePath: string | null; exists: boolean; diskConnected: boolean }

/** `main` is the main checkout, null when git did not name one. */
export type RepoLayout = { main: string | null; worktrees: Worktree[] }

export type DerivedDataGroup =
  | { kind: 'main' }
  | { kind: 'worktree'; path: string }
  | { kind: 'other' }
  | { kind: 'disk-not-connected' }
  | { kind: 'orphan' }
  | { kind: 'no-source' }
  | { kind: 'cache' }

export type DerivedDataFolder = PruneFolder & { group: DerivedDataGroup }

/**
 * Reads the stdout of `plutil -extract WorkspacePath raw`, null when plutil failed. plutil ends the value with a newline;
 * only an absolute path counts, and its `.` and `..` segments are resolved so a prefix match cannot be fooled by them.
 */
export function workspacePathOf(plutilStdout: string | null): string | null {
  if (plutilStdout === null) return null
  const path = plutilStdout.endsWith('\n') ? plutilStdout.slice(0, -1) : plutilStdout
  return path.startsWith('/') ? resolveAbsolute(path) : null
}

/** What `path.resolve` returns for an absolute path; a hooks module may not import `node:path`. */
function resolveAbsolute(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') segments.pop()
    else if (segment !== '' && segment !== '.') segments.push(segment)
  }
  return `/${segments.join('/')}`
}

/** The `/Volumes/<name>` folder macOS mounts a disk at, when the path is inside one. */
export const volumeOf = (path: string): string | null => /^\/Volumes\/[^/]+(?=\/.)/.exec(path)?.[0] ?? null

export type VolumeProbe = {
  /** `/usr/bin/stat -L -f %d /Volumes/<name>` output; null when stat failed. */
  device: string | null
  /** `/usr/bin/stat -f %d /Volumes` output; null when stat failed. */
  volumesDevice: string | null
  /** The folder's real path when it is a symbolic link, else null. */
  linkTarget: string | null
}

const deviceNumber = (statStdout: string | null): string | null => /^(\d+)\n?$/.exec(statStdout ?? '')?.[1] ?? null

/**
 * A mounted disk sits on another device than `/Volumes`; an unmount can leave an empty folder behind on the `/Volumes`
 * device itself. The boot disk is the exception: macOS links it there to `/`, which shares the `/Volumes` device.
 */
export function isDiskConnected({ device, volumesDevice, linkTarget }: VolumeProbe): boolean {
  if (linkTarget === '/') return true
  const [own, volumes] = [deviceNumber(device), deviceNumber(volumesDevice)]
  return own !== null && volumes !== null && own !== volumes
}

/** Groups by the folder's WorkspacePath, never its name; a workspace belongs to the linked worktree with the longest matching root, since linked worktrees can sit inside the main checkout and inside each other. */
export function classifyDerivedData({ name, workspacePath, exists, diskConnected }: DerivedDataEntry, { main, worktrees }: RepoLayout): DerivedDataGroup {
  if (name.endsWith('.noindex') || name === 'SDKExplicitPrecompiledModules') return { kind: 'cache' }
  if (workspacePath === null) return { kind: 'no-source' }
  if (!exists) return diskConnected ? { kind: 'orphan' } : { kind: 'disk-not-connected' }
  const [worktree] = worktrees.filter(({ path }) => workspacePath.startsWith(`${path}/`)).sort((a, b) => b.path.length - a.path.length)
  if (worktree !== undefined) return { kind: 'worktree', path: worktree.path }
  return main !== null && workspacePath.startsWith(`${main}/`) ? { kind: 'main' } : { kind: 'other' }
}

export const isOrphan = (entry: DerivedDataEntry, layout: RepoLayout): boolean => classifyDerivedData(entry, layout).kind === 'orphan'

export function isDirectChild(path: string, parent: string): boolean {
  const name = path.startsWith(`${parent}/`) ? path.slice(parent.length + 1) : ''
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/')
}

const GROUP_ORDER: DerivedDataGroup['kind'][] = ['main', 'worktree', 'other', 'disk-not-connected', 'orphan', 'no-source', 'cache']

const GROUP_LABELS = {
  main: 'Main checkout',
  other: 'Other location',
  'disk-not-connected': 'Disk not connected',
  orphan: 'Orphan',
  'no-source': 'No source recorded',
  cache: 'Shared caches',
} as const

const groupLabel = (group: DerivedDataGroup): string => (group.kind === 'worktree' ? `Linked worktree ${basename(group.path)}` : GROUP_LABELS[group.kind])

const groupKey = (group: DerivedDataGroup): string => (group.kind === 'worktree' ? `worktree ${group.path}` : group.kind)

const byGroup = (a: DerivedDataFolder, b: DerivedDataFolder): number =>
  GROUP_ORDER.indexOf(a.group.kind) - GROUP_ORDER.indexOf(b.group.kind) ||
  groupLabel(a.group).localeCompare(groupLabel(b.group)) ||
  groupKey(a.group).localeCompare(groupKey(b.group))

const ORPHAN_NOTE = 'An orphan was built from a project that no longer exists on disk.'

const DISK_NOT_CONNECTED_NOTE = 'A folder here was built from a project on a disk that is not connected, so it is never deleted.'

function groupLines(members: DerivedDataFolder[]): string[] {
  const { group } = members[0]
  return [
    '',
    `**${groupLabel(group)}** · ${gb(members)} GB in ${folderCount(members)}`,
    '',
    ...pruneTable(members),
    ...(group.kind === 'disk-not-connected' ? ['', DISK_NOT_CONNECTED_NOTE] : []),
  ]
}

export function formatDerivedData(folders: DerivedDataFolder[]): string {
  if (folders.length === 0) return `No folders in ${DERIVED_DATA_LABEL}.`
  const groups = new Map<string, DerivedDataFolder[]>()
  for (const folder of [...folders].sort(byGroup)) {
    const key = groupKey(folder.group)
    groups.set(key, [...(groups.get(key) ?? []), folder])
  }
  return [
    `**${DERIVED_DATA_LABEL}** · ${gb(folders)} GB in ${folderCount(folders)}`,
    ...[...groups.values()].flatMap(groupLines),
    ...(groups.has('orphan') ? ['', ORPHAN_NOTE, 'Run `/ledger:worktrees prune-orphans --yes` to delete the orphans.'] : []),
  ].join('\n')
}

const ORPHANS = `orphans in ${DERIVED_DATA_LABEL}`

export function formatOrphanPlan(orphans: PruneFolder[]): string {
  if (orphans.length === 0) return `Nothing to prune: no ${ORPHANS}.`
  return [
    `**Prune ${ORPHANS}** · dry run · ${gb(orphans)} GB in ${folderCount(orphans)}`,
    '',
    ...pruneTable(orphans),
    '',
    ORPHAN_NOTE,
    'Run `/ledger:worktrees prune-orphans --yes` to delete them.',
  ].join('\n')
}

export const formatPrunedOrphans = (deleted: PruneFolder[], failures: string[]): string => formatPruned(ORPHANS, deleted, failures)
