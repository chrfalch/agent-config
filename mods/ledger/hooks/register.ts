import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import { folderSlug, formatAll, ledgerPaths, summarize } from './ledger'

type Found = { path: string; slug: string; mtimeMs: number }

// The SessionStart hook's own lookup, so /ledger and the hook always agree on which ledgers exist.
async function findLedgers($: EngineInterface): Promise<Found[] | { error: string }> {
  const script = `${$.plugin.root}/../../hooks/ledger-list.sh`
  const cwd = await $.session.cwd()
  let result: ProcessRunResult
  try {
    result = await $.process.run(['bash', script, 'paths'], { cwd })
  } catch (error) {
    return { error: `${script} did not run: ${error instanceof Error ? error.message : String(error)}` }
  }
  const { exitCode, stdout, stderr } = result
  if (exitCode !== 0) return { error: `${script} failed (exit ${exitCode}): ${stderr.trim()}` }
  const found = await Promise.all(
    ledgerPaths(stdout).map(async path => ({ path, slug: folderSlug(path), mtimeMs: (await $.fs.stat(path)).mtimeMs })),
  )
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
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
}
