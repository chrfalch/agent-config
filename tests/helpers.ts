import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../', import.meta.url));

const PATH_WITHOUT_STUB = process.env.PATH ?? '';
const STUB_ROOT = mkdtempSync(path.join(tmpdir(), 'ledger-claude-stub-'));
process.on('exit', () => rmSync(STUB_ROOT, { recursive: true, force: true }));

// A fake `claude` that answers the two plugin list commands from per-HOME state, so a
// marketplace add or remove, plugin install or plugin uninstall changes what later lists report. The state lives
// outside HOME: --dry-run tests assert that HOME is byte-for-byte unchanged.
const CLAUDE_STUB = `#!${process.execPath}
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const home = (process.env.HOME ?? '').replace(/\\/+$/, '');
const state = path.join(${JSON.stringify(path.join(STUB_ROOT, 'state'))}, createHash('sha256').update(home).digest('hex'));
fs.mkdirSync(state, { recursive: true });
const args = process.argv.slice(2);
fs.appendFileSync(path.join(state, 'calls'), args.join(' ') + '\\n');
fs.appendFileSync(path.join(state, 'cwds'), process.cwd() + '\\n');

const read = (name) => fs.existsSync(path.join(state, name)) ? JSON.parse(fs.readFileSync(path.join(state, name), 'utf8')) : [];
const write = (name, value) => fs.writeFileSync(path.join(state, name), JSON.stringify(value, null, 2));
const fail = (message) => { console.error(message); process.exit(1); };
const failIfAsked = (step) => { if (fs.existsSync(path.join(state, 'fail-' + step))) fail('Error: stub ' + step + ' failed'); };
const [, sub, verb, target] = args;

const list = (name) => fs.existsSync(path.join(state, name)) ? fs.readFileSync(path.join(state, name), 'utf8') : '[]';

if (args.join(' ') === 'plugin marketplace list --json') console.log(list('marketplaces'));
else if (args.join(' ') === 'plugin list --json') console.log(list('plugins'));
else if (sub === 'marketplace' && verb === 'add' && target) {
  failIfAsked('add');
  const manifest = path.join(target, '.claude-plugin/marketplace.json');
  if (!fs.existsSync(manifest)) fail('Error: no marketplace at ' + manifest);
  const { name } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  write('marketplaces', [...read('marketplaces'), { name, source: 'directory', path: target, installLocation: target }]);
} else if (sub === 'marketplace' && verb === 'remove' && target) {
  failIfAsked('remove');
  const marketplaces = read('marketplaces');
  if (!marketplaces.some((entry) => entry.name === target)) fail('Error: marketplace ' + target + ' not found');
  write('marketplaces', marketplaces.filter((entry) => entry.name !== target));
} else if (sub === 'install' && verb) {
  failIfAsked('install');
  const [plugin, marketplace] = verb.split('@');
  if (!read('marketplaces').some((entry) => entry.name === marketplace)) fail('Error: marketplace ' + marketplace + ' not found');
  const now = new Date().toISOString();
  write('plugins', [...read('plugins'), { id: verb, version: '0.1.0', scope: 'user', enabled: true, installPath: path.join(home, '.claude/plugins/cache', marketplace, plugin, '0.1.0'), installedAt: now, lastUpdated: now }]);
} else if (sub === 'uninstall' && verb) {
  failIfAsked('uninstall');
  const scope = args[args.indexOf('--scope') + 1];
  const plugins = read('plugins');
  // A local or project uninstall acts on the project of the working directory.
  const inProject = (entry) => !entry.projectPath || (fs.existsSync(entry.projectPath) && fs.realpathSync(entry.projectPath) === fs.realpathSync(process.cwd()));
  const matches = (entry) => entry.id === verb && entry.scope === scope && inProject(entry);
  if (!plugins.some(matches)) fail('Error: plugin ' + verb + ' is not installed at scope ' + scope + ' in ' + process.cwd());
  write('plugins', plugins.filter((entry) => !matches(entry)));
} else fail('stub claude: unexpected arguments: ' + args.join(' '));
`;

mkdirSync(path.join(STUB_ROOT, 'bin'));
writeFileSync(path.join(STUB_ROOT, 'bin/claude'), CLAUDE_STUB, { mode: 0o755 });
// Set on process.env, not only in run(): tests that spawn bin/deploy themselves must never reach the real claude.
process.env.PATH = `${path.join(STUB_ROOT, 'bin')}${path.delimiter}${PATH_WITHOUT_STUB}`;

function stubState(home: string): string {
  return path.join(STUB_ROOT, 'state', createHash('sha256').update(home.replace(/\/+$/, '')).digest('hex'));
}

/** Every argv the stub claude received under this HOME, one string per call, oldest first. */
export function claudeCalls(home: string): string[] {
  const calls = path.join(stubState(home), 'calls');
  return existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [];
}

/** The working directory of each call in claudeCalls(), in the same order. */
export function claudeCwds(home: string): string[] {
  const cwds = path.join(stubState(home), 'cwds');
  return existsSync(cwds) ? readFileSync(cwds, 'utf8').split('\n').filter(Boolean) : [];
}

/** Sets what the stub claude prints for `plugin marketplace list --json` and `plugin list --json` under this HOME. */
export function claudeLists(home: string, lists: { marketplaces?: string; plugins?: string }): void {
  mkdirSync(stubState(home), { recursive: true });
  for (const [name, text] of Object.entries(lists)) writeFileSync(path.join(stubState(home), name), text);
}

/** The marketplace names and plugin ids the stub claude lists under this HOME. */
export function claudeState(home: string): { marketplaces: string[]; plugins: string[] } {
  const read = <T>(name: string): T[] => {
    const file = path.join(stubState(home), name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  };
  return {
    marketplaces: read<{ name: string }>('marketplaces').map(({ name }) => name),
    plugins: read<{ id: string }>('plugins').map(({ id }) => id),
  };
}

/** Makes the stub claude exit 1 with an error on stderr for every later `step` under this HOME. */
export function failClaude(home: string, step: 'add' | 'remove' | 'install' | 'uninstall'): void {
  mkdirSync(stubState(home), { recursive: true });
  writeFileSync(path.join(stubState(home), `fail-${step}`), '');
}

const PATH_WITHOUT_CLAUDE = PATH_WITHOUT_STUB.split(path.delimiter)
  .filter((directory) => directory && !existsSync(path.join(directory, 'claude')))
  .join(path.delimiter);

export function freshHome(t: TestContext, ownClaudeMd = false): string {
  const home = mkdtempSync(path.join(tmpdir(), 'ledger-test-'));
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
  return spawn(home, process.env.PATH ?? '', command, args);
}

/** Like run(), with no `claude` executable anywhere on PATH. */
export function runWithoutClaude(home: string, command: readonly [string, ...string[]], ...args: string[]) {
  return spawn(home, PATH_WITHOUT_CLAUDE, command, args);
}

function spawn(home: string, searchPath: string, command: readonly [string, ...string[]], args: string[]) {
  const [executable, ...prefix] = command;
  const result = spawnSync(executable, [...prefix, ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: home, PATH: searchPath, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}
