import { summarize } from './ledger'

export type ArchiveArgs = { kind: 'list'; term: string; all: boolean } | { kind: 'usage' }

export const ARCHIVE_USAGE =
  "Usage: /ledger:archive [<term>] [--all]. Lists this repo's archived ledgers; a term keeps those that contain it, and --all lists every repo."

export function parseArchiveArgs(args: string): ArchiveArgs {
  const words = args.split(/\s+/).filter(word => word !== '')
  const flags = words.filter(word => word.startsWith('-'))
  if (flags.some(flag => flag !== '--all')) return { kind: 'usage' }
  return { kind: 'list', term: words.filter(word => !word.startsWith('-')).join(' '), all: flags.length > 0 }
}

export type ArchivedLedger = { repo: string; date: string; slug: string; branch: string; goal: string; mtimeMs: number; match?: string }

/** Reads an archive file named the way cc-worktree-retire names it: `<YYYY-MM-DD>-<slug>.md`. */
export function readArchived(repo: string, fileName: string, text: string, mtimeMs: number): ArchivedLedger {
  const named = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(fileName)
  return {
    repo,
    date: named?.[1] ?? '',
    slug: named?.[2] ?? fileName.replace(/\.md$/, ''),
    branch: /^- branch:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() ?? '',
    goal: summarize(text, '', 0).goal,
    mtimeMs,
  }
}

export function firstMatch(text: string, term: string): string | undefined {
  const needle = term.toLowerCase()
  return text
    .split('\n')
    .find(line => line.toLowerCase().includes(needle))
    ?.trim()
}

export const newestFirst = (a: ArchivedLedger, b: ArchivedLedger): number =>
  b.date.localeCompare(a.date) || b.mtimeMs - a.mtimeMs || b.slug.localeCompare(a.slug)

export const archiveFolder = (repo: string | null): string => `~/.claude/ledger-archive/${repo === null ? '' : `${repo}/`}`

export const listFailedMessage = (repo: string | null, error: string): string => `Could not list ${archiveFolder(repo)}: ${error}`

export function emptyArchiveMessage(repo: string | null, term: string): string {
  return term ? `No archived ledger in ${archiveFolder(repo)} contains "${term}".` : `No archived ledgers in ${archiveFolder(repo)}.`
}

export function countLabel(count: number, term: string): string {
  const what = count === 1 ? '1 ledger' : `${count} ledgers`
  const contains = term ? ` that contain${count === 1 ? 's' : ''} "${term}"` : ''
  return `${what}${contains}${count === 1 ? '' : ', newest first'}`
}

/** `repo` is null for a list of every repo, which then names the repo on each line. */
export function formatArchive(ledgers: ArchivedLedger[], repo: string | null, term: string): string {
  const lines = ledgers.flatMap(ledger => {
    const fields = [ledger.date, repo === null ? ledger.repo : '', ledger.slug, ledger.branch, ledger.goal].filter(field => field !== '')
    return [`- ${fields.join(' · ')}`, ...(ledger.match === undefined ? [] : [`  - match: ${ledger.match}`])]
  })
  return [`**Archived ledgers** · ${repo ?? 'every repo'} · ${countLabel(ledgers.length, term)}`, '', ...lines].join('\n')
}
