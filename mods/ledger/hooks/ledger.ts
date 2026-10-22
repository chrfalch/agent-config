export type Row = { number: string; step: string; status: string }

export type Parked = { date: string; reason: string }

/** A line of a parent's Children section, as bin/cc-ledger-parent writes it. */
export type ChildLine = { slug: string; retired?: string; started?: string }

export type LedgerSummary = {
  slug: string
  editedMs: number
  goal: string
  current: Row | 'all done' | null
  next: string
  parked?: Parked
  parent?: string
  children?: ChildLine[]
  /** A ledger in ~/.claude/ledger-backlog/, shown because it is a parent of a listed task. */
  isBacklog?: true
}

const FINISHED = /^(done|accepted|reviewed|dropped|skipped)\b/i

// Location and Children are matched exactly, as bin/cc-ledger-parent does; other headings carry a suffix such as "(approved …)".
function section(text: string, heading: string, exact = false): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => (exact ? line.trimEnd() === `## ${heading}` : line.startsWith(`## ${heading}`)))
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
}

function firstLine(lines: string[]): string {
  return lines.map(line => line.trim()).find(line => line !== '') ?? ''
}

function currentStep(planLines: string[]): Row | 'all done' | null {
  const rows: Row[] = planLines
    .filter(line => line.trim().startsWith('|'))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .map(([number = '', step = '', status = '']) => ({ number, step, status }))
    .filter(row => /^\d+$/.test(row.number))
  if (rows.length === 0) return null
  return rows.find(row => !FINISHED.test(row.status)) ?? 'all done'
}

const NEXT_STEP = '## Next step'
const PARKED = /^Parked:[ \t]*(\d{4}-\d{2}-\d{2})[ \t]*[—-][ \t]*(.*)$/

function parkedOf(line: string): Parked | null {
  const match = PARKED.exec(line.trim())
  return match ? { date: match[1] ?? '', reason: match[2]?.trim() ?? '' } : null
}

function parentOf(text: string): string | undefined {
  return section(text, 'Location', true)
    .map(line => line.trimEnd().match(/^- parent:[ \t]*(\S+)$/)?.[1])
    .find(value => value !== undefined && !value.startsWith('<'))
}

const CHILD = /^- ([A-Za-z0-9._-]+)(?: \((retired|started) (\d{4}-\d\d-\d\d)\))?$/

function childrenOf(text: string): ChildLine[] {
  return section(text, 'Children', true).flatMap(line => {
    const [, slug, mark, date = ''] = line.trim().match(CHILD) ?? []
    if (!slug) return []
    return [{ slug, ...(mark === 'retired' && { retired: date }), ...(mark === 'started' && { started: date }) }]
  })
}

