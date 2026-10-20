import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { format, PARK_USAGE, park, parkMarker, summarize, unpark } from './ledger'

const LEDGER = `# Task ledger — fast-steps

## Goal
Prototype two ideas.

## Plan (approved 2026-10-08)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | baseline runs | done | me | |
| 2 | runner: tsc | todo | runner | |

## Next step
Ask user: commit + PR.
`

const MARKER = 'Parked: 2026-10-01 — waiting on the API review'
const PARKED = LEDGER.replace('## Next step\n', `## Next step\n${MARKER}\n`)
const TODAY = /^Parked: \d{4}-\d{2}-\d{2} — /

test('parkMarker writes the local date and the reason on one line', () => {
  expect(parkMarker(new Date(2026, 9, 1, 23, 59), 'waiting on the API review')).toBe(MARKER)
  expect(parkMarker(new Date(2026, 0, 5), '  blocked\n  on   design ')).toBe('Parked: 2026-01-05 — blocked on design')
})

test('park puts the marker as the first line under Next step', () => {
  expect(park(LEDGER, MARKER)).toBe(PARKED)
})

test('parking twice replaces the marker', () => {
  const again = 'Parked: 2026-10-02 — still waiting'
  expect(park(PARKED, again)).toBe(LEDGER.replace('## Next step\n', `## Next step\n${again}\n`))
})

test('park adds a Next step section when the ledger has none', () => {
  expect(park('# Task ledger — x\n\n## Goal\nG.\n', MARKER)).toBe(`# Task ledger — x\n\n## Goal\nG.\n\n## Next step\n${MARKER}\n`)
})

test('unpark removes the marker and says when and why the task was parked', () => {
  expect(unpark(PARKED)).toEqual({ text: LEDGER, parked: { date: '2026-10-01', reason: 'waiting on the API review' } })
  expect(unpark(LEDGER)).toEqual({ text: LEDGER, parked: null })
})

test('summarize reads the marker and keeps the next step after it', () => {
  const summary = summarize(PARKED, 'folder', 0)
  expect(summary.parked).toEqual({ date: '2026-10-01', reason: 'waiting on the API review' })
  expect(summary.next).toBe('Ask user: commit + PR.')
  expect(summarize(LEDGER, 'folder', 0).parked).toBeUndefined()
})

test('format shows a parked task as parked instead of its current step', () => {
  const lines = format(summarize(PARKED, 'folder', new Date(2026, 9, 9, 8, 5).getTime())).split('\n')
  expect(lines).toEqual([
    '#### fast-steps · edited 2026-10-09 08:05',
    '- **Goal:** Prototype two ideas.',
    '- **Parked:** 2026-10-01 — waiting on the API review',
    '- **Next:** Ask user: commit + PR.',
  ])
})

const WORKTREES = '/repo/.claude/worktrees'
const FIX_LOGIN = `${WORKTREES}/fix-login/.claude/ledger.md`
const NEW_API = `${WORKTREES}/new-api/.claude/ledger.md`

type Broken = 'write'

type World = {
  files: Map<string, string>
  calls: string[]
  logs: string[]
  isMarkdownReached: () => boolean
  markdownArgs: () => string | undefined
}

type Options = {
  broken?: Broken
  /** What ledger discovery prints; every file by default, as from the main checkout. */
  ledgers?: string[]
  /** What `git worktree list --porcelain -z` prints, or how it is denied; git fails by default. */
  worktrees?: string | { deny: string }
}

const ran = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

