import { expect, mock, test } from 'claude-code/testing'

import {
  classifyDerivedData,
  derivedDataPrefix,
  dirtyCount,
  formatDerivedData,
  formatTable,
  ignoredBuildFolders,
  isDirectChild,
  isDiskConnected,
  isOrphan,
  isPrunable,
  parseCommand,
  parseMainWorktree,
  parsePrs,
  parseWorktrees,
  prLabel,
  realPathProblem,
  shortDate,
  sizeGb,
  volumeOf,
  workspacePathOf,
  type DerivedDataEntry,
  type RepoLayout,
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
    expect(text).toBe('Usage: `/worktrees`, `/worktrees prune <name> [--yes]`, `/worktrees derived-data` or `/worktrees prune-orphans [--yes]`')
  }
})

test('parseCommand reads derived-data and prune-orphans [--yes], with no other words', () => {
  expect(parseCommand('derived-data')).toEqual({ kind: 'derived-data' })
  expect(parseCommand(' derived-data ')).toEqual({ kind: 'derived-data' })
  expect(parseCommand('prune-orphans')).toEqual({ kind: 'prune-orphans', confirmed: false })
  expect(parseCommand(' prune-orphans\t--yes ')).toEqual({ kind: 'prune-orphans', confirmed: true })
  for (const args of ['derived-data extra', 'derived-data --yes', 'prune-orphans extra', 'prune-orphans --yes extra', 'prune-orphans --force', 'prune-orphansx', 'derived-datax']) {
    expect(parseCommand(args)).toEqual({ kind: 'usage' })
  }
})

test('parseCommand still reads prune with a space before the name as a prune, never as prune-orphans', () => {
  expect(parseCommand('prune -orphans')).toEqual({ kind: 'prune', name: '-orphans', confirmed: false })
  expect(parseCommand('prune prune-orphans --yes')).toEqual({ kind: 'prune', name: 'prune-orphans', confirmed: true })
})

test('parseMainWorktree reads the first worktree git lists, which is the main checkout', () => {
  expect(parseMainWorktree(PORCELAIN)).toBe(REPO)
  expect(parseMainWorktree('')).toBeNull()
})

const NESTED = `${BIG}/.claude/worktrees/inner`

const LAYOUT: RepoLayout = {
  main: REPO,
  worktrees: [
    { path: BIG, branch: 'me/big' },
    { path: NESTED, branch: 'me/inner' },
    { path: '/outside/wt', branch: 'me/outside' },
  ],
}

const entry = (name: string, workspacePath: string | null, exists = true, diskConnected = true): DerivedDataEntry => ({
  name,
  workspacePath,
  exists,
  diskConnected,
})

test('classifyDerivedData puts .noindex folders and SDKExplicitPrecompiledModules in the shared caches, whatever their source', () => {
  expect(classifyDerivedData(entry('ModuleCache.noindex', null), LAYOUT)).toEqual({ kind: 'cache' })
  expect(classifyDerivedData(entry('SymbolCache.noindex', '/gone/App.xcworkspace', false), LAYOUT)).toEqual({ kind: 'cache' })
  expect(classifyDerivedData(entry('SDKExplicitPrecompiledModules', null), LAYOUT)).toEqual({ kind: 'cache' })
  expect(classifyDerivedData(entry('noindex', null), LAYOUT)).toEqual({ kind: 'no-source' })
})

test('classifyDerivedData puts a folder without a WorkspacePath under no source recorded', () => {
  expect(classifyDerivedData(entry('cc-big-b4dd60-Debug-sim', null, false), LAYOUT)).toEqual({ kind: 'no-source' })
})

test('classifyDerivedData calls a folder an orphan when its WorkspacePath is not on disk, wherever that path was', () => {
  expect(classifyDerivedData(entry('Gone', '/old/Gone.xcworkspace', false), LAYOUT)).toEqual({ kind: 'orphan' })
  expect(classifyDerivedData(entry('Gone-big', `${BIG}/ios/Gone.xcworkspace`, false), LAYOUT)).toEqual({ kind: 'orphan' })
  expect(classifyDerivedData(entry('Gone-main', `${REPO}/ios/Gone.xcworkspace`, false), LAYOUT)).toEqual({ kind: 'orphan' })
})