export function summarize(text: string, fallbackSlug: string, editedMs: number): LedgerSummary {
  const title = text.match(/^# Task ledger[ \t]*[—-][ \t]*(.*)$/m)
  const nextStep = section(text, 'Next step')
  const parked = parkedOf(firstLine(nextStep))
  const parent = parentOf(text)
  const children = childrenOf(text)
  return {
    slug: title?.[1]?.trim() || fallbackSlug,
    editedMs,
    goal: firstLine(section(text, 'Goal')),
    current: currentStep(section(text, 'Plan')),
    next: firstLine(nextStep.filter(line => parkedOf(line) === null)),
    ...(parked && { parked }),
    ...(parent && { parent }),
    ...(children.length > 0 && { children }),
  }
}

export type Grouped<T> = { item: T; children: Grouped<T>[] }

/**
 * Puts each item under the first listed item its parent key names, at any depth. The top level keeps the order of `items`,
 * and so do the children of each item, unless `compareChildren` sorts them.
 * An item whose parent is not listed stays at the top, and so does each item of a cycle, with its other children under it.
 */
export function groupByParent<T>(
  items: T[],
  key: (item: T) => string,
  parentKey: (item: T) => string | undefined,
  compareChildren: (a: T, b: T) => number = () => 0,
): Grouped<T>[] {
  const first = new Map<string, T>()
  for (const item of items) if (!first.has(key(item))) first.set(key(item), item)
  const listedParent = (item: T) => {
    const parent = parentKey(item)
    return parent !== undefined && parent !== key(item) && first.has(parent) ? parent : undefined
  }
  const isInCycle = (item: T) => {
    const seen = new Set<string>()
    for (let parent = listedParent(item); parent !== undefined && !seen.has(parent); ) {
      if (parent === key(item)) return true
      seen.add(parent)
      const next = first.get(parent)
      parent = next && listedParent(next)
    }
    return false
  }
  const isTop = (item: T) => listedParent(item) === undefined || isInCycle(item)
  const group = (item: T): Grouped<T> => ({
    item,
    children: first.get(key(item)) === item ? items.filter(child => !isTop(child) && listedParent(child) === key(item)).sort(compareChildren).map(group) : [],
  })
  return items.filter(isTop).map(group)
}

/** The order of a parent's child tasks: the active ones first, then the others, each newest first. */
export const childOrder =
  <T>(isActive: (item: T) => boolean, time: (item: T) => number) =>
  (a: T, b: T): number =>
    Number(isActive(b)) - Number(isActive(a)) || time(b) - time(a)

export const isoDate = (date: Date): string =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-')

export function parkMarker(today: Date, reason: string): string {
  return `Parked: ${isoDate(today)} — ${reason.trim().split(/\s+/).join(' ')}`
}

/** Removes every parked marker under Next step, and reports the first. */
export function unpark(text: string): { text: string; parked: Parked | null } {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith(NEXT_STEP))
  if (start === -1) return { text, parked: null }
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  const body = end === -1 ? rest : rest.slice(0, end)
  const parked = body.map(parkedOf).find(marker => marker !== null) ?? null
  if (parked === null) return { text, parked }
  const kept = body.filter(line => parkedOf(line) === null)
  return { text: [...lines.slice(0, start + 1), ...kept, ...(end === -1 ? [] : rest.slice(end))].join('\n'), parked }
}

/** Puts the marker first under Next step, replacing any earlier marker, and adds the section when there is none. */
export function park(text: string, marker: string): string {
  const unparked = unpark(text).text
  const lines = unparked.split('\n')
  const start = lines.findIndex(line => line.startsWith(NEXT_STEP))
  if (start === -1) return `${unparked.replace(/\n*$/, '')}\n\n${NEXT_STEP}\n${marker}\n`
  return [...lines.slice(0, start + 1), marker, ...lines.slice(start + 1)].join('\n')
}

export const PARK_USAGE =
  'Usage: /ledger:park [<slug>] <reason>. Without a slug it writes this task\'s ledger, parks it and clears the session. Run /ledger to see each slug.'

