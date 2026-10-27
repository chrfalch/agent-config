// Shared by cc-ledgers and cc-ledger-parent, so both put an archive copy in the same repository.
'use strict';
const path = require('node:path');

// The first `- <name>:` value under ## Location that is not empty and not a template placeholder, which starts with `<`.
function locationField(text, name) {
  const lines = text.split('\n').map((line) => line.trimEnd());
  const start = lines.indexOf('## Location');
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const value = line.match(new RegExp(`^- ${name}:[ \\t]*(.*)$`))?.[1].trim();
    if (value && !value.startsWith('<')) return value;
  }
  return undefined;
}

// The main checkout of a worktree where cc-task-new puts one: <main>/.claude/worktrees/<folder>.
function mainOfWorktree(worktree) {
  const worktrees = path.dirname(worktree);
  const isTaskWorktree = path.basename(worktrees) === 'worktrees' && path.basename(path.dirname(worktrees)) === '.claude';
  return isTaskWorktree ? path.dirname(path.dirname(worktrees)) : undefined;
}

/** The main checkout an archive copy belongs to: the `- main:` line a backlog ledger keeps, else the folder of its task worktree. */
function archivedMain(text) {
  const main = locationField(text, 'main');
  if (main) return main;
  const worktree = locationField(text, 'worktree');
  return worktree && mainOfWorktree(worktree);
}

module.exports = { archivedMain };
