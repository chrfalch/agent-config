import { expect, mock, test } from 'claude-code/testing'

import {
  derivedDataPrefix,
  dirtyCount,
  formatTable,
  ignoredBuildFolders,
  isPrunable,
  parseCommand,
  parsePrs,
  parseWorktrees,
  prLabel,
  realPathProblem,
  shortDate,
  sizeGb,
  type WorktreeRow,
} from './worktrees'

const REPO = '/repo'
const BIG = '/repo/.claude/worktrees/big'
const SMALL = '/repo/.claude/worktrees/small'
const MISSING = '/repo/.claude/worktrees/missing'

/** What `git worktree list --porcelain -z` prints: every field ends in NUL, and an empty field ends a block. */
const porcelainZ = (...blocks: string[][]): string => blocks.map(fields => `${fields.join('\0')}\0\0`).join('')

const PORCELAIN = porcelainZ(
  [`worktree ${REPO}`, 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main'],
  [`worktree ${BIG}`, 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/me/big'],
  [`worktree ${SMALL}`, 'HEAD 3333333333333333333333333333333333333333', 'detached'],
  [
    'worktree /repo/.claude/worktrees/gone',
    'HEAD 4444444444444444444444444444444444444444',
    'branch refs/heads/me/gone',
    'prunable gitdir file points to non-existent location',
  ],
  [`worktree ${MISSING}`, 'HEAD 5555555555555555555555555555555555555555', 'branch refs/heads/me/missing'],
)

const PRS = JSON.stringify([
  { state: 'OPEN', number: 51243 },
  { state: 'CLOSED', number: 40000 },
])

const row = (name: string, sizeGb: number | null): WorktreeRow => ({
  name,
  sizeGb,
  lastCommit: '10-14',
  dirty: 0,
  hasLedger: false,
  pr: 'none',
})

test('parseWorktrees skips the main checkout and prunable entries, and reads a detached HEAD as no branch', () => {
  expect(parseWorktrees(PORCELAIN)).toEqual([
    { path: BIG, branch: 'me/big' },
    { path: SMALL, branch: '' },
    { path: MISSING, branch: 'me/missing' },
  ])
})

test('parseWorktrees finds no linked worktrees when git lists only the main checkout', () => {
  expect(parseWorktrees(porcelainZ([`worktree ${REPO}`, 'HEAD 1111', 'branch refs/heads/main']))).toEqual([])
  expect(parseWorktrees('')).toEqual([])
})

test('parseWorktrees keeps a path with spaces, quotes, tabs and newlines exactly as it is on disk', () => {
  const odd = '/repo/.claude/worktrees/my  "odd"\tname\nhere'
  expect(parseWorktrees(porcelainZ([`worktree ${REPO}`, 'HEAD 1111', 'bare'], [`worktree ${odd}`, 'HEAD 2222', 'branch refs/heads/me/odd']))).toEqual([
    { path: odd, branch: 'me/odd' },
  ])
})

test('prLabel names the first PR gh lists for the branch, with its state and number', () => {
  expect(prLabel(parsePrs(PRS))).toBe('OPEN #51243')
  expect(prLabel(parsePrs('[{"state":"MERGED","number":12}]'))).toBe('MERGED #12')
})

test('prLabel says none for a branch without a PR, and ? when gh failed', () => {
  expect(prLabel([])).toBe('none')
  expect(prLabel(null)).toBe('?')
})

test('parsePrs rejects output that is not a JSON list', () => {
  expect(parsePrs('Loading...')).toBeNull()
  expect(parsePrs('{"error":"not signed in"}')).toBeNull()
})

test('parsePrs drops list entries that are not pull requests', () => {
  expect(parsePrs('[{"state":"OPEN"},null,{"state":"OPEN","number":7}]')).toEqual([{ state: 'OPEN', number: 7 }])
})

test('shortDate keeps month and day of a YYYY-MM-DD date', () => {
  expect(shortDate('2026-10-14\n')).toBe('10-14')
  expect(shortDate('')).toBeNull()
})

test('sizeGb reads the KiB count du prints first', () => {
  expect(sizeGb('1048576\t/repo/.claude/worktrees/big\n')).toBe(1.073741824)
  expect(sizeGb('du: cannot read')).toBeNull()
  expect(sizeGb('')).toBeNull()
})

test('dirtyCount counts the lines of git status --porcelain', () => {
  expect(dirtyCount(' M a.ts\n?? b.ts\n')).toBe(2)
  expect(dirtyCount('')).toBe(0)
})

test('formatTable sorts largest first, rounds to one decimal and totals the sizes', () => {
  const rows = [row('small', 0.04), row('unknown', null), row('big', 77.26)]
  expect(formatTable(rows)).toBe(
    [
      '**Worktrees** · 3 worktrees, largest first · 77.3 GB total',
      '',
      '| Worktree | Size GB | Last commit | Dirty | Ledger | PR |',
      '|---|---:|---|---:|---|---|',
      '| big | 77.3 | 10-14 | 0 | no | none |',
      '| small | 0.0 | 10-14 | 0 | no | none |',
      '| unknown | ? | 10-14 | 0 | no | none |',
    ].join('\n'),
  )
})

test('formatTable shows ? for every probe that failed and names the gh error under the table', () => {
  const failed: WorktreeRow = { name: 'wt', sizeGb: 1.07, lastCommit: null, dirty: null, hasLedger: true, pr: '?' }
  expect(formatTable([failed], 'gh pr list did not run: spawn gh ENOENT')).toBe(
    [
      '**Worktrees** · 1 worktree · 1.1 GB total',
      '',
      '| Worktree | Size GB | Last commit | Dirty | Ledger | PR |',
      '|---|---:|---|---:|---|---|',
      '| wt | 1.1 | ? | ? | yes | ? |',
      '',
      'PR is ? because gh pr list did not run: spawn gh ENOENT',
    ].join('\n'),
  )
})

test('formatTable says so when there are no linked worktrees', () => {
  expect(formatTable([])).toBe('No linked worktrees.')
})

type Reply = { value: { exitCode: number; stdout: string; stderr: string } } | { deny: string }

const ok = (stdout: string): Reply => ({ value: { exitCode: 0, stdout, stderr: '' } })
const exit = (exitCode: number, stdout: string, stderr: string): Reply => ({ value: { exitCode, stdout, stderr } })

type Replies = Record<string, Reply>

const argvKey = (argv: readonly string[]): string => JSON.stringify(argv)

/** Replies keyed by the exact argv, so `['a b']` and `['a', 'b']` are different commands. */
const replies = (...entries: [argv: string[], reply: Reply][]): Replies =>
  Object.fromEntries(entries.map(([argv, reply]) => [argvKey(argv), reply]))

const WORKTREE_LIST = ['git', 'worktree', 'list', '--porcelain', '-z']

const ghPrList = (branch: string): string[] => ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,number']

const SMALL_ON_A_BRANCH = PORCELAIN.replace(`${SMALL}\0HEAD 3333333333333333333333333333333333333333\0detached`, `${SMALL}\0HEAD 3333\0branch refs/heads/me/small`)

function repoReplies(gh: Reply, porcelain = PORCELAIN): Replies {
  return replies(
    [WORKTREE_LIST, ok(porcelain)],
    [ghPrList('me/big'), gh],
    [['du', '-sk', BIG], ok(`75448320\t${BIG}\n`)],
    [['git', '-C', BIG, 'status', '--porcelain'], ok(' M a.ts\n?? b.ts\n')],
    [['git', '-C', BIG, 'log', '-1', '--format=%cs'], ok('2026-10-14\n')],
    [['du', '-sk', SMALL], exit(1, `2048\t${SMALL}\n`, 'du: unreadable: Permission denied')],
    [['git', '-C', SMALL, 'status', '--porcelain'], exit(128, '', 'fatal: not a git repository')],
    [['git', '-C', SMALL, 'log', '-1', '--format=%cs'], { deny: 'spawn git ENOENT' }],
  )
}

const fakeRun = (known: Replies) => async (_$: unknown, e: { argv: string[] }) =>
  known[argvKey(e.argv)] ?? { deny: `unexpected command: ${argvKey(e.argv)}` }

const fakeExists = async (_$: unknown, e: { path: string }) => ({ value: e.path === BIG || e.path === SMALL })

const fakeStat = async (_$: unknown, e: { path: string }) =>
  e.path === `${BIG}/.claude/ledger.md`
    ? { value: { kind: 'file' as const, size: 10, mtimeMs: 0 } }
    : { deny: `ENOENT: ${e.path}` }

test('/worktrees prints one row per linked worktree that exists, with a ? for each failed probe', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(repoReplies(ok(PRS))))
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toBe(
    [
      '**Worktrees** · 2 worktrees, largest first · 77.3 GB total',
      '',
      '| Worktree | Size GB | Last commit | Dirty | Ledger | PR |',
      '|---|---:|---|---:|---|---|',
      '| big | 77.3 | 10-14 | 2 | yes | OPEN #51243 |',
      '| small | 0.0 | ? | ? | no | none |',
    ].join('\n'),
  )
})