export function formatTime(ms: number): string {
  const date = new Date(ms)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

function formatStep({ current, parked }: LedgerSummary): string {
  if (parked) return `**Parked:** ${parked.date} — ${parked.reason}`
  if (current === null) return ''
  if (current === 'all done') return '**Now:** all plan steps done'
  return `**Now:** step ${current.number} · ${current.step} — *${current.status}*`
}

function fields(ledger: LedgerSummary): string[] {
  return [ledger.goal && `**Goal:** ${ledger.goal}`, formatStep(ledger), ledger.next && `**Next:** ${ledger.next}`].filter(field => field !== '')
}

const title = (ledger: LedgerSummary): string => (ledger.isBacklog ? `${ledger.slug} (backlog)` : ledger.slug)

function childLines(children: Grouped<LedgerSummary>[], indent: string): string[] {
  if (children.length === 0) return []
  return [
    `${indent}- **Children:**`,
    ...children.flatMap(({ item, children: grandchildren }) => [
      `${indent}  - **${title(item)}** · edited ${formatTime(item.editedMs)}`,
      ...fields(item).map(field => `${indent}    - ${field}`),
      ...childLines(grandchildren, `${indent}    `),
    ]),
  ]
}

export function format(ledger: LedgerSummary, children: Grouped<LedgerSummary>[] = []): string {
  return [
    `#### ${title(ledger)} · edited ${formatTime(ledger.editedMs)}`,
    ...fields(ledger).map(field => `- ${field}`),
    ...(ledger.parent ? [`- **Parent:** ${ledger.parent}`] : []),
    ...childLines(children, ''),
  ].join('\n')
}

export function formatAll(ledgers: LedgerSummary[]): string {
  const groups = groupByParent(
    ledgers,
    ledger => ledger.slug,
    ledger => ledger.parent,
    childOrder(ledger => !ledger.isBacklog && !ledger.parked, ledger => ledger.editedMs),
  )
  const order = groups.some(({ children }) => children.length > 0) ? 'newest first, children under their parent' : 'newest first'
  const count = ledgers.length === 1 ? '1 ledger' : `${ledgers.length} ledgers, ${order}`
  return [`**Task ledgers** · ${count}`, ...groups.map(({ item, children }) => format(item, children))].join('\n\n')
}

export function ledgerPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
}

export function folderSlug(ledgerPath: string): string {
  return ledgerPath.split('/').at(-3) ?? ''
}

export type ActiveLedger = { kind: 'none' } | { kind: 'one'; path: string } | { kind: 'several'; paths: string[] }

const LEDGER_SUFFIX = '/.claude/ledger.md'

export function activeLedger(paths: string[], cwd: string): ActiveLedger {
  const matches = paths.filter(path => {
    const root = path.slice(0, -LEDGER_SUFFIX.length)
    return path.endsWith(LEDGER_SUFFIX) && (cwd === root || cwd.startsWith(`${root}/`))
  })
  const [only] = matches
  if (only === undefined) return { kind: 'none' }
  return matches.length === 1 ? { kind: 'one', path: only } : { kind: 'several', paths: matches }
}

const UNCHANGED = 'Nothing was written, and the session was not cleared.'

export function noLedgerMessage(cwd: string): string {
  return `No task ledger found for ${cwd}. ${UNCHANGED} Run this command from the task's worktree, or start a task with /ledger:task.`
}

export function severalLedgersMessage(cwd: string, slugs: string[], outcome = UNCHANGED): string {
  return `Several task ledgers hold ${cwd}: ${slugs.join(', ')}. ${outcome} Run this command from a task worktree that is not inside another one.`
}

export function removedFolderMessage(folder: string): string {
  return `The session folder ${folder} no longer exists, so this session has no task ledger. ${UNCHANGED} Continue another task with /ledger:go <slug>, or run /ledger:close.`
}

export function lookupFailedMessage(error: string): string {
  return `Could not check this task's ledger. ${error} ${UNCHANGED}`
}

/** A child task as `cc-ledger-parent show --json` reports it. */
export type ChildStatus = { slug: string; status: string; next: string }

export type Family = { parent?: string; children?: ChildStatus[] }

const statusList = (children: ChildStatus[]): string => children.map(({ slug, status }) => `${slug} (${status})`).join(', ')

export type GoFields = {
  parked?: Parked | null
  family?: Family
  promotedWorktree?: string
  /** The slugs from the parent task the operator named down to the child task /ledger:go picked. */
  picked?: string[]
  /** The ledger in which /ledger:go marked the task started. */
  marked?: string
  warnings?: string[]
}