function world(on: On, cwd: string, command: string, contents: Record<string, string> = {}, { broken, ledgers, worktrees }: Options = {}): World {
  const files = new Map<string, string>([
    [FIX_LOGIN, LEDGER],
    [NEW_API, LEDGER.replace('fast-steps', 'new-api')],
    ...Object.entries(contents),
  ])
  const calls: string[] = []
  const logs: string[] = []
  let isMarkdownReached = false
  let markdownArgs: string | undefined
  on('session.cwd', async () => ({ value: cwd }))
  on('process.run', async (_, e: { argv: string[] }) => {
    if (e.argv[0] === 'bash') return ran(0, (ledgers ?? [...files.keys()]).join('\n'))
    if (e.argv.join(' ') === 'git worktree list --porcelain -z') {
      if (worktrees === undefined) return ran(128, '', 'fatal: not a git repository')
      return typeof worktrees === 'string' ? ran(0, worktrees) : worktrees
    }
    return { deny: `unexpected command: ${JSON.stringify(e.argv)}` }
  })
  on('fs.stat', async () => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false } }))
  on('fs.read', async (_, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', async (_, e: { path: string; text: string }) => {
    calls.push(`write ${e.path}`)
    if (broken === 'write') return { deny: 'EACCES: ledger read-only' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.run', { command }, async (_, e) => {
    isMarkdownReached = true
    markdownArgs = e.args
    return { text: '' }
  })
  on('command.run', { command: 'clear' }, async () => {
    calls.push('clear')
    return { text: '' }
  })
  on('prompt.submit', async (_, e) => {
    calls.push(`submit: ${e.text}`)
    return { text: '' }
  })
  on('ui.log', async (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('turn.complete', async () => ({ text: '' }))
  return { files, calls, logs, isMarkdownReached: () => isMarkdownReached, markdownArgs: () => markdownArgs }
}

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const

const nextStepOf = (text: string): string[] => text.split('## Next step\n')[1]?.split('\n').filter(line => line !== '') ?? []

for (const args of ['', '   ', 'new-api']) {
  test(`/ledger:park ${args.trim() ? 'with a slug and no reason' : 'without a reason'} prints the usage and changes nothing`, async ($, on) => {
    const { files, calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, 'ledger:park')
    const before = new Map(files)
    const { text } = await $.command.run({ command: 'ledger:park', args })
    expect(text).toBe(PARK_USAGE)
    expect(isMarkdownReached()).toBe(false)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([])
    expect(files).toEqual(before)
  })
}

test('/ledger:park <other slug> <reason> marks that ledger and clears nothing', async ($, on) => {
  const { files, calls, isMarkdownReached } = world(on, '/repo', 'ledger:park')
  const { text } = await $.command.run({ command: 'ledger:park', args: 'new-api  waiting on the API review ' })
  const [marker] = nextStepOf(files.get(NEW_API) ?? '')
  expect(marker).toMatch(TODAY)
  expect(marker?.endsWith('— waiting on the API review')).toBe(true)
  expect(text).toBe(`Parked new-api. ${marker}`)
  expect(isMarkdownReached()).toBe(false)
  expect(files.get(FIX_LOGIN)).toBe(LEDGER)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${NEW_API}`])
})

test('/ledger:park <other slug> twice keeps one marker', async ($, on) => {
  const { files } = world(on, '/repo', 'ledger:park', { [NEW_API]: PARKED.replace('fast-steps', 'new-api') })
  await $.command.run({ command: 'ledger:park', args: 'new-api still waiting' })
  const lines = nextStepOf(files.get(NEW_API) ?? '')
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatch(TODAY)
  expect(lines[0]?.endsWith('— still waiting')).toBe(true)
  expect(lines[1]).toBe('Ask user: commit + PR.')
})

test('/ledger:park <reason> in a task worktree runs the command, then marks the ledger and clears after the answer', async ($, on) => {
  const { files, calls, isMarkdownReached, markdownArgs } = world(on, `${WORKTREES}/fix-login/src`, 'ledger:park')
  const { text } = await $.command.run({ command: 'ledger:park', args: 'waiting on the API review' })
  expect(text).toBe('')
  expect(isMarkdownReached()).toBe(true)
  expect(markdownArgs()).toBe(`task: fast-steps\nledger: ${FIX_LOGIN}\nreason: waiting on the API review`)
  expect(calls).toEqual([])
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${FIX_LOGIN}`, 'clear'])
  const [marker] = nextStepOf(files.get(FIX_LOGIN) ?? '')
  expect(marker).toMatch(TODAY)
  expect(marker?.endsWith('— waiting on the API review')).toBe(true)
})