test('/worktrees still prints the table when gh fails, with ? in that PR cell and the error below', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(repoReplies(exit(4, '', 'gh auth login required'))))
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toContain('| big | 77.3 | 10-14 | 2 | yes | ? |')
  expect(text).toContain('| small | 0.0 | ? | ? | no | none |')
  expect(text.split('\n').at(-1)).toBe('PR is ? because gh pr list failed (exit 4): gh auth login required')
})

test('/worktrees still prints the table when gh is not installed', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(repoReplies({ deny: 'spawn gh ENOENT' })))
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toContain('| big | 77.3 | 10-14 | 2 | yes | ? |')
  expect(text).toContain('spawn gh ENOENT')
})

test('/worktrees asks gh about each branch on its own, so an old open PR still shows', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun({ ...repoReplies(ok(PRS), SMALL_ON_A_BRANCH), ...replies([ghPrList('me/small'), ok('[]')]) }))
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toContain('| big | 77.3 | 10-14 | 2 | yes | OPEN #51243 |')
  expect(text).toContain('| small | 0.0 | ? | ? | no | none |')
  expect(text).not.toContain('PR is ?')
})

test('/worktrees shows ? only in the row whose gh call failed', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun({ ...repoReplies(ok(PRS), SMALL_ON_A_BRANCH), ...replies([ghPrList('me/small'), ok('Loading...')]) }))
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toContain('| big | 77.3 | 10-14 | 2 | yes | OPEN #51243 |')
  expect(text).toContain('| small | 0.0 | ? | ? | no | ? |')
  expect(text.split('\n').at(-1)).toBe('PR is ? because gh pr list printed something that is not a JSON list')
})