test('classifyDerivedData gives a workspace to the linked worktree whose root is the longest match, not to the main checkout that holds it', () => {
  expect(classifyDerivedData(entry('App-big', `${BIG}/ios/App.xcworkspace`), LAYOUT)).toEqual({ kind: 'worktree', path: BIG })
  expect(classifyDerivedData(entry('App-inner', `${NESTED}/ios/App.xcodeproj`), LAYOUT)).toEqual({ kind: 'worktree', path: NESTED })
  expect(classifyDerivedData(entry('App-outside', '/outside/wt/App.xcworkspace'), LAYOUT)).toEqual({ kind: 'worktree', path: '/outside/wt' })
})

test('classifyDerivedData puts a workspace inside the main checkout and outside every linked worktree under the main checkout', () => {
  expect(classifyDerivedData(entry('App-main', `${REPO}/ios/App.xcworkspace`), LAYOUT)).toEqual({ kind: 'main' })
  expect(classifyDerivedData(entry('App-claude', `${REPO}/.claude/worktrees/App.xcodeproj`), LAYOUT)).toEqual({ kind: 'main' })
})

test('classifyDerivedData matches a root only up to a /, so /repo/.claude/worktrees/big is not a prefix of .../bigger', () => {
  expect(classifyDerivedData(entry('App-bigger', `${BIG}ger/ios/App.xcworkspace`), LAYOUT)).toEqual({ kind: 'main' })
  expect(classifyDerivedData(entry('App-repository', '/repository/App.xcworkspace'), LAYOUT)).toEqual({ kind: 'other' })
  expect(classifyDerivedData(entry('App-wt2', '/outside/wt2/App.xcworkspace'), LAYOUT)).toEqual({ kind: 'other' })
})

test('classifyDerivedData puts a workspace that exists outside the repo under other location, and so does every workspace when the main checkout is unknown', () => {
  expect(classifyDerivedData(entry('Other', '/elsewhere/Other.xcodeproj'), LAYOUT)).toEqual({ kind: 'other' })
  expect(classifyDerivedData(entry('App-main', `${REPO}/ios/App.xcworkspace`), { main: null, worktrees: [] })).toEqual({ kind: 'other' })
})

test('isOrphan selects the orphans and no folder of any other group', () => {
  const entries = [
    entry('ModuleCache.noindex', '/gone/App.xcworkspace', false),
    entry('SDKExplicitPrecompiledModules', null, false),
    entry('cc-big-b4dd60-Debug-device', null, false),
    entry('App-main', `${REPO}/ios/App.xcworkspace`),
    entry('App-big', `${BIG}/ios/App.xcworkspace`),
    entry('App-inner', `${NESTED}/App.xcodeproj`),
    entry('Other', '/elsewhere/Other.xcodeproj'),
    entry('Gone-a', '/old/Gone.xcworkspace', false),
    entry('Gone-b', `${BIG}/ios/Gone.xcworkspace`, false),
  ]
  expect(entries.filter(folder => isOrphan(folder, LAYOUT)).map(({ name }) => name)).toEqual(['Gone-a', 'Gone-b'])
})

test('workspacePathOf drops the newline plutil prints after the value, and accepts only an absolute path', () => {
  expect(workspacePathOf('/repo/ios/App.xcworkspace\n')).toBe('/repo/ios/App.xcworkspace')
  expect(workspacePathOf('/repo/ios/App.xcworkspace')).toBe('/repo/ios/App.xcworkspace')
  expect(workspacePathOf('\n')).toBeNull()
  expect(workspacePathOf('')).toBeNull()
  expect(workspacePathOf('ios/App.xcworkspace\n')).toBeNull()
})

test('workspacePathOf reads a plist plutil could not read, or a value that is not a path, as no source recorded', () => {
  for (const stdout of [null, '<?xml version="1.0"?><plist><dict>\n', 'true\n', '{\n  "WorkspacePath" = 1;\n}\n']) {
    expect(workspacePathOf(stdout)).toBeNull()
    expect(classifyDerivedData(entry('Broken', workspacePathOf(stdout), false), LAYOUT)).toEqual({ kind: 'no-source' })
  }
})

