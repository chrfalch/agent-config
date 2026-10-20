export type Row = { number: string; step: string; status: string }

export type Parked = { date: string; reason: string }

export type LedgerSummary = {
  slug: string
  editedMs: number
  goal: string
  current: Row | 'all done' | null
  next: string
  parked?: Parked
}

const FINISHED = /^(done|accepted|reviewed|dropped|skipped)\b/i

function section(text: string, heading: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith(`## ${heading}`))
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

export function summarize(text: string, fallbackSlug: string, editedMs: number): LedgerSummary {
  const title = text.match(/^# Task ledger[ \t]*[—-][ \t]*(.*)$/m)
  const nextStep = section(text, 'Next step')
  const parked = parkedOf(firstLine(nextStep))
  return {
    slug: title?.[1]?.trim() || fallbackSlug,
    editedMs,
    goal: firstLine(section(text, 'Goal')),
    current: currentStep(section(text, 'Plan')),
    next: firstLine(nextStep.filter(line => parkedOf(line) === null)),
    ...(parked && { parked }),
  }
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
  if (parked) return `- **Parked:** ${parked.date} — ${parked.reason}`
  if (current === null) return ''
  if (current === 'all done') return '- **Now:** all plan steps done'
  return `- **Now:** step ${current.number} · ${current.step} — *${current.status}*`
}

export function format(ledger: LedgerSummary): string {
  return [
    `#### ${ledger.slug} · edited ${formatTime(ledger.editedMs)}`,
    ledger.goal && `- **Goal:** ${ledger.goal}`,
    formatStep(ledger),
    ledger.next && `- **Next:** ${ledger.next}`,
  ]
    .filter(line => line !== '')
    .join('\n')
}

export function formatAll(ledgers: LedgerSummary[]): string {
  const count = ledgers.length === 1 ? '1 ledger' : `${ledgers.length} ledgers, newest first`
  return [`**Task ledgers** · ${count}`, ...ledgers.map(format)].join('\n\n')
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

// One field per line, because a slug and a path can both hold spaces. go.md reads this format.
export function goArgs(target: string, ledgerPath: string | undefined, parked: Parked | null = null): string {
  const fields = [`task: ${target}`, `ledger: ${ledgerPath ?? 'none'}`]
  if (parked) fields.push(`parked: ${parked.date} — ${parked.reason}`)
  return fields.join('\n')
}

export const otherTaskMessage = (word: string): string =>
  `${word} is another task. Park it from the main checkout, or from that task's own session.`

export function parkArgs(slug: string, ledgerPath: string, reason: string): string {
  return [`task: ${slug}`, `ledger: ${ledgerPath}`, `reason: ${reason}`].join('\n')
}

export const GO_USAGE = 'Usage: /ledger:go <slug>. Run /ledger to see the slug of each task.'

export function unknownTaskMessage(target: string, slugs: string[], outcome = UNCHANGED): string {
  return `No task ledger is named "${target}". ${outcome} Task ledgers: ${slugs.join(', ') || 'none'}.`
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
  '- `/ledger:task` — Start a separate task with its own git worktree, branch and ledger. With no current ledger, it continues in this session. `--here` adds a ledger to this worktree instead.',
  "- `/ledger:update` — Write the latest results to this task's ledger. Without one, it points to `/ledger:task`.",
  "- `/ledger:next` — Write this task's ledger, clear the session, and continue from the next step. When every step is done, it first says how to retire the task.",
  "- `/ledger:close` — Write this task's ledger, then clear the session.",
  "- `/ledger:go <slug>` — Write this task's ledger, clear the session, and continue in the task named <slug>. When every step of this task is done, it first says how to retire it.",
  "- `/ledger:park [<slug>] <reason>` — Mark a task parked. Without a slug it writes this task's ledger, parks it, then clears the session.",
  "- `/ledger:worktrees` — Show each linked git worktree's size, last commit, dirty files, ledger and PR.",
  '- `/ledger:retire [<slug>]` — Show what retiring a task would archive and remove; `--yes` archives its ledger, removes its worktree, and deletes its branch when all of its commits are merged.',
  "- `/ledger:archive [<term>]` — List this repo's archived ledgers, newest first; a term keeps those that contain it, and `--all` lists every repo.",
  '- `/ledger:all` — Show every task ledger on this machine, active and archived; `--scan` rebuilds the list from disk.',
  '- `/ledger:help` — Show this list.',
].join('\n')