test('/worktrees names only the first gh error when several rows failed', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on(
    'process.run',
    fakeRun({ ...repoReplies(exit(4, '', 'gh auth login required'), SMALL_ON_A_BRANCH), ...replies([ghPrList('me/small'), { deny: 'spawn gh ENOENT' }]) }),
  )
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text.split('\n').filter(line => line.startsWith('PR is ?'))).toEqual(['PR is ? because gh pr list failed (exit 4): gh auth login required'])
})

test('/worktrees runs every probe of every worktree, one gh call per branch included, at the same time', async ($, on) => {
  let inFlight = 0
  let mostInFlight = 0
  const run = fakeRun({ ...repoReplies(ok(PRS), SMALL_ON_A_BRANCH), ...replies([ghPrList('me/small'), ok('[]')]) })
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    inFlight += 1
    mostInFlight = Math.max(mostInFlight, inFlight)
    await new Promise(resolve => setTimeout(resolve, e.argv[0] === 'gh' ? 80 : 10))
    inFlight -= 1
    return run(_$, e)
  })
  on('fs.exists', fakeExists)
  on('fs.stat', fakeStat)
  await $.command.run({ command: 'worktrees' })
  expect(mostInFlight).toBe(8)
})

test('/worktrees says so when the repo has no linked worktrees', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(replies([WORKTREE_LIST, ok(porcelainZ([`worktree ${REPO}`, 'branch refs/heads/main']))])))
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toBe('No linked worktrees.')
})

test('/worktrees reports a git that cannot run instead of failing', async ($, on) => {
  on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', async () => ({ deny: 'spawn git ENOENT' }))
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toContain('Could not list worktrees.')
  expect(text).toContain('spawn git ENOENT')
})

test('/worktrees reports a failed git worktree list with its exit code and stderr', async ($, on) => {
  on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', fakeRun(replies([WORKTREE_LIST, exit(128, '', 'fatal: not a git repository')])))
  const { text } = await $.command.run({ command: 'worktrees' })
  expect(text).toBe('Could not list worktrees. git worktree list failed (exit 128): fatal: not a git repository')
})