test('workspacePathOf resolves . and .. segments, so a path that leaves the repo is not grouped under it', () => {
  expect(workspacePathOf('/repo/../elsewhere/X.xcworkspace\n')).toBe('/elsewhere/X.xcworkspace')
  expect(workspacePathOf('/repo/./ios//App.xcworkspace/\n')).toBe('/repo/ios/App.xcworkspace')
  expect(classifyDerivedData(entry('Escaped', workspacePathOf('/repo/../elsewhere/X.xcworkspace\n')), LAYOUT)).toEqual({ kind: 'other' })
  expect(classifyDerivedData(entry('Escaped-big', workspacePathOf(`${BIG}/../small/App.xcworkspace\n`)), LAYOUT)).toEqual({ kind: 'main' })
})

test('classifyDerivedData groups the root folder and the parent of the main checkout under other location', () => {
  const layout: RepoLayout = { main: '/Users/me/repo', worktrees: [{ path: '/Users/me/repo/.claude/worktrees/a', branch: 'me/a' }] }
  expect(classifyDerivedData(entry('Root', workspacePathOf('/\n')), layout)).toEqual({ kind: 'other' })
  expect(classifyDerivedData(entry('Root', '/'), LAYOUT)).toEqual({ kind: 'other' })
  expect(classifyDerivedData(entry('Parent', '/Users/me'), layout)).toEqual({ kind: 'other' })
  expect(classifyDerivedData(entry('Parent', workspacePathOf('/Users/me/repo/..\n')), layout)).toEqual({ kind: 'other' })
})

test('volumeOf names the /Volumes folder a path is inside, and nothing for any other path', () => {
  expect(volumeOf('/Volumes/USB/proj/App.xcworkspace')).toBe('/Volumes/USB')
  expect(volumeOf('/Volumes/My Disk/App.xcodeproj')).toBe('/Volumes/My Disk')
  for (const path of ['/Volumes/USB', '/Volumes', '/', '/repo/Volumes/USB/App.xcworkspace', '/VolumesX/USB/App.xcworkspace']) {
    expect(volumeOf(path)).toBeNull()
  }
  expect(volumeOf(workspacePathOf('/Volumes/USB/../../repo/App.xcworkspace\n') ?? '')).toBeNull()
})

test('classifyDerivedData puts a missing workspace on a disk that is not connected under its own group, and never calls it an orphan', () => {
  const unmounted = entry('App-usb', '/Volumes/USB/proj/App.xcworkspace', false, false)
  expect(classifyDerivedData(unmounted, LAYOUT)).toEqual({ kind: 'disk-not-connected' })
  expect(isOrphan(unmounted, LAYOUT)).toBe(false)
})

test('classifyDerivedData still calls a workspace an orphan when its disk is connected but the path is gone', () => {
  const missing = entry('Gone-ssd', '/Volumes/SSD/old/App.xcworkspace', false, true)
  expect(classifyDerivedData(missing, LAYOUT)).toEqual({ kind: 'orphan' })
  expect(isOrphan(missing, LAYOUT)).toBe(true)
})

const probe = (device: string | null, linkTarget: string | null = null) => ({ device, volumesDevice: '16777230\n', linkTarget })

test('isDiskConnected calls a /Volumes folder connected only when stat puts it on another device than /Volumes', () => {
  expect(isDiskConnected(probe('16777233\n'))).toBe(true)
  expect(isDiskConnected(probe('16777230\n'))).toBe(false)
})

test('isDiskConnected calls a /Volumes folder not connected when either stat failed or printed no device number', () => {
  expect(isDiskConnected(probe(null))).toBe(false)
  expect(isDiskConnected({ device: '16777233\n', volumesDevice: null, linkTarget: null })).toBe(false)
  expect(isDiskConnected(probe('stat: /Volumes/USB: No such file or directory\n'))).toBe(false)
  expect(isDiskConnected(probe(''))).toBe(false)
})

test('isDiskConnected calls the boot disk link to / connected, though it shares the /Volumes device, and no other link', () => {
  expect(isDiskConnected(probe('16777230\n', '/'))).toBe(true)
  expect(isDiskConnected(probe('16777230\n', '/Users/me/fake-disk'))).toBe(false)
})

test('isDirectChild allows only a single real name directly below the parent', () => {
  expect(isDirectChild(`${DERIVED_DATA}/Gone-a`, DERIVED_DATA)).toBe(true)
  for (const path of [DERIVED_DATA, `${DERIVED_DATA}/`, `${DERIVED_DATA}/.`, `${DERIVED_DATA}/..`, `${DERIVED_DATA}/Gone-a/x`, `${DERIVED_DATA}-x/Gone-a`, '/elsewhere/Gone-a']) {
    expect(isDirectChild(path, DERIVED_DATA)).toBe(false)
  }
})