// One field per line, because a slug and a path can both hold spaces. go.md reads this format.
export function goArgs(
  target: string,
  ledgerPath: string | undefined,
  { parked, family = {}, promotedWorktree, picked, marked, warnings = [] }: GoFields = {},
): string {
  const fields = [`task: ${target}`, `ledger: ${ledgerPath ?? 'none'}`]
  if (parked) fields.push(`parked: ${parked.date} — ${parked.reason}`)
  if (family.parent) fields.push(`parent: ${family.parent}`)
  if (family.children?.length) fields.push(`children: ${statusList(family.children)}`)
  if (promotedWorktree) fields.push(`promoted: ${promotedWorktree}`)
  if (picked) fields.push(`picked: ${picked.join(' > ')}`)
  if (marked) fields.push(`marked: ${marked}`)
  for (const warning of warnings) fields.push(`warning: ${warning}`)
  return fields.join('\n')
}

export const worktreeWithoutLedgerMessage = (word: string, worktree: string): string =>
  `${word} names the worktree ${worktree}, which has no task ledger. ${UNCHANGED} To give it one, type /ledger:task --here in a session there.`

export const worktreeTaskMessage = (word: string, worktree: string, slug: string): string =>
  `${word} names the worktree ${worktree}, task ${slug}. ${UNCHANGED} Type /ledger:park ${slug} <reason>.`

export function parkArgs(slug: string, ledgerPath: string, reason: string): string {
  return [`task: ${slug}`, `ledger: ${ledgerPath}`, `reason: ${reason}`].join('\n')
}

export const GO_USAGE = 'Usage: /ledger:go <slug>. Run /ledger to see the slug of each task.'

export type TaskName = { slug: string; parent?: string }

function taskList(tasks: TaskName[]): string {
  const groups = groupByParent(tasks, task => task.slug, task => task.parent)
  const nested = ({ item, children }: Grouped<TaskName>): string =>
    children.length > 0 ? `${item.slug} (children: ${children.map(nested).join(', ')})` : item.slug
  const name = (group: Grouped<TaskName>) => (group.children.length === 0 && group.item.parent ? `${group.item.slug} (parent: ${group.item.parent})` : nested(group))
  return groups.map(name).join(', ')
}

export function unknownTaskMessage(target: string, tasks: TaskName[], outcome = UNCHANGED): string {
  return `No task ledger is named "${target}". ${outcome} Task ledgers: ${taskList(tasks) || 'none'}.`
}

// Script errors have no final period.
const sentence = (text: string): string => text.replace(/[.\s]*$/, '.')

export function promoteFailedMessage(target: string, error: string): string {
  return `Could not start backlog task ${target}. ${sentence(error)} ${UNCHANGED}`
}

export function promotedThenFailedMessage(target: string, worktree: string, error: string): string {
  return `Promoted backlog task ${target}: its branch, worktree and ledger are at ${worktree}. Then this failed: ${sentence(error)} The session was not cleared.`
}

export function noChildToStartMessage(target: string, children: ChildStatus[] | { error: string }): string {
  const listed = 'error' in children ? `Its child tasks could not be listed: ${sentence(children.error)}` : `Child tasks: ${statusList(children)}.`
  return `Backlog task ${target} has no child task left to start. ${listed} ${UNCHANGED} A parent task in the backlog stays there: continue in a child task with /ledger:go <child>, or add one with /ledger:parent ${target} add <child>.`
}

export function pickFailedMessage(target: string, error: string): string {
  return `Could not pick a child task of backlog task ${target} to start: ${sentence(error)} ${UNCHANGED}`
}

export const pickFailedWarning = (target: string, error: string): string =>
  `Could not pick a child task of ${target} to start, so this continues in ${target}: ${sentence(error)}`

export const markFailedWarning = (child: string, parent: string, error: string): string =>
  `Could not mark ${child} started in its parent ${parent}: ${sentence(error)}`

export function otherRepositoryMessage(target: string, repo: string, main: string): string {
  return `Backlog task ${target} belongs to the ${repo} repository, with its main checkout at ${main}. ${UNCHANGED} Run /ledger:go ${target} from a session in that repository.`
}