test('parseCommand reads no arguments as the table and prune <name> [--yes] as a prune', () => {
  expect(parseCommand('')).toEqual({ kind: 'table' })
  expect(parseCommand('  ')).toEqual({ kind: 'table' })
  expect(parseCommand('prune big')).toEqual({ kind: 'prune', name: 'big', confirmed: false })
  expect(parseCommand(' prune  big  --yes ')).toEqual({ kind: 'prune', name: 'big', confirmed: true })
  expect(parseCommand('prune\tbig\t--yes')).toEqual({ kind: 'prune', name: 'big', confirmed: true })
})

test('parseCommand reads every word after prune but a final --yes as the name, with its spacing kept', () => {
  expect(parseCommand('prune my wt')).toEqual({ kind: 'prune', name: 'my wt', confirmed: false })
  expect(parseCommand('prune my  wt --yes')).toEqual({ kind: 'prune', name: 'my  wt', confirmed: true })
  expect(parseCommand('prune big --force')).toEqual({ kind: 'prune', name: 'big --force', confirmed: false })
  expect(parseCommand('prune big --yes more')).toEqual({ kind: 'prune', name: 'big --yes more', confirmed: false })
})

test('parseCommand allows a name that starts with -, but not the name --yes alone', () => {
  expect(parseCommand('prune -x')).toEqual({ kind: 'prune', name: '-x', confirmed: false })
  expect(parseCommand('prune --force --yes')).toEqual({ kind: 'prune', name: '--force', confirmed: true })
  expect(parseCommand('prune --yes')).toEqual({ kind: 'usage' })
  expect(parseCommand('prune --yes --yes')).toEqual({ kind: 'usage' })
})

test('parseCommand reads anything else as a request for usage', () => {
  for (const args of ['prune', 'prune  ', 'prunebig', 'list', 'big', 'big prune']) {
    expect(parseCommand(args)).toEqual({ kind: 'usage' })
  }
})

test('ignoredBuildFolders keeps ignored build folders on the allowlist, as absolute paths, and nothing in node_modules or Pods', () => {
  const porcelain = [
    ' M a.ts',
    '?? b.ts',
    '!! node_modules/',
    '!! packages/app/ios/Pods/',
    '!! node_modules/x/build/',
    '!! packages/app/ios/Pods/build/',
    '!! .build/',
    '!! packages/app/ios/build/',
    '!! apps/x/.expo-prebuild/',
    '!! dist/',
    '!! .env',
    '!! packages/app/build',
    '!! .claude/worktrees/nested/node_modules/',
    '!! "odd \\"name\\"/node_modules/"',
    '',
  ].join('\n')
  expect(ignoredBuildFolders(porcelain, BIG)).toEqual([
    `${BIG}/.build`,
    `${BIG}/packages/app/ios/build`,
    `${BIG}/apps/x/.expo-prebuild`,
  ])
})

test('derivedDataPrefix hashes the worktree path the way bin/cc-dd-path does', async () => {
  // printf '%s' <path> | shasum | cut -c1-6
  expect(await derivedDataPrefix(BIG)).toBe('cc-big-b4dd60-')
  expect(await derivedDataPrefix('/Users/chrfalch/repos/expo/expo/.claude/worktrees/expo-swift-manifests')).toBe('cc-expo-swift-manifests-e41f26-')
})

const HOME = '/Users/me'
const DERIVED_DATA = `${HOME}/Library/Developer/Xcode/DerivedData`
const DEBUG_SIM = `${DERIVED_DATA}/cc-big-b4dd60-Debug-sim`
const RELEASE_SIM = `${DERIVED_DATA}/cc-big-b4dd60-Release-sim`
const EMPTY_DEVICE = `${DERIVED_DATA}/cc-big-b4dd60-Debug-device`
const EMPTY_ANDROID = `${BIG}/android/build`

