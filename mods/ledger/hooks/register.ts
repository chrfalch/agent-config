import type { EngineInterface, Register } from 'claude-code'

import { allCommand } from './all-command'
import {
  backlogUncheckedMessage,
  folderSlug,
  formatAll,
  GO_USAGE,
  goArgs,
  HELP,
  lookupFailedMessage,
  markFailedWarning,
  noChildToStartMessage,
  noLedgerMessage,
  otherRepositoryMessage,
  PARK_USAGE,
  park,
  parkArgs,
  parkMarker,
  pickFailedMessage,
  pickFailedWarning,
  promotedThenFailedMessage,
  promoteFailedMessage,
  removedFolderMessage,
  retireHint,
  severalLedgersMessage,
  sharedSlugMessage,
  summarize,
  unknownTaskMessage,
  unpark,
  unparkFailedMessage,
  worktreeTaskMessage,
  worktreeWithoutLedgerMessage,
  type LedgerSummary,
} from './ledger'
import { archiveCommand } from './archive-command'
import { dashboardCommand } from './dashboard-command'
import {
  findLedgers,
  lookUpBranch,
  lookUpOtherWorktrees,
  message,
  sessionFolder,
  sessionLedger,
  titleSlug,
  unlistedAncestors,
  type Found,
} from './lookup'
import { childToStart, familyOf, markStarted, parentCommand, showParent } from './parent-command'
import { backlogLedgerPath, mainCheckout, otherRepositoryTask, promoteBacklogTask, registeredTasks, type Entry } from './registry'
import { worktreeOf } from './retire'
import { retireCommand } from './retire-command'
import { basename } from './worktrees'
import { worktreesCommand } from './worktrees-command'

const armed = { plugin: 'ledger', key: 'armed' } as const

const uniqueByPath = (ledgers: Found[]): Found[] => ledgers.filter((ledger, index) => ledgers.findIndex(({ path }) => path === ledger.path) === index)

/** A task's ledger in a worktree, or the registry's backlog entries for it, none when the registry missed it. */
type Place = { ledger: string } | { backlog: Entry[]; isUnregistered: boolean }

/** Where the task `target` is. The text says why it cannot be started: no ledger, or several, has that slug. */
async function placeOf($: EngineInterface, target: string, found: Found[], tasks: LedgerSummary[], cwd: string): Promise<Place | { text: string }> {
  const local = found.filter((_, index) => tasks[index]?.slug === target)
  const matches = uniqueByPath([...local, ...(await lookUpOtherWorktrees($, target, cwd)).ledgers])
  const [match] = matches
  const registered = match === undefined ? await registeredTasks($, target) : []
  if ('error' in registered) return { text: backlogUncheckedMessage(target, tasks, registered.error) }
  const backlog = registered.filter(entry => entry.status === 'backlog')
  // The registry write at backlog time is best effort, so an unregistered slug may still have a backlog ledger.
  const isUnregistered = match === undefined && registered.length === 0
  if (match === undefined && backlog.length === 0 && !isUnregistered) return { text: unknownTaskMessage(target, tasks) }
  if (matches.length > 1) return { text: sharedSlugMessage(target, matches.map(ledger => ledger.path)) }
  return match ? { ledger: match.path } : { backlog, isUnregistered }
}

/**
 * Whether the task's ledger lists child tasks. A backlog ledger is read before its promotion, because a parent task in the
 * backlog is not promoted: where the registry says it is, or where cc-task-new writes it when the registry missed it. One
 * that cannot be found or read counts as having none.
 */