export function backlogUncheckedMessage(target: string, tasks: TaskName[], error: string, outcome = UNCHANGED): string {
  return `${unknownTaskMessage(target, tasks, outcome)} The backlog could not be checked: ${sentence(error)}`
}

export function unparkFailedMessage(target: string, error: string): string {
  return `Could not remove the parked marker from ${target}. ${error} ${UNCHANGED}`
}

export function sharedSlugMessage(target: string, paths: string[], outcome = UNCHANGED): string {
  return `Several task ledgers are named "${target}": ${paths.join(', ')}. ${outcome} Give each task its own slug in its ledger's title.`
}

/** A task branch: commits ahead of origin's default branch, and every PR from it as `gh pr list --state all` lists them. */
export type BranchState = { ahead: number; prs: { state: string; number: number }[] }

/** The line shown after a finished task's session clears. `null` means git or gh could not tell whether the branch is merged. */
export function retireHint(slug: string, branch: BranchState | null): string {
  const finished = `Task ${slug} is finished`
  if (branch && (branch.ahead === 0 || branch.prs.some(pr => pr.state === 'MERGED'))) {
    return `${finished} and merged. Retire it with \`/ledger:retire ${slug}\`.`
  }
  const open = branch?.prs.find(pr => pr.state === 'OPEN')
  if (open) return `${finished}. After PR #${open.number} merges, run \`/ledger:retire ${slug}\`.`
  return `${finished}. Run \`/ledger:retire ${slug} --dry-run\` to see what blocks retiring it.`
}

export const HELP = [
  "- `/ledger` — Show each task ledger's goal, current step and next step. A parent task in this repo's backlog is shown too, marked (backlog). `/ledger <name>` shows one.",
  '- `/ledger:task` — Add a separate task to the backlog: a ledger only, with no branch or worktree yet. `/ledger:go <slug>` starts it. With no current ledger, it starts the task at once and continues in this session. `--here` adds a ledger to this worktree instead.',
  "- `/ledger:update` — Write the latest results to this task's ledger. Without one, it points to `/ledger:task`.",
  "- `/ledger:next` — Write this task's ledger, clear the session, and continue from the next step. When every step is done, it first says how to retire the task.",
  "- `/ledger:close` — Write this task's ledger, then clear the session.",
  "- `/ledger:go <slug>` — Write this task's ledger, clear the session, and continue in the task named <slug>. A backlog task first gets its branch and worktree, which works only from a session in its repository. A child task is marked started in its parent ledger. A parent task starts its first child task not yet started instead; a parent task in the backlog with none left stays there. When every step of this task is done, it first says how to retire it.",
  "- `/ledger:park [<slug>] <reason>` — Mark a task parked. Without a slug it writes this task's ledger, parks it, then clears the session.",
  "- `/ledger:parent [<slug>]` — Show a parent task and each child's status and next step; without a slug, this task or its parent. `<slug> add <child>` and `<slug> remove <child>` change its children.",
  "- `/ledger:worktrees` — Show each linked git worktree's size, last commit, dirty files, ledger and PR.",
  "- `/ledger:retire [<slug>]` — Archive a task's ledger, remove its worktree, and delete its branch when all of its commits are merged. A backlog task of this repo has no worktree or branch: its ledger is archived, then deleted. `--dry-run` only shows what it would do. Uncommitted changes, unmerged work and active child tasks need `--force`.",
  "- `/ledger:archive [<term>]` — List this repo's archived ledgers, newest first; a term keeps those that contain it, and `--all` lists every repo.",
  '- `/ledger:all` — Show every task ledger on this machine, active, backlog and archived; `--scan` rebuilds the list from disk.',
  '- `/ledger:dashboard` — Start a web page on this machine that lists every task ledger, with search, details, park and retire. It keeps running after the session ends; `stop` stops it.',
  '- `/ledger:help` — Show this list.',
].join('\n')