test('isPrunable allows only folders strictly inside the worktree and outside node_modules and Pods, or its own Xcode build folders', () => {
  const scope = { root: BIG, derivedData: DERIVED_DATA, prefix: 'cc-big-b4dd60-' }
  expect(isPrunable(`${BIG}/.build`, scope)).toBe(true)
  expect(isPrunable(DEBUG_SIM, scope)).toBe(true)
  for (const path of [
    BIG,
    `${BIG}/node_modules`,
    `${BIG}/node_modules/x/build`,
    `${BIG}/packages/app/ios/Pods`,
    `${BIG}/packages/app/ios/Pods/build`,
    `${BIG}/`,
    `${BIG}/.`,
    `${BIG}/./node_modules`,
    `${BIG}/packages/./build`,
    `${BIG}-other/node_modules`,
    `${BIG}/.claude/worktrees/x/node_modules`,
    `${BIG}/../small/node_modules`,
    REPO,
    DERIVED_DATA,
    `${DERIVED_DATA}/./cc-big-b4dd60-Debug-sim`,
    `${DERIVED_DATA}/Expo-abcdef`,
    `${DERIVED_DATA}/cc-big-000000-Debug-sim`,
    `${DEBUG_SIM}/../..`,
  ]) {
    expect(isPrunable(path, scope)).toBe(false)
  }
})

test('isPrunable leaves alone the Xcode build folders of another worktree whose name starts with this one', () => {
  const scope = { root: '/repo/.claude/worktrees/a', derivedData: DERIVED_DATA, prefix: 'cc-a-1b2c3d-' }
  expect(isPrunable(`${DERIVED_DATA}/cc-a-1b2c3d-Debug-sim`, scope)).toBe(true)
  // cc-<a-1b2c3d-x>-abcdef-Debug-sim and cc-<a-1b2c3d>-abcdef-Debug-sim
  expect(isPrunable(`${DERIVED_DATA}/cc-a-1b2c3d-x-abcdef-Debug-sim`, scope)).toBe(false)
  expect(isPrunable(`${DERIVED_DATA}/cc-a-1b2c3d-abcdef-Debug-sim`, scope)).toBe(false)
})

test('realPathProblem allows a real path strictly inside the real base and outside any .claude, node_modules or Pods folder below it', () => {
  expect(realPathProblem('/private/big/build', '/private/big')).toBeUndefined()
  expect(realPathProblem('/private/big', '/private/big')).toBe('it resolves to /private/big, which is not inside /private/big.')
  expect(realPathProblem('/private/big-other/node_modules', '/private/big')).toBe(
    'it resolves to /private/big-other/node_modules, which is not inside /private/big.',
  )
  expect(realPathProblem('/private/big/.claude/x/build', '/private/big')).toBe('it resolves to /private/big/.claude/x/build, inside a .claude folder.')
  expect(realPathProblem('/private/big/node_modules/x/build', '/private/big')).toBe(
    'it resolves to /private/big/node_modules/x/build, inside a node_modules folder.',
  )
  expect(realPathProblem('/private/big/ios/Pods', '/private/big')).toBe('it resolves to /private/big/ios/Pods, inside a Pods folder.')
})

const IGNORED = [
  '!! node_modules/',
  '!! packages/app/ios/Pods/',
  '!! node_modules/x/build/',
  '!! packages/app/ios/Pods/build/',
  '!! .build/',
  '!! packages/app/.cache/',
  '!! android/build/',
  '!! packages/app/ios/build/',
  '!! apps/x/.expo-prebuild/',
  '!! dist/',
  '!! .env',
  '!! .claude/worktrees/nested/node_modules/',
  '',
].join('\n')

const dir = (name: string, kind: 'dir' | 'other' = 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: kind === 'other' })

const fakeDerivedData = async (_$: unknown, e: { path: string }) =>
  e.path === DERIVED_DATA
    ? {
        value: [
          dir('cc-big-b4dd60-Debug-sim'),
          dir('cc-big-b4dd60-Release-sim'),
          dir('cc-big-b4dd60-Debug-device'),
          dir('cc-big-b4dd60-link', 'other'),
          dir('cc-big-b4dd60-x-abcdef-Debug-sim'),
          dir('cc-big-000000-Debug-sim'),
          dir('cc-small-b4dd60-Debug-sim'),
          dir('Expo-abcdef'),
        ],
      }
    : { deny: `ENOENT: ${e.path}` }

type FakeRealFs = { links?: string[]; realPath?: (path: string) => string | undefined }

