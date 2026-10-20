import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import {
  activeLedger,
  folderSlug,
  formatAll,
  GO_USAGE,
  goArgs,
  HELP,
  ledgerPaths,
  lookupFailedMessage,
  noLedgerMessage,
  severalLedgersMessage,
  sharedSlugMessage,
  summarize,
  unknownTaskMessage,
} from './ledger'
import { worktreesCommand } from './worktrees-command'

type Found = { path: string; slug: string; mtimeMs: number }

const armed = { plugin: 'ledger', key: 'armed' } as const

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The SessionStart hook's own lookup, so /ledger and the hook always agree on which ledgers exist.
async function findLedgers($: EngineInterface): Promise<Found[] | { error: string }> {
  const script = `${$.plugin.root}/../../hooks/ledger-list.sh`
  const cwd = await $.session.cwd()
  let result: ProcessRunResult
  try {
    result = await $.process.run(['bash', script, 'paths'], { cwd })
  } catch (error) {
    return { error: `${script} did not run: ${message(error)}` }
  }
  const { exitCode, stdout, stderr } = result
  if (exitCode !== 0) return { error: `${script} failed (exit ${exitCode}): ${stderr.trim()}` }
  const found = await Promise.all(
    ledgerPaths(stdout).map(async path => ({ path, slug: folderSlug(path), mtimeMs: (await $.fs.stat(path)).mtimeMs })),
  )
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function titleSlug($: EngineInterface, path: string): Promise<string> {
  return summarize(await $.fs.read(path), folderSlug(path), 0).slug
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ledger',
      description: 'Show each task ledger: goal, current step, next step. /ledger <name> shows one.',
    })
    return next(e)
  })

  on('command.run', { command: 'ledger' }, async ($, e) => {
    const found = await findLedgers($)
    if ('error' in found) return { text: `Could not list task ledgers. ${found.error}` }
    const filter = e.args.trim().toLowerCase()
    const ledgers = found.filter(ledger => ledger.slug.toLowerCase().includes(filter))
    if (ledgers.length === 0) {
      return { text: filter ? `No ledger matches "${filter}".` : 'No task ledgers found.' }
    }
    const summaries = await Promise.all(
      ledgers.map(async ledger => summarize(await $.fs.read(ledger.path), ledger.slug, ledger.mtimeMs)),
    )
    return { text: formatAll(summaries) }
  })

  // The markdown command writes to the ledger, so it must not run unless exactly one ledger is active.
  on('command.run', { command: ['ledger:close', 'ledger:next'] }, async ($, e, next) => {
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const cwd = await $.session.cwd()
    const active = activeLedger(found.map(ledger => ledger.path), cwd)
    if (active.kind === 'none') return { text: noLedgerMessage(cwd) }
    if (active.kind === 'several') return { text: severalLedgersMessage(cwd, active.paths.map(folderSlug)) }
    const slug = await titleSlug($, active.path)
    await $.state.set(armed, { mode: e.command === 'ledger:next' ? 'next' : 'close', slug })
    return next(e)
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // A command.run hook cannot clear the session, and an answer of { text } ends no turn, so go.md runs a
  // model turn even when there is no ledger to write: its turn.complete is what clears.
  on('command.run', { command: 'ledger:go' }, async ($, e, next) => {
    const target = (e.args ?? '').trim()
    if (target === '') return { text: GO_USAGE }
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const slugs = await Promise.all(found.map(ledger => titleSlug($, ledger.path)))
    const matches = found.filter((_, index) => slugs[index] === target)
    if (matches.length === 0) return { text: unknownTaskMessage(target, slugs) }
    if (matches.length > 1) return { text: sharedSlugMessage(target, matches.map(ledger => ledger.path)) }
    const cwd = await $.session.cwd()
    const active = activeLedger(found.map(ledger => ledger.path), cwd)
    if (active.kind === 'several') return { text: severalLedgersMessage(cwd, active.paths.map(folderSlug)) }
    await $.state.set(armed, { mode: 'go', slug: target })
    return next({ ...e, args: goArgs(target, active.kind === 'one' ? active.path : undefined) })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // Typed as always a string, but `claude plugin test` leaves it undefined when the caller omits it.
  on('command.run', { command: 'ledger:worktrees' }, async ($, e) => ({ text: await worktreesCommand($, e.args ?? '') }))

  on('command.run', { command: 'ledger:help' }, async () => ({ text: HELP }))

  // $.command.run and $.prompt.submit must not be awaited inside a command.run hook, so the clear waits for the turn's end.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { value } = await $.state.get(armed)
    if (!value) return next(e)
    await $.state.set(armed, null)
    if (e.reason !== 'answer') return next(e)
    const go = `go ${value.slug}`
    try {
      await $.command.run({ command: 'clear' })
    } catch (error) {
      const then = value.mode === 'close' ? '' : `, then say: ${go}`
      $.ui.log(`/ledger:${value.mode} could not clear the session: ${message(error)}. Run /clear${then}.`)
      return next(e)
    }
    if (value.mode !== 'close') {
      try {
        await $.prompt.submit({ text: go })
      } catch (error) {
        $.ui.log(`/ledger:${value.mode} cleared the session but could not send "${go}": ${message(error)}. Say: ${go}.`)
      }
    }
    return next(e)
  })
}