test('formatDerivedData orders linked worktree groups by name, keeps two worktrees with one name apart, and says so when there are no folders', () => {
  const folder = (name: string, path: string) => ({ path: `${DERIVED_DATA}/${name}`, label: name, sizeGb: 1, group: { kind: 'worktree' as const, path } })
  const lines = formatDerivedData([folder('a', SMALL), folder('b', BIG), folder('c', '/elsewhere/big')]).split('\n')
  expect(lines.filter(line => line.startsWith('**Linked'))).toEqual([
    '**Linked worktree big** · 1.0 GB in 1 folder',
    '**Linked worktree big** · 1.0 GB in 1 folder',
    '**Linked worktree small** · 1.0 GB in 1 folder',
  ])
  expect(formatDerivedData([])).toBe('No folders in ~/Library/Developer/Xcode/DerivedData.')
})

test('formatDerivedData says under the disk not connected group that its folders are never deleted, and only there', () => {
  const folder = (name: string, kind: 'disk-not-connected' | 'other') => ({ path: `${DERIVED_DATA}/${name}`, label: name, sizeGb: 1, group: { kind } })
  expect(formatDerivedData([folder('App-usb', 'disk-not-connected'), folder('Other-x', 'other')]).split('\n')).toEqual([
    '**~/Library/Developer/Xcode/DerivedData** · 2.0 GB in 2 folders',
    '',
    '**Other location** · 1.0 GB in 1 folder',
    '',
    '| Folder | Size GB |',
    '|---|---:|',
    '| Other-x | 1.0 |',
    '',
    '**Disk not connected** · 1.0 GB in 1 folder',
    '',
    '| Folder | Size GB |',
    '|---|---:|',
    '| App-usb | 1.0 |',
    '',
    'A folder here was built from a project on a disk that is not connected, so it is never deleted.',
  ])
  expect(formatDerivedData([folder('Other-x', 'other')])).not.toContain('not connected')
})

const plutil = (name: string): string[] => ['plutil', '-extract', 'WorkspacePath', 'raw', '-o', '-', `${DERIVED_DATA}/${name}/info.plist`]

const MAIN_APP = `${REPO}/ios/App.xcworkspace`
const BIG_APP = `${BIG}/ios/App.xcworkspace`
const OTHER_APP = '/elsewhere/Other.xcodeproj'
const GONE_A = `${DERIVED_DATA}/Gone-a`
const GONE_B = `${DERIVED_DATA}/Gone-b`

type DerivedDataFixture = [name: string, workspacePath: string | null, kib: number | null][]

const DERIVED_DATA_FOLDERS: DerivedDataFixture = [
  ['ModuleCache.noindex', null, 1953125],
  ['SDKExplicitPrecompiledModules', null, 976563],
  ['cc-big-b4dd60-Debug-device', null, 0],
  ['App-main', MAIN_APP, 4882813],
  ['App-big', BIG_APP, 9765625],
  ['Other-x', OTHER_APP, 97657],
  ['Gone-a', '/old/Gone.xcworkspace', 976563],
  ['Gone-b', `${REPO}/.claude/worktrees/gone/ios/App.xcworkspace`, null],
]

function derivedDataReplies(folders = DERIVED_DATA_FOLDERS): Replies {
  return replies(
    [WORKTREE_LIST, ok(PORCELAIN)],
    ...folders.flatMap(([name, workspacePath, kib]): [string[], Reply][] => [
      [plutil(name), workspacePath === null ? exit(1, '', 'No value at that key path or invalid key path: WorkspacePath') : ok(`${workspacePath}\n`)],
      [['du', '-sk', `${DERIVED_DATA}/${name}`], kib === null ? exit(1, '', 'du: Gone-b: Permission denied') : ok(`${kib}\t${name}\n`)],
      [rm(`${DERIVED_DATA}/${name}`), ok('')],
    ]),
  )
}

const xcodeList = (folders: DerivedDataFixture) => async (_$: unknown, e: { path: string }) =>
  e.path === DERIVED_DATA
    ? {
        value: [
          ...folders.map(([name]) => dir(name)),
          { name: '.DS_Store', kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false },
          dir('Linked-elsewhere', 'other'),
        ],
      }
    : { deny: `ENOENT: ${e.path}` }

