import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { ARCHIVE_USAGE, parseArchiveArgs } from './archive'

const HOME = '/home/me'
const ROOT = `${HOME}/.claude/ledger-archive`

const ledger = (slug: string, branch: string, goal: string, extra = ''): string =>
  `# Task ledger — ${slug}\n\nRead this first.\n\n## Goal\n\n${goal}\nMore goal.\n\n## Location\n- worktree: /repo/.claude/worktrees/${slug}\n- branch: ${branch}\n- base: main @ abc1234\n${extra}`

type Folder = Record<string, { text: string; mtimeMs?: number }>

/** `unreadable` names repo folders that exist but cannot be listed. */
type Setup = { cwd?: string; folders: Record<string, Folder>; unreadable?: string[]; gitDirs?: string | null; home?: string | null }

function world(on: On, { cwd = '/repo/.claude/worktrees/x', folders, unreadable = [], gitDirs = '/repo/.git\n', home = HOME }: Setup): string[] {
  const reads: string[] = []
  on('session.cwd', async () => ({ value: cwd }))
  if (home === null) mock.env(on, {})
  else mock.env(on, { HOME: home })
  on('process.run', async (_, e: { argv: string[] }) => {
    const expected = ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir']
    if (JSON.stringify(e.argv) !== JSON.stringify(expected)) return { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
    return gitDirs === null
      ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 0, stdout: gitDirs, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })
  const repoOf = (path: string) => (path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : '')
  on('fs.exists', async (_, e: { path: string }) => ({ value: e.path === ROOT || repoOf(e.path) in folders || unreadable.includes(repoOf(e.path)) }))
  on('fs.list', async (_, e: { path: string }) => {
    if (e.path === ROOT) return { value: Object.keys(folders).map(repo => entry(repo, 'dir')) }
    if (unreadable.includes(repoOf(e.path))) return { deny: `EACCES: permission denied, scandir '${e.path}'` }
    const repo = folders[repoOf(e.path)]
    if (repo === undefined) return { deny: `ENOENT: no such directory ${e.path}` }
    return { value: [...Object.keys(repo).map(name => entry(name, 'file')), entry('notes', 'dir')] }
  })
  const fileOf = (path: string) => {
    const [repo = '', name = ''] = path.slice(ROOT.length + 1).split('/')
    return folders[repo]?.[name]
  }
  on('fs.read', async (_, e: { path: string }) => {
    reads.push(e.path)
    const file = fileOf(e.path)
    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: file.text }
  })
  on('fs.stat', async (_, e: { path: string }) => {
    const file = fileOf(e.path)
    return file === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file', size: 0, mtimeMs: file.mtimeMs ?? 0, isLink: false } }
  })
  on('fs.write', async () => ({ deny: '/ledger:archive must not write' }))
  return reads
}

const REPO_FOLDER: Folder = {
  '2026-09-30-old-task.md': { text: ledger('old-task', 'me/old-task', 'Fix the Login button.') },
  '2026-10-05-fix-login.md': { text: ledger('fix-login', 'me/fix-login', 'Users can log in again.'), mtimeMs: 1 },
  '2026-10-05-new-api.md': { text: ledger('new-api', 'me/new-api', 'Ship the new API.', '\n## Next step\nRun the LOGIN tests.\n'), mtimeMs: 2 },
  'README.txt': { text: 'not a ledger' },
}

test('parseArchiveArgs reads a term of any length and --all, and refuses other flags', () => {
  expect(parseArchiveArgs('')).toEqual({ kind: 'list', term: '', all: false })
  expect(parseArchiveArgs('  log   in --all ')).toEqual({ kind: 'list', term: 'log in', all: true })
  expect(parseArchiveArgs('--yes')).toEqual({ kind: 'usage' })
})

test('/ledger:archive with an unknown flag answers with usage', async ($, on) => {
  world(on, { folders: {} })
  const { text } = await $.command.run({ command: 'ledger:archive', args: '--force' })
  expect(text).toBe(ARCHIVE_USAGE)
})

test("/ledger:archive lists this repo's archived ledgers, newest first, one line each", async ($, on) => {
  world(on, { folders: { repo: REPO_FOLDER, other: { '2026-10-10-elsewhere.md': { text: ledger('elsewhere', 'me/elsewhere', 'Other repo.') } } } })
  const { text } = await $.command.run({ command: 'ledger:archive' })
  expect(text).toBe(
    [
      '**Archived ledgers** · repo · 3 ledgers, newest first',
      '',
      '- 2026-10-05 · new-api · me/new-api · Ship the new API.',
      '- 2026-10-05 · fix-login · me/fix-login · Users can log in again.',
      '- 2026-09-30 · old-task · me/old-task · Fix the Login button.',
    ].join('\n'),
  )
})

