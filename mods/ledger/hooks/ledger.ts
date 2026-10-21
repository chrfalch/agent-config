export type Row = { number: string; step: string; status: string }

export type Parked = { date: string; reason: string }

/** A line of a parent's Children section, as bin/cc-ledger-parent writes it. */
export type ChildLine = { slug: string; retired?: string }

export type LedgerSummary = {
  slug: string
  editedMs: number
  goal: string
  current: Row | 'all done' | null
  next: string
  parked?: Parked
  parent?: string
  children?: ChildLine[]
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

const CHILD = /^- ([A-Za-z0-9._-]+)(?: \(retired (\d{4}-\d\d-\d\d)\))?$/

function childrenOf(text: string): ChildLine[] {
  return section(text, 'Children', true).flatMap(line => {
    const [, slug, retired] = line.trim().match(CHILD) ?? []
    return slug ? [{ slug, ...(retired && { retired }) }] : []
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

export type Grouped<T> = { item: T; children: T[] }

/**
 * Puts each item under the first listed item its parent key names, one level deep, keeping the order of both.
 * An item whose parent is not listed, or is itself listed under a parent, stays at the top.
 */
export function groupByParent<T>(items: T[], key: (item: T) => string, parentKey: (item: T) => string | undefined): Grouped<T>[] {
  const keys = new Set(items.map(key))
  const listedParent = (item: T) => {
    const parent = parentKey(item)
    return parent !== undefined && parent !== key(item) && keys.has(parent) ? parent : undefined
  }
  const tops = new Set(items.filter(item => listedParent(item) === undefined).map(key))
  const nestedUnder = (item: T) => {
    const parent = listedParent(item)
    return parent !== undefined && tops.has(parent) ? parent : undefined
  }
  const groups = items.filter(item => nestedUnder(item) === undefined).map((item): Grouped<T> => ({ item, children: [] }))
  const byKey = new Map<string, Grouped<T>>()
  for (const group of groups) if (!byKey.has(key(group.item))) byKey.set(key(group.item), group)
  for (const item of items) {
    const parent = nestedUnder(item)
    if (parent !== undefined) byKey.get(parent)?.children.push(item)
  }
  return groups
}

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

export function format(ledger: LedgerSummary, children: LedgerSummary[] = []): string {
  return [
    `#### ${ledger.slug} · edited ${formatTime(ledger.editedMs)}`,
    ...fields(ledger).map(field => `- ${field}`),
    ...(ledger.parent ? [`- **Parent:** ${ledger.parent}`] : []),
    ...(children.length > 0 ? ['- **Children:**'] : []),
    ...children.flatMap(child => [`  - **${child.slug}** · edited ${formatTime(child.editedMs)}`, ...fields(child).map(field => `    - ${field}`)]),
  ].join('\n')
}

export function formatAll(ledgers: LedgerSummary[]): string {
  const groups = groupByParent(ledgers, ledger => ledger.slug, ledger => ledger.parent)
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

export function lookupFailedMessage(error: string): string {
  return `Could not check this task's ledger. ${error} ${UNCHANGED}`
}

/** A child task as `cc-ledger-parent show --json` reports it. */
export type ChildStatus = { slug: string; status: string; next: string }

export type Family = { parent?: string; children?: ChildStatus[] }

// One field per line, because a slug and a path can both hold spaces. go.md reads this format.
export function goArgs(
  target: string,
  ledgerPath: string | undefined,
  parked: Parked | null = null,
  family: Family = {},
  promotedWorktree?: string,
): string {
  const fields = [`task: ${target}`, `ledger: ${ledgerPath ?? 'none'}`]
  if (parked) fields.push(`parked: ${parked.date} — ${parked.reason}`)
  if (family.parent) fields.push(`parent: ${family.parent}`)
  if (family.children?.length) fields.push(`children: ${family.children.map(({ slug, status }) => `${slug} (${status})`).join(', ')}`)
  if (promotedWorktree) fields.push(`promoted: ${promotedWorktree}`)
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
  const name = ({ item, children }: Grouped<TaskName>) => {
    if (children.length > 0) return `${item.slug} (children: ${children.map(child => child.slug).join(', ')})`
    return item.parent ? `${item.slug} (parent: ${item.parent})` : item.slug
  }
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

export function otherRepositoryMessage(target: string, repo: string, main: string): string {
  return `Backlog task ${target} belongs to the ${repo} repository, with its main checkout at ${main}. ${UNCHANGED} Run /ledger:go ${target} from a session in that repository.`
}

export function backlogUncheckedMessage(target: string, tasks: TaskName[], error: string): string {
  return `${unknownTaskMessage(target, tasks)} The backlog could not be checked: ${sentence(error)}`
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
    return `${finished} and merged. Retire it with \`/ledger:retire ${slug} --yes\`.`
  }
  const open = branch?.prs.find(pr => pr.state === 'OPEN')
  if (open) return `${finished}. After PR #${open.number} merges, run \`/ledger:retire ${slug} --yes\`.`
  return `${finished}. Run \`/ledger:retire ${slug}\` to see what blocks retiring it.`
}

export const HELP = [
  "- `/ledger` — Show each task ledger's goal, current step and next step. `/ledger <name>` shows one.",
  '- `/ledger:task` — Add a separate task to the backlog: a ledger only, with no branch or worktree yet. `/ledger:go <slug>` starts it. With no current ledger, it starts the task at once and continues in this session. `--here` adds a ledger to this worktree instead.',
  "- `/ledger:update` — Write the latest results to this task's ledger. Without one, it points to `/ledger:task`.",
  "- `/ledger:next` — Write this task's ledger, clear the session, and continue from the next step. When every step is done, it first says how to retire the task.",
  "- `/ledger:close` — Write this task's ledger, then clear the session.",
  "- `/ledger:go <slug>` — Write this task's ledger, clear the session, and continue in the task named <slug>. A backlog task first gets its branch and worktree, which works only from a session in its repository. When every step of this task is done, it first says how to retire it.",
  "- `/ledger:park [<slug>] <reason>` — Mark a task parked. Without a slug it writes this task's ledger, parks it, then clears the session.",
  "- `/ledger:parent [<slug>]` — Show a parent task and each child's status and next step; without a slug, this task or its parent. `<slug> add <child>` and `<slug> remove <child>` change its children.",
  "- `/ledger:worktrees` — Show each linked git worktree's size, last commit, dirty files, ledger and PR.",
  '- `/ledger:retire [<slug>]` — Show what retiring a task would archive and remove; `--yes` archives its ledger, removes its worktree, and deletes its branch when all of its commits are merged.',
  "- `/ledger:archive [<term>]` — List this repo's archived ledgers, newest first; a term keeps those that contain it, and `--all` lists every repo.",
  '- `/ledger:all` — Show every task ledger on this machine, active, backlog and archived; `--scan` rebuilds the list from disk.',
  '- `/ledger:dashboard` — Start a web page on this machine that lists every task ledger, with search, details, park and retire. It keeps running after the session ends; `stop` stops it.',
  '- `/ledger:help` — Show this list.',
].join('\n')
