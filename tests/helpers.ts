import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../', import.meta.url));

export function freshHome(t: TestContext, ownClaudeMd = false): string {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-config-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, '.claude'));
  writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'sonnet' }, null, 2));
  if (ownClaudeMd) {
    writeFileSync(path.join(home, '.claude/CLAUDE.md'), 'MY OWN CONTRACT\n');
  }
  return home;
}

export function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const entry = path.join(directory, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) entries[path.relative(root, entry)] = `link ${readlinkSync(entry)}`;
      else if (stat.isDirectory()) {
        entries[path.relative(root, entry)] = 'dir';
        visit(entry);
      } else entries[path.relative(root, entry)] = `file ${createHash('sha256').update(readFileSync(entry)).digest('hex')}`;
    }
  };
  visit(root);
  return entries;
}

export function run(home: string, command: readonly [string, ...string[]], ...args: string[]) {
  const [executable, ...prefix] = command;
  const result = spawnSync(executable, [...prefix, ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}