const fakeXcodeList = xcodeList(DERIVED_DATA_FOLDERS)

const fakeXcodeExists = async (_$: unknown, e: { path: string }) => ({ value: [BIG, SMALL, MAIN_APP, BIG_APP, OTHER_APP].includes(e.path) })

const ORPHAN_TABLE = ['| Folder | Size GB |', '|---|---:|', '| Gone-a | 1.0 |', '| Gone-b | ? |']

test('/worktrees derived-data groups every DerivedData folder by where its WorkspacePath is, with a size per folder and a total per group', async ($, on) => {
  const { argvs, run } = recording(derivedDataReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeXcodeExists)
  on('fs.list', fakeXcodeList)
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'derived-data' })
  expect(text).toBe(
    [
      '**~/Library/Developer/Xcode/DerivedData** · 19.1 GB in 8 folders',
      '',
      '**Main checkout** · 5.0 GB in 1 folder',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| App-main | 5.0 |',
      '',
      '**Linked worktree big** · 10.0 GB in 1 folder',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| App-big | 10.0 |',
      '',
      '**Other location** · 0.1 GB in 1 folder',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| Other-x | 0.1 |',
      '',
      '**Orphan** · 1.0 GB in 2 folders',
      '',
      ...ORPHAN_TABLE,
      '',
      '**No source recorded** · 0.0 GB in 1 folder',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| cc-big-b4dd60-Debug-device | 0.0 |',
      '',
      '**Shared caches** · 3.0 GB in 2 folders',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| ModuleCache.noindex | 2.0 |',
      '| SDKExplicitPrecompiledModules | 1.0 |',
      '',
      'An orphan was built from a project that no longer exists on disk.',
      'Run `/worktrees prune-orphans --yes` to delete the orphans.',
    ].join('\n'),
  )
  expect(rmCalls(argvs)).toEqual([])
})

test('/worktrees derived-data says so when DerivedData has no folders or cannot be read', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(derivedDataReplies()))
  on('fs.exists', fakeXcodeExists)
  on('fs.list', async (_$: unknown, e: { path: string }) => ({ deny: `ENOENT: ${e.path}` }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'derived-data' })
  expect(text).toBe('No folders in ~/Library/Developer/Xcode/DerivedData.')
})

test('/worktrees prune-orphans lists only the orphans and deletes nothing', async ($, on) => {
  const { argvs, run } = recording(derivedDataReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeXcodeExists)
  on('fs.list', fakeXcodeList)
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans' })
  expect(text).toBe(
    [
      '**Prune orphans in ~/Library/Developer/Xcode/DerivedData** · dry run · 1.0 GB in 2 folders',
      '',
      ...ORPHAN_TABLE,
      '',
      'An orphan was built from a project that no longer exists on disk.',
      'Run `/worktrees prune-orphans --yes` to delete them.',
    ].join('\n'),
  )
  expect(rmCalls(argvs)).toEqual([])
})

test('/worktrees prune-orphans --yes runs rm -rf -- on each orphan and on no other folder', async ($, on) => {
  const { argvs, run } = recording(derivedDataReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeXcodeExists)
  on('fs.list', fakeXcodeList)
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(text).toBe(['**Pruned orphans in ~/Library/Developer/Xcode/DerivedData** · 1.0 GB freed in 2 folders', '', ...ORPHAN_TABLE].join('\n'))
  expect(rmCalls(argvs)).toEqual([rm(GONE_A), rm(GONE_B)])
})

test('/worktrees prune-orphans --yes skips a folder whose project came back before deletion, and a symbolic link', async ($, on) => {
  const { argvs, run } = recording(derivedDataReplies())
  let goneAsked = 0
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', async (_$: unknown, e: { path: string }) => {
    if (e.path !== '/old/Gone.xcworkspace') return fakeXcodeExists(_$, e)
    goneAsked += 1
    return { value: goneAsked > 1 }
  })
  on('fs.list', fakeXcodeList)
  on('fs.stat', fakeRealFs({ links: [GONE_B] }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(text).toBe(
    [
      '**Pruned orphans in ~/Library/Developer/Xcode/DerivedData** · 0.0 GB freed in 0 folders',
      '',
      `Skipped ${GONE_A}: it is no longer an orphan.`,
      `Skipped ${GONE_B}: it is a symbolic link.`,
    ].join('\n'),
  )
  expect(rmCalls(argvs)).toEqual([])
})