test('/ledger:archive from the main checkout finds the same folder', async ($, on) => {
  world(on, { cwd: '/repo', folders: { repo: REPO_FOLDER } })
  const { text } = await $.command.run({ command: 'ledger:archive', args: '' })
  expect(text.split('\n')[0]).toBe('**Archived ledgers** · repo · 3 ledgers, newest first')
})

test('/ledger:archive <term> keeps the ledgers that contain it, in any case, with the first matching line', async ($, on) => {
  world(on, { folders: { repo: REPO_FOLDER } })
  const { text } = await $.command.run({ command: 'ledger:archive', args: 'login' })
  expect(text).toBe(
    [
      '**Archived ledgers** · repo · 3 ledgers that contain "login", newest first',
      '',
      '- 2026-10-05 · new-api · me/new-api · Ship the new API.',
      '  - match: Run the LOGIN tests.',
      '- 2026-10-05 · fix-login · me/fix-login · Users can log in again.',
      '  - match: # Task ledger — fix-login',
      '- 2026-09-30 · old-task · me/old-task · Fix the Login button.',
      '  - match: Fix the Login button.',
    ].join('\n'),
  )
})

test('/ledger:archive <term> with one match says 1 ledger', async ($, on) => {
  world(on, { folders: { repo: REPO_FOLDER } })
  const { text } = await $.command.run({ command: 'ledger:archive', args: 'new api' })
  expect(text.split('\n')).toEqual([
    '**Archived ledgers** · repo · 1 ledger that contains "new api"',
    '',
    '- 2026-10-05 · new-api · me/new-api · Ship the new API.',
    '  - match: Ship the new API.',
  ])
})

test('/ledger:archive <term> that no ledger contains says so in one line', async ($, on) => {
  world(on, { folders: { repo: REPO_FOLDER } })
  const { text } = await $.command.run({ command: 'ledger:archive', args: 'nothing-like-this' })
  expect(text).toBe('No archived ledger in ~/.claude/ledger-archive/repo/ contains "nothing-like-this".')
})

test('/ledger:archive with an empty or missing folder says so in one line', async ($, on) => {
  world(on, { folders: { other: REPO_FOLDER } })
  const { text } = await $.command.run({ command: 'ledger:archive' })
  expect(text).toBe('No archived ledgers in ~/.claude/ledger-archive/repo/.')
})

test('/ledger:archive reports a folder it cannot list, in one line with the path and the error', async ($, on) => {
  world(on, { folders: {}, unreadable: ['repo'] })
  const { text } = await $.command.run({ command: 'ledger:archive' })
  expect(text).toMatch(/^Could not list ~\/\.claude\/ledger-archive\/repo\/: .*EACCES: permission denied, scandir '[^']*\/repo'$/)
})

test('/ledger:archive --all lists every repo folder, newest first, and names the repo on each line', async ($, on) => {
  world(on, {
    cwd: '/not/a/repo',
    gitDirs: null,
    folders: { repo: REPO_FOLDER, other: { '2026-10-10-elsewhere.md': { text: ledger('elsewhere', 'me/elsewhere', 'Other repo.') } } },
  })
  const { text } = await $.command.run({ command: 'ledger:archive', args: '--all' })
  expect(text).toBe(
    [
      '**Archived ledgers** · every repo · 4 ledgers, newest first',
      '',
      '- 2026-10-10 · other · elsewhere · me/elsewhere · Other repo.',
      '- 2026-10-05 · repo · new-api · me/new-api · Ship the new API.',
      '- 2026-10-05 · repo · fix-login · me/fix-login · Users can log in again.',
      '- 2026-09-30 · repo · old-task · me/old-task · Fix the Login button.',
    ].join('\n'),
  )
})

test('/ledger:archive --all with no archive says so in one line', async ($, on) => {
  world(on, { folders: {} })
  const { text } = await $.command.run({ command: 'ledger:archive', args: '--all' })
  expect(text).toBe('No archived ledgers in ~/.claude/ledger-archive/.')
})

test('/ledger:archive outside a git repository asks for --all', async ($, on) => {
  world(on, { cwd: '/tmp', gitDirs: null, folders: { repo: REPO_FOLDER } })
  const { text } = await $.command.run({ command: 'ledger:archive' })
  expect(text).toBe(
    'Could not tell which repo /tmp is in. git rev-parse --path-format=absolute --git-common-dir failed (exit 128): fatal: not a git repository. Add --all to list the archive of every repo.',
  )
})

test('/ledger:archive without HOME says why', async ($, on) => {
  world(on, { folders: { repo: REPO_FOLDER }, home: null })
  const { text } = await $.command.run({ command: 'ledger:archive' })
  expect(text).toBe('Could not find the ledger archive: HOME is not set.')
})

test('/ledger:archive keeps a ledger without a goal or branch on its line', async ($, on) => {
  world(on, { folders: { repo: { '2026-10-01-bare.md': { text: '# Task ledger — bare\n' } } } })
  const { text } = await $.command.run({ command: 'ledger:archive' })
  expect(text.split('\n').at(-1)).toBe('- 2026-10-01 · bare')
})
