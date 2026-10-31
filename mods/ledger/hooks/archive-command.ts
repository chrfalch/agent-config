import type { EngineInterface, ProcessRunResult } from 'claude-code'

import {
  ARCHIVE_USAGE,
  emptyArchiveMessage,
  firstMatch,
  formatArchive,
  listFailedMessage,
  newestFirst,
  parseArchiveArgs,
  readArchived,
  type ArchivedLedger,
} from './archive'
import { message, sessionFolder } from './lookup'
import { basename } from './worktrees'

type Entry = { name: string; kind: string }

type Listing = Entry[] | { error: string }

// A folder that does not exist yet is an empty archive, not an error.
async function list($: EngineInterface, folder: string, repo: string | null): Promise<Listing> {
  try {
    return await $.fs.list(folder)
  } catch (error) {
    const exists = await $.fs.exists(folder).catch(() => true)
    return exists ? { error: listFailedMessage(repo, message(error)) } : []
  }
}

const GIT_COMMON_DIR = ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']

/** Named the way cc-worktree-retire names the archive folder: after the main checkout. */
async function repoName($: EngineInterface, cwd: string): Promise<{ name: string } | { error: string }> {
  let failure: string
  try {
    const { exitCode, stdout, stderr }: ProcessRunResult = await $.process.run(GIT_COMMON_DIR, { cwd })
    if (exitCode === 0) return { name: basename(stdout.trim().split('/').slice(0, -1).join('/')) }
    failure = `failed (exit ${exitCode}): ${stderr.trim()}`
  } catch (error) {
    failure = `did not run: ${message(error)}`
  }
  return { error: `Could not tell which repo ${cwd} is in. ${GIT_COMMON_DIR.join(' ')} ${failure}. Add --all to list the archive of every repo.` }
}

async function readFolder($: EngineInterface, root: string, repo: string, term: string): Promise<ArchivedLedger[] | { error: string }> {
  const folder = `${root}/${repo}`
  const entries = await list($, folder, repo)
  if ('error' in entries) return entries
  const names = entries.filter(({ name, kind }) => kind === 'file' && name.endsWith('.md')).map(({ name }) => name)
  const ledgers = await Promise.all(
    names.map(async name => {
      const path = `${folder}/${name}`
      const [text, { mtimeMs }] = await Promise.all([$.fs.read(path), $.fs.stat(path)])
      const ledger = readArchived(repo, name, text, mtimeMs)
      if (term === '') return ledger
      const match = firstMatch(text, term)
      return match === undefined ? null : { ...ledger, match }
    }),
  )
  return ledgers.filter(ledger => ledger !== null)
}

/**
 * The archived ledgers of the session's repo, or of every repo when `all`, newest first; with a `term`, only those that contain it.
 * `repo` is null for every repo.
 */
export async function readArchive($: EngineInterface, { term, all }: { term: string; all: boolean }): Promise<{ repo: string | null; ledgers: ArchivedLedger[] } | { error: string }> {
  const home = await $.env.get('HOME')
  if (!home?.startsWith('/')) return { error: 'Could not find the ledger archive: HOME is not set.' }
  const root = `${home}/.claude/ledger-archive`

  let repo: string | null = null
  let repos: string[]
  if (all) {
    const entries = await list($, root, null)
    if ('error' in entries) return entries
    repos = entries.filter(({ kind }) => kind === 'dir').map(({ name }) => name)
  } else {
    const found = await repoName($, (await sessionFolder($)).path)
    if ('error' in found) return found
    repo = found.name
    repos = [repo]
  }

  const folders = await Promise.all(repos.map(name => readFolder($, root, name, term)))
  const ledgers: ArchivedLedger[] = []
  for (const folder of folders) {
    if ('error' in folder) return folder
    ledgers.push(...folder)
  }
  return { repo, ledgers: ledgers.sort(newestFirst) }
}

/** The text /ledger:archive answers with. It only reads. */
export async function archiveCommand($: EngineInterface, args: string): Promise<string> {
  const command = parseArchiveArgs(args)
  if (command.kind === 'usage') return ARCHIVE_USAGE
  const archive = await readArchive($, command)
  if ('error' in archive) return archive.error
  if (archive.ledgers.length === 0) return emptyArchiveMessage(archive.repo, command.term)
  return formatArchive(archive.ledgers, archive.repo, command.term)
}