test('/worktrees prune-orphans --yes skips an orphan whose real path is not directly inside the real DerivedData', async ($, on) => {
  const { argvs, run } = recording(derivedDataReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeXcodeExists)
  on('fs.list', fakeXcodeList)
  on('fs.stat', fakeRealFs({ realPath: path => (path === GONE_A ? '/elsewhere/Gone-a' : path) }))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(text.split('\n').at(-1)).toBe(`Skipped ${GONE_A}: it resolves to /elsewhere/Gone-a, which is not directly inside ${DERIVED_DATA}.`)
  expect(rmCalls(argvs)).toEqual([rm(GONE_B)])
})

test('/worktrees prune-orphans says so when there are no orphans', async ($, on) => {
  const { argvs, run } = recording(derivedDataReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', async () => ({ value: true }))
  on('fs.list', fakeXcodeList)
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(text).toBe('Nothing to prune: no orphans in ~/Library/Developer/Xcode/DerivedData.')
  expect(rmCalls(argvs)).toEqual([])
})

const USB_APP = '/Volumes/USB/proj/App.xcworkspace'
const SSD_GONE = '/Volumes/SSD/old/App.xcworkspace'
const ESCAPED_APP = '/elsewhere/X.xcworkspace'
const GONE_SSD = `${DERIVED_DATA}/Gone-ssd`

const VOLUME_FOLDERS: DerivedDataFixture = [
  ['App-usb', USB_APP, 1953125],
  ['Gone-ssd', SSD_GONE, 976563],
  ['Escaped', '/repo/../elsewhere/X.xcworkspace', 97657],
]

const fakeVolumeExists = async (_$: unknown, e: { path: string }) => ({ value: ['/Volumes/SSD', '/Volumes/Stale', ESCAPED_APP].includes(e.path) })

const statDevice = (volume: string): string[] => ['/usr/bin/stat', '-L', '-f', '%d', volume]
const VOLUMES_DEVICE = ok('16777230\n')

/** /Volumes/SSD is a mounted disk, /Volumes/Stale an empty folder an unmount left behind, /Volumes/Macintosh HD the boot disk link to /, and /Volumes/USB is gone. */
const volumeReplies = (folders = VOLUME_FOLDERS): Replies => ({
  ...derivedDataReplies(folders),
  ...replies(
    [['/usr/bin/stat', '-f', '%d', '/Volumes'], VOLUMES_DEVICE],
    [statDevice('/Volumes/SSD'), ok('16777233\n')],
    [statDevice('/Volumes/Stale'), VOLUMES_DEVICE],
    [statDevice('/Volumes/Macintosh HD'), VOLUMES_DEVICE],
    [statDevice('/Volumes/USB'), exit(1, '', 'stat: /Volumes/USB: stat: No such file or directory')],
  ),
})

const GONE_SSD_TABLE = ['| Folder | Size GB |', '|---|---:|', '| Gone-ssd | 1.0 |']

test('/worktrees derived-data shows a folder whose disk is not connected in its own group, and resolves .. before it groups', async ($, on) => {
  const { argvs, run } = recording(volumeReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeVolumeExists)
  on('fs.list', xcodeList(VOLUME_FOLDERS))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'derived-data' })
  expect(text).toBe(
    [
      '**~/Library/Developer/Xcode/DerivedData** · 3.1 GB in 3 folders',
      '',
      '**Other location** · 0.1 GB in 1 folder',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| Escaped | 0.1 |',
      '',
      '**Disk not connected** · 2.0 GB in 1 folder',
      '',
      '| Folder | Size GB |',
      '|---|---:|',
      '| App-usb | 2.0 |',
      '',
      'A folder here was built from a project on a disk that is not connected, so it is never deleted.',
      '',
      '**Orphan** · 1.0 GB in 1 folder',
      '',
      ...GONE_SSD_TABLE,
      '',
      'An orphan was built from a project that no longer exists on disk.',
      'Run `/worktrees prune-orphans --yes` to delete the orphans.',
    ].join('\n'),
  )
  expect(rmCalls(argvs)).toEqual([])
})

