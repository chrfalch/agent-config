import { expect, test } from 'claude-code/testing'

import { folderSlug, format, formatAll, ledgerPaths, summarize } from './ledger'

const LEDGER = `# Task ledger — fast-steps

## Goal
Prototype two ideas.

## Plan (approved 2026-10-08)
| # | step | status | owner | note |
|---|------|--------|-------|------|
| 1 | baseline runs | done, result negative | me | |
| 2 | runner: tsc | todo | runner | |

## Next step
Ask user: commit + PR.
`

test('the current step is the first plan row that is not done', () => {
  expect(summarize(LEDGER, 'folder', 0)).toEqual({
    slug: 'fast-steps',
    editedMs: 0,
    goal: 'Prototype two ideas.',
    current: { number: '2', step: 'runner: tsc', status: 'todo' },
    next: 'Ask user: commit + PR.',
  })
})

test('a plan with every row done says so', () => {
  const done = LEDGER.replace('| todo |', '| done |')
  expect(summarize(done, 'folder', 0).current).toBe('all done')
})

test('format draws a heading and one bullet per field, leaving out empty ones', () => {
  const ledger = { slug: 's', editedMs: new Date(2026, 9, 9, 8, 5).getTime(), goal: '', current: { number: '2', step: 'tsc', status: 'todo' }, next: '' }
  expect(format(ledger)).toBe('#### s · edited 2026-10-09 08:05\n- **Now:** step 2 · tsc — *todo*')
})

test('formatAll counts the ledgers above them', () => {
  const ledger = { slug: 's', editedMs: 0, goal: 'g', current: null, next: 'n' }
  expect(formatAll([ledger, ledger]).split('\n')[0]).toBe('**Task ledgers** · 2 ledgers, newest first')
})

test('ledgerPaths keeps each non-empty line of the script output, trimmed', () => {
  expect(ledgerPaths('/a/.claude/ledger.md\n  /b/wt/.claude/ledger.md \n\n')).toEqual(['/a/.claude/ledger.md', '/b/wt/.claude/ledger.md'])
})

test('ledgerPaths finds no ledgers in empty output', () => {
  expect(ledgerPaths('')).toEqual([])
  expect(ledgerPaths('\n')).toEqual([])
})

test('folderSlug names the folder that holds .claude/ledger.md', () => {
  expect(folderSlug('/a/b/wt/.claude/ledger.md')).toBe('wt')
  expect(folderSlug('/x/repo with spaces/.claude/ledger.md')).toBe('repo with spaces')
})

test('/ledger reports a lookup script that cannot run instead of failing', async ($, on) => {
  on('session.cwd', async () => ({ value: '/work' }))
  on('process.run', async () => ({ deny: 'spawn bash ENOENT' }))
  const { text } = await $.command.run({ command: 'ledger' })
  expect(text).toContain('Could not list task ledgers.')
  expect(text).toContain('spawn bash ENOENT')
})