async function hasChildren($: EngineInterface, slug: string, place: Place, main: string | null | undefined): Promise<boolean> {
  const path =
    'ledger' in place
      ? place.ledger
      : place.isUnregistered
        ? main && (await backlogLedgerPath($, main, slug).catch(() => null))
        : place.backlog.find(entry => entry.main === undefined || !main || entry.main === main)?.path
  if (!path) return false
  const text = await $.fs.read(path).catch(() => '')
  return summarize(text, '', 0).children !== undefined
}

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
    const summaries = await Promise.all(found.map(async ledger => summarize(await $.fs.read(ledger.path), ledger.slug, ledger.mtimeMs)))
    const ancestors = await unlistedAncestors($, summaries)
    const filter = e.args.trim().toLowerCase()
    const matches = (name: string) => name.toLowerCase().includes(filter)
    const ledgers = [
      ...summaries.filter((_, index) => matches(found[index]?.slug ?? '')),
      ...('error' in ancestors ? [] : ancestors.filter(({ slug }) => matches(slug))),
    ].sort((a, b) => b.editedMs - a.editedMs)
    const backlogNote = 'error' in ancestors ? [`Parent tasks in the backlog are not shown. ${ancestors.error}`] : []
    if (ledgers.length === 0) {
      return { text: [filter ? `No ledger matches "${filter}".` : 'No task ledgers found.', ...backlogNote].join('\n\n') }
    }
    return { text: [formatAll(ledgers), ...backlogNote].join('\n\n') }
  })

  // The markdown command writes to the ledger, so it must not run unless exactly one ledger is active. The exception is
  // /ledger:close after the session folder was removed: told there is no ledger, it writes nothing, and its turn's end clears.
  on('command.run', { command: ['ledger:close', 'ledger:next'] }, async ($, e, next) => {
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const folder = await sessionFolder($)
    const active = sessionLedger(found, folder)
    if (active.kind === 'none') {
      if (folder.removed === undefined) return { text: noLedgerMessage(folder.path) }
      if (e.command === 'ledger:next') return { text: removedFolderMessage(folder.removed) }
      await $.state.set(armed, { mode: 'close', slug: basename(folder.removed) })
      return next({ ...e, args: 'ledger: none' })
    }
    if (active.kind === 'several') return { text: severalLedgersMessage(folder.path, active.paths.map(folderSlug)) }
    const slug = await titleSlug($, active.path)
    if (e.command === 'ledger:next') {
      await $.state.set(armed, { mode: 'next', slug, ledger: active.path })
      return next(e)
    }
    await $.state.set(armed, { mode: 'close', slug })
    // Set here, so only this hook can tell close.md that there is no ledger.
    return next({ ...e, args: `ledger: ${active.path}` })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    return next.called ? next(e) : { text: lookupFailedMessage(next.error.message ?? next.error.kind) }
  })

  // A command.run hook cannot clear the session, and an answer of { text } ends no turn, so go.md runs a
  // model turn even when there is no ledger to write: its turn.complete is what clears.
  // Set once this run's promotion succeeds, so the .catch below does not say that nothing was written.
  let promotedByGo: { slug: string; worktree: string } | undefined
  on('command.run', { command: 'ledger:go' }, async ($, e, next) => {
    promotedByGo = undefined
    let target = (e.args ?? '').trim()
    if (target === '') return { text: GO_USAGE }
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const tasks = await Promise.all(found.map(async ledger => summarize(await $.fs.read(ledger.path), folderSlug(ledger.path), 0)))
    const folder = await sessionFolder($)
    const cwd = folder.path
    let place = await placeOf($, target, found, tasks, cwd)
    if ('text' in place) return place
    const active = sessionLedger(found, folder)
    if (active.kind === 'several') return { text: severalLedgersMessage(cwd, active.paths.map(folderSlug)) }
    let main: string | null | undefined
    const otherRepository = async (slug: string, at: Place): Promise<{ text: string } | undefined> => {
      if ('ledger' in at) return undefined
      if (main === undefined) main = await mainCheckout($, cwd)
      const elsewhere = otherRepositoryTask(at.backlog, main)
      return elsewhere ? { text: otherRepositoryMessage(slug, elsewhere.repo, elsewhere.main) } : undefined
    }
    const refused = await otherRepository(target, place)
    if (refused) return refused

    const warnings: string[] = []
    let picked: string[] | undefined
    if (await hasChildren($, target, place, main)) {
      const chain = await childToStart($, target, cwd)
      if ('error' in chain) {
        if (!('ledger' in place)) return { text: pickFailedMessage(target, chain.error) }
        warnings.push(pickFailedWarning(target, chain.error))
      } else if (chain.length > 0) {
        picked = chain
        target = chain.at(-1) ?? target
        place = await placeOf($, target, found, tasks, cwd)
        if ('text' in place) return place
        const refusedChild = await otherRepository(target, place)
        if (refusedChild) return refusedChild
      } else if (!('ledger' in place)) {
        const shown = await showParent($, target, cwd)
        return { text: noChildToStartMessage(target, 'error' in shown ? shown : shown.children) }
      }
    }

    let ledger: string
    let promotedWorktree: string | undefined
    if ('ledger' in place) ledger = place.ledger
    else {
      const promoted = await promoteBacklogTask($, target, cwd)
      if ('error' in promoted) {
        return { text: place.isUnregistered && promoted.isMissing ? unknownTaskMessage(target, tasks) : promoteFailedMessage(target, promoted.error) }
      }
      ledger = promoted.ledger
      promotedWorktree = worktreeOf(ledger)
      promotedByGo = { slug: target, worktree: promotedWorktree }
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
    let marked: string | undefined
    if (task.parent) {
      const mark = await markStarted($, task.parent, target, cwd)
      if ('error' in mark) warnings.push(markFailedWarning(target, task.parent, mark.error))
      else marked = mark.marked
    }
    const family = await familyOf($, task, cwd)
    await $.state.set(armed, { mode: 'go', slug: target, ...(current && current !== ledger && { ledger: current }) })
    return next({ ...e, args: goArgs(target, current, { parked, family, promotedWorktree, picked, marked, warnings }) })
  }).catch(async ($, e, next) => {
    await $.state.set(armed, null)
    if (next.called) return next(e)
    const error = next.error.message ?? next.error.kind
    if (promotedByGo === undefined) return { text: lookupFailedMessage(error) }
    return { text: promotedThenFailedMessage(promotedByGo.slug, promotedByGo.worktree, error) }
  })

  // The first word names a task only when a ledger has that slug; otherwise it is part of the reason.
  on('command.run', { command: 'ledger:park' }, async ($, e, next) => {
    const words = (e.args ?? '').split(/\s+/).filter(word => word !== '')
    if (words.length === 0) return { text: PARK_USAGE }
    const found = await findLedgers($)
    if ('error' in found) return { text: lookupFailedMessage(found.error) }
    const slugs = await Promise.all(found.map(ledger => titleSlug($, ledger.path)))
    const [first = '', ...rest] = words
    const folder = await sessionFolder($)
    const cwd = folder.path
    const local = found.filter((_, index) => slugs[index] === first)
    const elsewhere = await lookUpOtherWorktrees($, first, cwd)
    const named = uniqueByPath([...local, ...elsewhere.ledgers])
    if (named.length > 1) return { text: sharedSlugMessage(first, named.map(ledger => ledger.path)) }
    const [target] = named
    const reason = (target ? rest : words).join(' ')
    if (reason === '') return { text: PARK_USAGE }
    if (!target && elsewhere.worktree) {
      const { path, slug } = elsewhere.worktree
      return { text: slug === undefined ? worktreeWithoutLedgerMessage(first, path) : worktreeTaskMessage(first, path, slug) }
    }
    const marker = parkMarker(new Date(), reason)
    const active = sessionLedger(found, folder)
    if (target && !(active.kind === 'one' && active.path === target.path)) {
      try {
        await $.fs.write(target.path, park(await $.fs.read(target.path), marker))
      } catch (error) {
        return { text: `Could not park ${first}. ${message(error)}` }
      }
      return { text: `Parked ${first}. ${marker}` }
    }
    if (active.kind === 'none') return { text: folder.removed === undefined ? noLedgerMessage(cwd) : removedFolderMessage(folder.removed) }
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

  on('command.run', { command: 'ledger:dashboard' }, async ($, e) => ({ text: await dashboardCommand($, e.args ?? '') }))

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