/** Answers `$.fs.stat`: every path is a folder, `links` are symbolic links, and `realPath` says where a path lands (itself unless told). */
const fakeRealFs =
  ({ links = [], realPath = path => path }: FakeRealFs = {}) =>
  async (_$: unknown, e: { path: string; resolve: boolean }) => {
    const real = e.resolve ? realPath(e.path) : undefined
    return { value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: links.includes(e.path), ...(real === undefined ? {} : { realPath: real }) } }
  }

const PRUNE_FOLDERS = [
  `${BIG}/.build`,
  `${BIG}/packages/app/.cache`,
  `${BIG}/packages/app/ios/build`,
  `${BIG}/apps/x/.expo-prebuild`,
  DEBUG_SIM,
  RELEASE_SIM,
]

const IGNORED_STATUS = ['git', '-C', BIG, 'status', '--ignored', '--porcelain']

const rm = (path: string): string[] => ['rm', '-rf', '--', path]

function pruneReplies(): Replies {
  return replies(
    [WORKTREE_LIST, ok(PORCELAIN)],
    [IGNORED_STATUS, ok(` M a.ts\n?? b.ts\n${IGNORED}`)],
    [['du', '-sk', `${BIG}/.build`], ok(`1953125\t${BIG}/.build\n`)],
    [['du', '-sk', `${BIG}/packages/app/.cache`], ok('976563\t.cache\n')],
    [['du', '-sk', EMPTY_ANDROID], ok('48\tbuild\n')],
    [['du', '-sk', EMPTY_DEVICE], ok('0\tDebug-device\n')],
    [['du', '-sk', `${BIG}/node_modules`], ok('1953125\tnode_modules\n')],
    [['du', '-sk', `${BIG}/packages/app/ios/Pods`], ok('976563\tPods\n')],
    [['du', '-sk', `${BIG}/packages/app/ios/build`], ok('97657\tbuild\n')],
    [['du', '-sk', `${BIG}/apps/x/.expo-prebuild`], exit(1, '', 'du: .expo-prebuild: Permission denied')],
    [['du', '-sk', DEBUG_SIM], ok('9765625\tDebug-sim\n')],
    [['du', '-sk', RELEASE_SIM], ok('4882813\tRelease-sim\n')],
    ...[...PRUNE_FOLDERS, EMPTY_ANDROID, EMPTY_DEVICE].map((path): [string[], Reply] => [rm(path), ok('')]),
  )
}

function recording(known: Replies): { argvs: string[][]; run: ReturnType<typeof fakeRun> } {
  const argvs: string[][] = []
  const run = fakeRun(known)
  return {
    argvs,
    run: async (_$, e) => {
      argvs.push(e.argv)
      return run(_$, e)
    },
  }
}

const byArgv = (a: string[], b: string[]): number => argvKey(a).localeCompare(argvKey(b))

const rmCalls = (argvs: string[][]): string[][] => argvs.filter(argv => argv[0] === 'rm').sort(byArgv)

const PRUNE_TABLE = [
  '| Folder | Size GB |',
  '|---|---:|',
  '| ~/Library/Developer/Xcode/DerivedData/cc-big-b4dd60-Debug-sim | 10.0 |',
  '| ~/Library/Developer/Xcode/DerivedData/cc-big-b4dd60-Release-sim | 5.0 |',
  '| .build | 2.0 |',
  '| packages/app/.cache | 1.0 |',
  '| packages/app/ios/build | 0.1 |',
  '| apps/x/.expo-prebuild | ? |',
]

test('/worktrees prune <name> lists the build folders it would delete, largest first, skips empty ones, and deletes nothing', async ($, on) => {
  const { argvs, run } = recording(pruneReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeExists)
  on('fs.list', fakeDerivedData)
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big' })
  expect(text).toBe(
    [
      '**Prune big** · dry run · 18.1 GB in 6 folders',
      '',
      ...PRUNE_TABLE,
      '',
      'Folders inside a `.claude` folder are never deleted.',
      '`node_modules` and `Pods` folders are kept, so the worktree still builds.',
      'Run `/worktrees prune big --yes` to delete them.',
    ].join('\n'),
  )
  expect(rmCalls(argvs)).toEqual([])
})

