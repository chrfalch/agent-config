import type { EngineInterface, Register } from 'claude-code'

import { allCommand } from './all-command'
import {
  activeLedger,
  backlogUncheckedMessage,
  folderSlug,
  formatAll,
  GO_USAGE,
  goArgs,
  HELP,
  lookupFailedMessage,
  noLedgerMessage,
  otherRepositoryMessage,
  otherTaskMessage,
  PARK_USAGE,
  park,
  parkArgs,
  parkMarker,
  promotedThenFailedMessage,
  promoteFailedMessage,
  retireHint,
  severalLedgersMessage,
  sharedSlugMessage,
  summarize,
  unknownTaskMessage,
  unpark,
  unparkFailedMessage,
} from './ledger'
import { archiveCommand } from './archive-command'
import { findLedgers, lookUpBranch, message, namesOtherWorktree, titleSlug } from './lookup'
import { familyOf, parentCommand } from './parent-command'
import { mainCheckout, otherRepositoryTask, promoteBacklogTask, registeredTasks } from './registry'
import { worktreeOf } from './retire'
import { retireCommand } from './retire-command'
import { worktreesCommand } from './worktrees-command'

const armed = { plugin: 'ledger', key: 'armed' } as const

// Read at the turn's end, because the model may have just finished the last step. The line is only advice, so a failure skips it.
async function showRetireHint($: EngineInterface, ledger: string): Promise<void> {
  try {
    const { slug, current } = summarize(await $.fs.read(ledger), folderSlug(ledger), 0)
    if (current === 'all done') $.ui.log(retireHint(slug, await lookUpBranch($, worktreeOf(ledger))))
  } catch {}
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
    await $.state.set(armed, e.command === 'ledger:next' ? { mode: 'next', slug, ledger: active.path } : { mode: 'close', slug })
    return next(e)
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // A command.run hook cannot clear the session, and an answer of { text } ends no turn, so go.md runs a
  // model turn even when there is no ledger to write: its turn.complete is what clears.
  // Set once this run's promotion succeeds, so the .catch below does not say that nothing was written.
  let promotedByGo: string | undefined
  on('command.run', { command: 'ledger:go' }, async ($, e, next) => {
    promotedByGo = undefined
    const target = (e.args ?? '').trim()
    if (target === '') return { text: GO_USAGE }
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const tasks = await Promise.all(found.map(async ledger => summarize(await $.fs.read(ledger.path), folderSlug(ledger.path), 0)))
    const matches = found.filter((_, index) => tasks[index]?.slug === target)
    const [match] = matches
    const registered = match === undefined ? await registeredTasks($, target) : []
    if ('error' in registered) return { text: backlogUncheckedMessage(target, tasks, registered.error) }
    const backlog = registered.filter(entry => entry.status === 'backlog')
    // The registry write at backlog time is best effort, so an unregistered slug may still have a backlog ledger.
    const isUnregistered = match === undefined && registered.length === 0
    if (match === undefined && backlog.length === 0 && !isUnregistered) return { text: unknownTaskMessage(target, tasks) }
    if (matches.length > 1) return { text: sharedSlugMessage(target, matches.map(ledger => ledger.path)) }
    const cwd = await $.session.cwd()
    const active = activeLedger(found.map(ledger => ledger.path), cwd)
    if (active.kind === 'several') return { text: severalLedgersMessage(cwd, active.paths.map(folderSlug)) }
    let ledger = match?.path
    let promotedWorktree: string | undefined
    if (ledger === undefined) {
      const elsewhere = otherRepositoryTask(backlog, await mainCheckout($, cwd))
      if (elsewhere) return { text: otherRepositoryMessage(target, elsewhere.repo, elsewhere.main) }
      const promoted = await promoteBacklogTask($, target, cwd)
      if ('error' in promoted) {
        return { text: isUnregistered && promoted.isMissing ? unknownTaskMessage(target, tasks) : promoteFailedMessage(target, promoted.error) }
      }
      ledger = promoted.ledger
      promotedWorktree = worktreeOf(ledger)
      promotedByGo = promotedWorktree
    }
    const text = await $.fs.read(ledger)
    const { text: unparked, parked } = unpark(text)
    if (parked) {
      try {
        await $.fs.write(ledger, unparked)
      } catch (error) {
        const reason = `Could not remove the parked marker. ${message(error)}`
        return { text: promotedWorktree === undefined ? unparkFailedMessage(target, message(error)) : promotedThenFailedMessage(target, promotedWorktree, reason) }
      }
    }
    const current = active.kind === 'one' ? active.path : undefined
    const task = tasks.find(({ slug }) => slug === target) ?? summarize(text, target, 0)
    const family = await familyOf($, task, cwd)
    await $.state.set(armed, { mode: 'go', slug: target, ...(current && current !== ledger && { ledger: current }) })
    return next({ ...e, args: goArgs(target, current, parked, family, promotedWorktree) })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    if (next.called) return next(e)
    const error = next.error.message ?? next.error.kind
    if (promotedByGo === undefined) return { text: lookupFailedMessage(error) }
    return { text: promotedThenFailedMessage((e.args ?? '').trim(), promotedByGo, error) }
  })

  // The first word names a task only when a ledger has that slug; otherwise it is part of the reason.
  on('command.run', { command: 'ledger:park' }, async ($, e, next) => {
    const words = (e.args ?? '').split(/\s+/).filter(word => word !== '')
    if (words.length === 0) return { text: PARK_USAGE }
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const slugs = await Promise.all(found.map(ledger => titleSlug($, ledger.path)))
    const [first = '', ...rest] = words
    const named = found.filter((_, index) => slugs[index] === first)
    if (named.length > 1) return { text: sharedSlugMessage(first, named.map(ledger => ledger.path)) }
    const [target] = named
    const reason = (target ? rest : words).join(' ')
    if (reason === '') return { text: PARK_USAGE }
    const cwd = await $.session.cwd()
    // From a linked worktree, discovery lists only its own ledger, so another task's name looks like part of the reason.
    if (!target && (await namesOtherWorktree($, first, cwd))) return { text: otherTaskMessage(first) }
    const marker = parkMarker(new Date(), reason)
    const active = activeLedger(found.map(ledger => ledger.path), cwd)
    if (target && !(active.kind === 'one' && active.path === target.path)) {
      try {
        await $.fs.write(target.path, park(await $.fs.read(target.path), marker))
      } catch (error) {
        return { text: `Could not park ${first}. ${message(error)}` }
      }
      return { text: `Parked ${first}. ${marker}` }
    }
    if (active.kind === 'none') return { text: noLedgerMessage(cwd) }
    if (active.kind === 'several') return { text: severalLedgersMessage(cwd, active.paths.map(folderSlug)) }
    const slug = await titleSlug($, active.path)
    await $.state.set(armed, { mode: 'park', slug, ledger: active.path, marker })
    return next({ ...e, args: parkArgs(slug, active.path, reason) })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // Typed as always a string, but `claude plugin test` leaves it undefined when the caller omits it.
  on('command.run', { command: 'ledger:worktrees' }, async ($, e) => ({ text: await worktreesCommand($, e.args ?? '') }))

  on('command.run', { command: 'ledger:retire' }, async ($, e) => ({ text: await retireCommand($, e.args ?? '') }))

  on('command.run', { command: 'ledger:archive' }, async ($, e) => ({ text: await archiveCommand($, e.args ?? '') }))

  on('command.run', { command: 'ledger:all' }, async ($, e) => ({ text: await allCommand($, e.args ?? '') }))

  on('command.run', { command: 'ledger:parent' }, async ($, e) => ({ text: await parentCommand($, e.args ?? '') }))

  on('command.run', { command: 'ledger:help' }, async () => ({ text: HELP }))

  // $.command.run and $.prompt.submit must not be awaited inside a command.run hook, so the clear waits for the turn's end.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const { value } = await $.state.get(armed)
    if (!value) return next(e)
    await $.state.set(armed, null)
    if (e.reason !== 'answer') return next(e)
    // After the model's turn, so its own edits to the ledger cannot move or drop the marker.
    if (value.mode === 'park') {
      try {
        await $.fs.write(value.ledger, park(await $.fs.read(value.ledger), value.marker))
      } catch (error) {
        $.ui.log(`/ledger:park could not mark ${value.slug} parked: ${message(error)}. The session was not cleared.`)
        return next(e)
      }
    }
    const go = `go ${value.slug}`
    const continues = value.mode === 'next' || value.mode === 'go' ? value : null
    try {
      await $.command.run({ command: 'clear' })
    } catch (error) {
      const then = continues ? `, then say: ${go}` : ''
      $.ui.log(`/ledger:${value.mode} could not clear the session: ${message(error)}. Run /clear${then}.`)
      return next(e)
    }
    if (continues) {
      if (continues.ledger) await showRetireHint($, continues.ledger)
      try {
        await $.prompt.submit({ text: go })
      } catch (error) {
        $.ui.log(`/ledger:${value.mode} cleared the session but could not send "${go}": ${message(error)}. Say: ${go}.`)
      }
    }
    return next(e)
  })
}
