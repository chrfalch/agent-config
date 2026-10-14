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
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain
    .split('\0\0')
    .map(block => block.split('\0'))
    .filter(lines => lines.some(line => line.startsWith('worktree ')))
    .slice(1)
    .filter(lines => !lines.some(line => line === 'prunable' || line.startsWith('prunable ')))
    .map(lines => ({
      path: lines.find(line => line.startsWith('worktree '))?.slice('worktree '.length) ?? '',
      branch: lines.find(line => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? '',
    }))
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

export type WorktreesCommand = { kind: 'table' } | { kind: 'prune'; name: string; confirmed: boolean } | { kind: 'usage' }

export const USAGE = 'Usage: `/worktrees` or `/worktrees prune <name> [--yes]`'

export function parseCommand(args: string): WorktreesCommand {
  const trimmed = args.trim()
  if (trimmed === '') return { kind: 'table' }
  const words = trimmed.match(/^prune\s+(.+)$/s)?.[1]
  if (words === undefined) return { kind: 'usage' }
  const confirmedName = words.match(/^(.+?)\s+--yes$/s)?.[1]
  const name = confirmedName ?? words
  return name === '--yes' ? { kind: 'usage' } : { kind: 'prune', name, confirmed: confirmedName !== undefined }
}

const BUILD_FOLDER_NAMES = new Set(['node_modules', '.build', '.expo-prebuild', '.cache', 'Pods', 'build', '.DerivedData'])

export function ignoredBuildFolders(porcelain: string, root: string): string[] {
  return porcelain
    .split('\n')
    .filter(line => line.startsWith('!! ') && line.endsWith('/'))
    .map(line => line.slice('!! '.length, -1))
    // git quotes a path with special characters in it; such a path is left alone rather than unquoted.
    .filter(path => !path.startsWith('"'))
    .filter(path => {
      const segments = path.split('/')
      return BUILD_FOLDER_NAMES.has(segments.at(-1) ?? '') && !segments.includes('.claude')
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

/** The folder a path may be deleted from: the worktree for a folder strictly inside it and outside its `.claude`, DerivedData for one of its own Xcode build folders, else null. */
export function pruneBase(path: string, { root, derivedData, prefix }: PruneScope): string | null {
  const segments = path.split('/')
  if (segments.includes('..') || segments.includes('.')) return null
  if (path.startsWith(`${root}/`)) {
    const inside = path.slice(root.length + 1).split('/')
    return inside.every(segment => segment !== '' && segment !== '.claude') ? root : null
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
  if (inside.split('/').includes('.claude')) return `it resolves to ${realPath}, inside a .claude folder.`
  return undefined
}

export type PruneFolder = { path: string; label: string; sizeGb: number | null }

export const folderLabel = (path: string, root: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : `~/Library/Developer/Xcode/DerivedData/${basename(path)}`

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
    `Run \`/worktrees prune ${name} --yes\` to delete them.`,
  ].join('\n')
}

export function formatPruned(name: string, deleted: PruneFolder[], failures: string[]): string {
  return [
    `**Pruned ${name}** · ${gb(deleted)} GB freed in ${folderCount(deleted)}`,
    ...(deleted.length > 0 ? ['', ...pruneTable(deleted)] : []),
    ...(failures.length > 0 ? ['', ...failures] : []),
  ].join('\n')
}