test('/ledger:park <own slug> <reason> parks the current task like /ledger:park <reason>', async ($, on) => {
  const { files, calls, isMarkdownReached, markdownArgs } = world(on, `${WORKTREES}/fix-login`, 'ledger:park')
  await $.command.run({ command: 'ledger:park', args: 'fast-steps waiting' })
  expect(isMarkdownReached()).toBe(true)
  expect(markdownArgs()).toBe(`task: fast-steps\nledger: ${FIX_LOGIN}\nreason: waiting`)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${FIX_LOGIN}`, 'clear'])
  expect(nextStepOf(files.get(FIX_LOGIN) ?? '')[0]?.endsWith('— waiting')).toBe(true)
})

const worktreeBlock = (path: string, branch: string): string => `worktree ${path}\0HEAD c0ffee1\0branch refs/heads/${branch}\0\0`

// As seen from a linked worktree: discovery lists only its own ledger, while git lists every worktree.
const LINKED = {
  ledgers: [FIX_LOGIN],
  worktrees: [
    worktreeBlock('/repo', 'main'),
    worktreeBlock(`${WORKTREES}/fix-login`, 'me/fix-login'),
    worktreeBlock(`${WORKTREES}/new-api`, 'me/api-v2'),
  ].join(''),
}

for (const [name, word] of [
  ['folder', 'new-api'],
  ['branch without its owner', 'api-v2'],
  ['full branch', 'me/api-v2'],
] as const) {
  test(`/ledger:park <other worktree's ${name}> <reason> from a linked worktree refuses and changes nothing`, async ($, on) => {
    const { files, calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login/src`, 'ledger:park', {}, LINKED)
    const before = new Map(files)
    const { text } = await $.command.run({ command: 'ledger:park', args: `${word} waiting on review` })
    expect(text).toBe(`${word} is another task. Park it from the main checkout, or from that task's own session.`)
    expect(isMarkdownReached()).toBe(false)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([])
    expect(files).toEqual(before)
  })
}

for (const [name, args] of [
  ['an ordinary word', 'waiting on review'],
  ["its own worktree's folder", 'fix-login waiting on review'],
] as const) {
  test(`/ledger:park starting with ${name} from a linked worktree parks its own task`, async ($, on) => {
    const { calls, markdownArgs } = world(on, `${WORKTREES}/fix-login`, 'ledger:park', {}, LINKED)
    await $.command.run({ command: 'ledger:park', args })
    expect(markdownArgs()).toBe(`task: fast-steps\nledger: ${FIX_LOGIN}\nreason: ${args}`)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([`write ${FIX_LOGIN}`, 'clear'])
  })
}

for (const [name, worktrees] of [
  ['fails', undefined],
  ['cannot run', { deny: 'git: command not found' }],
] as const) {
  test(`/ledger:park <other worktree> <reason> parks its own task when git ${name}`, async ($, on) => {
    const { calls, markdownArgs } = world(on, `${WORKTREES}/fix-login`, 'ledger:park', {}, { ledgers: [FIX_LOGIN], worktrees })
    await $.command.run({ command: 'ledger:park', args: 'new-api waiting' })
    expect(markdownArgs()).toBe(`task: fast-steps\nledger: ${FIX_LOGIN}\nreason: new-api waiting`)
    await $.turn.complete(turnEnd)
    expect(calls).toEqual([`write ${FIX_LOGIN}`, 'clear'])
  })
}

test('/ledger:park <worktree without a ledger> <reason> from the main checkout gives the usual no-ledger reply', async ($, on) => {
  const worktrees = LINKED.worktrees + worktreeBlock(`${WORKTREES}/old-spike`, 'me/old-spike')
  const { calls, isMarkdownReached } = world(on, '/repo', 'ledger:park', {}, { worktrees })
  const { text } = await $.command.run({ command: 'ledger:park', args: 'old-spike waiting' })
  expect(text).toContain('No task ledger found for /repo.')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:park <reason> outside every task worktree answers with why and changes nothing', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, '/repo', 'ledger:park')
  const { text } = await $.command.run({ command: 'ledger:park', args: 'waiting on review' })
  expect(text).toContain('No task ledger found for /repo.')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([])
})