test('/worktrees prune <name> --yes runs rm -rf -- once per non-empty folder, by absolute path, and nothing else', async ($, on) => {
  const { argvs, run } = recording(pruneReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeExists)
  on('fs.list', fakeDerivedData)
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  expect(text).toBe(['**Pruned big** · 18.1 GB freed in 6 folders', '', ...PRUNE_TABLE].join('\n'))
  expect(argvs.filter(argv => argv[0] !== 'du').sort(byArgv)).toEqual([WORKTREE_LIST, IGNORED_STATUS, ...PRUNE_FOLDERS.map(rm)].sort(byArgv))
})

test('/worktrees prune <name> --yes starts every rm before any of them finishes', async ($, on) => {
  const run = fakeRun(pruneReplies())
  let started = 0
  let startedWhenFirstFinished: number | undefined
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    if (e.argv[0] !== 'rm') return run(_$, e)
    started += 1
    await new Promise(resolve => setTimeout(resolve, 20))
    startedWhenFirstFinished ??= started
    return run(_$, e)
  })
  on('fs.exists', fakeExists)
  on('fs.list', fakeDerivedData)
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  expect(startedWhenFirstFinished).toBe(PRUNE_FOLDERS.length)
})

test('/worktrees prune <name> --yes reports each folder rm could not delete', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun({ ...pruneReplies(), ...replies([rm(`${BIG}/.build`), exit(1, '', 'rm: .build/x: Permission denied\n')]) }))
  on('fs.exists', fakeExists)
  on('fs.list', fakeDerivedData)
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  const lines = text.split('\n')
  expect(lines[0]).toBe('**Pruned big** · 16.1 GB freed in 5 folders')
  expect(lines).not.toContain('| .build | 2.0 |')
  expect(lines.at(-1)).toBe('Could not delete .build: rm failed (exit 1): rm: .build/x: Permission denied')
})