test('/worktrees prune-orphans leaves out a folder whose disk is not connected', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(volumeReplies()))
  on('fs.exists', fakeVolumeExists)
  on('fs.list', xcodeList(VOLUME_FOLDERS))
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans' })
  expect(text).toBe(
    [
      '**Prune orphans in ~/Library/Developer/Xcode/DerivedData** · dry run · 1.0 GB in 1 folder',
      '',
      ...GONE_SSD_TABLE,
      '',
      'An orphan was built from a project that no longer exists on disk.',
      'Run `/worktrees prune-orphans --yes` to delete them.',
    ].join('\n'),
  )
})

test('/worktrees prune-orphans --yes never deletes a folder whose disk is not connected', async ($, on) => {
  const { argvs, run } = recording(volumeReplies())
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeVolumeExists)
  on('fs.list', xcodeList(VOLUME_FOLDERS))
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(text).toBe(['**Pruned orphans in ~/Library/Developer/Xcode/DerivedData** · 1.0 GB freed in 1 folder', '', ...GONE_SSD_TABLE].join('\n'))
  expect(rmCalls(argvs)).toEqual([rm(GONE_SSD)])
})

test('/worktrees prune-orphans --yes skips an orphan whose disk was disconnected before deletion', async ($, on) => {
  const { argvs, run } = recording(volumeReplies())
  let ssdAsked = 0
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', async (_$: unknown, e: { argv: string[] }) => {
    if (argvKey(e.argv) !== argvKey(statDevice('/Volumes/SSD'))) return run(_$, e)
    ssdAsked += 1
    return ssdAsked === 1 ? run(_$, e) : VOLUMES_DEVICE
  })
  on('fs.exists', fakeVolumeExists)
  on('fs.list', xcodeList(VOLUME_FOLDERS))
  on('fs.stat', fakeRealFs())
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(text.split('\n').at(-1)).toBe(`Skipped ${GONE_SSD}: it is no longer an orphan.`)
  expect(rmCalls(argvs)).toEqual([])
})

const BOOT_DISK = '/Volumes/Macintosh HD'
const GONE_BOOT = `${DERIVED_DATA}/Gone-boot`

const STALE_FOLDERS: DerivedDataFixture = [
  ...VOLUME_FOLDERS,
  ['Gone-stale', '/Volumes/Stale/old/App.xcworkspace', 976563],
  ['Gone-boot', `${BOOT_DISK}/Users/me/old/App.xcworkspace`, 976563],
]

const fakeBootLink = fakeRealFs({ links: [BOOT_DISK], realPath: path => (path === BOOT_DISK ? '/' : path) })

test('/worktrees derived-data puts a folder whose /Volumes folder is only left behind under disk not connected, and one on the boot disk link under orphan', async ($, on) => {
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', fakeRun(volumeReplies(STALE_FOLDERS)))
  on('fs.exists', fakeVolumeExists)
  on('fs.list', xcodeList(STALE_FOLDERS))
  on('fs.stat', fakeBootLink)
  mock.env(on, { HOME })
  const { text } = await $.command.run({ command: 'worktrees', args: 'derived-data' })
  expect(text).toContain(['**Disk not connected** · 3.0 GB in 2 folders', '', '| Folder | Size GB |', '|---|---:|', '| App-usb | 2.0 |', '| Gone-stale | 1.0 |'].join('\n'))
  expect(text).toContain(['**Orphan** · 2.0 GB in 2 folders', '', '| Folder | Size GB |', '|---|---:|', '| Gone-ssd | 1.0 |', '| Gone-boot | 1.0 |'].join('\n'))
})

test('/worktrees prune-orphans --yes deletes the orphans on a mounted disk and on the boot disk link, and never a folder whose /Volumes folder is only left behind', async ($, on) => {
  const { argvs, run } = recording(volumeReplies(STALE_FOLDERS))
  on('session.cwd', async () => ({ value: REPO }))
  on('process.run', run)
  on('fs.exists', fakeVolumeExists)
  on('fs.list', xcodeList(STALE_FOLDERS))
  on('fs.stat', fakeBootLink)
  mock.env(on, { HOME })
  await $.command.run({ command: 'worktrees', args: 'prune-orphans --yes' })
  expect(rmCalls(argvs)).toEqual([rm(GONE_BOOT), rm(GONE_SSD)])
})