test('/ledger:park in an interrupted turn neither marks nor clears', async ($, on) => {
  const { files, calls } = world(on, `${WORKTREES}/fix-login`, 'ledger:park')
  await $.command.run({ command: 'ledger:park', args: 'waiting' })
  await $.turn.complete({ ...turnEnd, reason: 'aborted', isAborted: true })
  await $.turn.complete({ ...turnEnd, turnId: 't2' })
  expect(calls).toEqual([])
  expect(files.get(FIX_LOGIN)).toBe(LEDGER)
})

test('/ledger:park names a marker it could not write and does not clear', async ($, on) => {
  const { calls, logs } = world(on, `${WORKTREES}/fix-login`, 'ledger:park', {}, { broken: 'write' })
  await $.command.run({ command: 'ledger:park', args: 'waiting' })
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${FIX_LOGIN}`])
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatch(/^\/ledger:park could not mark fast-steps parked: .*EACCES.*\. The session was not cleared\.$/)
})

test('/ledger:park <other slug> it cannot write says why and clears nothing', async ($, on) => {
  const { files, calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, 'ledger:park', {}, { broken: 'write' })
  const { text } = await $.command.run({ command: 'ledger:park', args: 'new-api waiting on the API review' })
  expect(text).toMatch(/^Could not park new-api\. .*EACCES/)
  expect(isMarkdownReached()).toBe(false)
  expect(files.get(NEW_API)).toBe(LEDGER.replace('fast-steps', 'new-api'))
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${NEW_API}`])
})

test('/ledger:go to a parked task removes the marker and tells the model when and why it was parked', async ($, on) => {
  const { files, calls, markdownArgs } = world(on, `${WORKTREES}/fix-login`, 'ledger:go', { [NEW_API]: PARKED.replace('fast-steps', 'new-api') })
  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  expect(files.get(NEW_API)).toBe(LEDGER.replace('fast-steps', 'new-api'))
  expect(markdownArgs()).toBe(`task: new-api\nledger: ${FIX_LOGIN}\nparked: 2026-10-01 — waiting on the API review`)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${NEW_API}`, 'clear', 'submit: go new-api'])
})

test('/ledger:go to a task that is not parked writes nothing to it', async ($, on) => {
  const { calls, markdownArgs } = world(on, `${WORKTREES}/fix-login`, 'ledger:go')
  await $.command.run({ command: 'ledger:go', args: 'new-api' })
  expect(markdownArgs()).toBe(`task: new-api\nledger: ${FIX_LOGIN}`)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual(['clear', 'submit: go new-api'])
})

test('/ledger:go to a parked task it cannot unmark clears nothing and says why', async ($, on) => {
  const { calls, isMarkdownReached } = world(on, `${WORKTREES}/fix-login`, 'ledger:go', { [NEW_API]: PARKED.replace('fast-steps', 'new-api') }, { broken: 'write' })
  const { text } = await $.command.run({ command: 'ledger:go', args: 'new-api' })
  expect(text).toContain('Could not remove the parked marker from new-api.')
  expect(text).toContain('EACCES')
  expect(text).toContain('Nothing was written, and the session was not cleared.')
  expect(isMarkdownReached()).toBe(false)
  await $.turn.complete(turnEnd)
  expect(calls).toEqual([`write ${NEW_API}`])
})

test('/ledger shows a parked task with its date and reason', async ($, on) => {
  world(on, '/repo', 'ledger', { [NEW_API]: PARKED.replace('fast-steps', 'new-api') })
  const { text } = await $.command.run({ command: 'ledger', args: 'new-api' })
  expect(text).toContain('- **Parked:** 2026-10-01 — waiting on the API review')
  expect(text).not.toContain('**Now:**')
})