test('/worktrees prune <name> --yes skips a symbolic link, a path that resolves outside the worktree or into a .claude folder, and one that does not resolve', async ($, on) => {
  const redirected: Record<string, string | undefined> = {
    [`${BIG}/packages/app/.cache`]: '/elsewhere/app/.cache',
    [`${BIG}/packages/app/ios/build`]: `${BIG}/.claude/worktrees/x/build`,
    [`${BIG}/apps/x/.expo-prebuild`]: undefined,
  }
  const { argvs, run } = recording(pruneReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeExists)
  on('fs.list', fakeDerivedData)
  on('fs.stat', fakeRealFs({ links: [`${BIG}/.build`], realPath: path => (path in redirected ? redirected[path] : path) }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  expect(text).toBe(
    [
      '**Pruned big** · 15.0 GB freed in 2 folders',
      '',
      ...PRUNE_TABLE.slice(0, 4),
      '',
      `Skipped ${BIG}/.build: it is a symbolic link.`,
      `Skipped ${BIG}/packages/app/.cache: it resolves to /elsewhere/app/.cache, which is not inside ${BIG}.`,
      `Skipped ${BIG}/packages/app/ios/build: it resolves to ${BIG}/.claude/worktrees/x/build, inside a .claude folder.`,
      `Skipped ${BIG}/apps/x/.expo-prebuild: its real path could not be resolved.`,
    ].join('\n'),
  )
  expect(rmCalls(argvs)).toEqual([rm(DEBUG_SIM), rm(RELEASE_SIM)].sort(byArgv))
})

test('/worktrees prune <name> --yes compares real paths with the real worktree, and skips Xcode folders when DerivedData does not resolve', async ($, on) => {
  const { argvs, run } = recording(pruneReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeExists)
  on('fs.list', fakeDerivedData)
  on('fs.stat', fakeRealFs({ realPath: path => (path === DERIVED_DATA ? undefined : path.startsWith(BIG) ? `/private${path}` : path) }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  const lines = text.split('\n')
  expect(lines[0]).toBe('**Pruned big** · 3.1 GB freed in 4 folders')
  expect(lines.slice(-2)).toEqual([
    `Skipped ${DEBUG_SIM}: the real path of ${DERIVED_DATA} could not be resolved.`,
    `Skipped ${RELEASE_SIM}: the real path of ${DERIVED_DATA} could not be resolved.`,
  ])
  expect(rmCalls(argvs)).toEqual(PRUNE_FOLDERS.slice(0, 4).map(rm).sort(byArgv))
})

for (const [state, env] of [
  ['unset', {}],
  ['a relative path', { HOME: 'Users/me' }],
] as const) {
  test(`/worktrees prune <name> looks for no Xcode build folders when HOME is ${state}, and still lists the worktree's own`, async ($, on) => {
    const listed: string[] = []
    on('session.cwd', async () => ({ value: REPO }))
    on('process.run', fakeRun(pruneReplies()))
    on('fs.exists', fakeExists)
    on('fs.list', async (_$: unknown, e: { path: string }) => {
      listed.push(e.path)
      return fakeDerivedData(_$, e)
    })
    mock.env(on, env)
    const { text } = await $.command.run({ command: 'worktrees', args: 'prune big' })
    expect(listed).toEqual([])
    expect(text.split('\n').slice(0, 8)).toEqual(['**Prune big** · dry run · 3.1 GB in 4 folders', '', ...PRUNE_TABLE.slice(0, 2), ...PRUNE_TABLE.slice(4)])
  })
}

test('/worktrees prune <name> says so when there is nothing to prune', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun({ ...pruneReplies(), ...replies([IGNORED_STATUS, ok('!! dist/\n!! .env\n')]) }))
  on('fs.exists', fakeExists)
  on('fs.list', async (_$: unknown, e: { path: string }) => ({ deny: `ENOENT: ${e.path}` }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  expect(text).toBe('Nothing to prune in big.')
})

test('/worktrees prune <name> --yes says there is nothing to prune, and deletes nothing, when every build folder is empty', async ($, on) => {
  const { argvs, run } = recording({ ...pruneReplies(), ...replies([IGNORED_STATUS, ok('!! android/build/\n!! node_modules/\n')]) })
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeExists)
  on('fs.list', async (_$: unknown, e: { path: string }) => (e.path === DERIVED_DATA ? { value: [dir('cc-big-b4dd60-Debug-device')] } : { deny: `ENOENT: ${e.path}` }))
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big --yes' })
  expect(text).toBe('Nothing to prune in big.')
  expect(rmCalls(argvs)).toEqual([])
})

test('/worktrees prune finds a worktree whose name has spaces, and hands its path to git as one argument', async ($, on) => {
  const spaced = '/repo/.claude/worktrees/my  wt'
  on('session.cwd', async () => ({ value: REPO }))
  on(
    'process.run',
    fakeRun(
      replies(
        [WORKTREE_LIST, ok(PORCELAIN + porcelainZ([`worktree ${spaced}`, 'HEAD 7777', 'branch refs/heads/me/spaced']))],
        [['git', '-C', spaced, 'status', '--ignored', '--porcelain'], ok('!! dist/\n')],
      ),
    ),
  )
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: [BIG, SMALL, spaced].includes(e.path) }))
  on('fs.list', async (_$: unknown, e: { path: string }) => ({ deny: `ENOENT: ${e.path}` }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune my  wt' })
  expect(text).toBe('Nothing to prune in my  wt.')
})

test('/worktrees prune names the linked worktrees when none has that name', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(pruneReplies()))
  on('fs.exists', fakeExists)
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune repo' })
  expect(text).toBe('No linked worktree named "repo". Worktrees: big, small')
})

test('/worktrees prune refuses a name that two linked worktrees share', async ($, on) => {
  const twin = '/elsewhere/big'
  on('session.cwd', async () => ({ value: REPO }))
  on(
    'process.run',
    fakeRun({ ...pruneReplies(), ...replies([WORKTREE_LIST, ok(PORCELAIN + porcelainZ([`worktree ${twin}`, 'HEAD 6666', 'branch refs/heads/me/twin']))]) }),
  )
  on('fs.exists', async (_$: unknown, e: { path: string }) => ({ value: [BIG, SMALL, twin].includes(e.path) }))
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune big' })
  expect(text).toBe(`Two or more linked worktrees are named "big": ${BIG}, ${twin}`)
})

test('/worktrees prints a usage line for arguments it does not know', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(pruneReplies()))
  for (const args of ['prune', 'prune --yes', 'clean']) {
    const { text } = await $.command.run({ command: 'worktrees', args })
    expect(text).toBe('Usage: `/worktrees` or `/worktrees prune <name> [--yes]`')
  }
})
