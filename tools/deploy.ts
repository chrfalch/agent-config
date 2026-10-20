import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRules } from './build-rules.js';
import { isMain } from './cli.js';

// bin/deploy passes the path it was called through; import.meta.url is the realpath, and
// link targets and the CLAUDE.md retirement check must use the caller's path.
const REPO = process.env.DEPLOY_REPO || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ALL_AGENTS = ['researcher', 'runner', 'ui-runner', 'opus-implementer', 'sol-implementer', 'astra-implementer', 'astra-reviewer', 'reviewer'];
export const CODEX_AGENTS = ['sol-implementer', 'astra-implementer', 'astra-reviewer'];
export const MODELS = 'gpt-6-luna,haiku-5.5,gpt-6.1-sol,sonnet-5.5,opus-5.5,gpt-6-astra,fable-5';
const HOOKS = ['commit-msg', 'prepare-commit-msg', 'pre-commit', 'pre-merge-commit', 'pre-push', 'pre-rebase', 'post-checkout', 'post-merge', 'post-commit', 'post-rewrite'];

export interface DeployOptions {
  dry?: boolean;
  force?: boolean;
  revert?: boolean;
  noArgent?: boolean;
  noStacks?: boolean;
  noGithooks?: boolean;
  noCodex?: boolean;
  noMods?: boolean;
  codex?: boolean;
  agents?: string;
  models?: string;
}

export class DeployError extends Error {
  constructor(message: string, readonly status = 1) { super(message); }
}

export function parseDeployArguments(argv: string[]): { options: DeployOptions; help: boolean } {
  const opts: DeployOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    switch (arg) {
      case '--dry-run': opts.dry = true; break;
      case '--force': opts.force = true; break;
      case '--revert': opts.revert = true; break;
      case '--no-argent': opts.noArgent = true; break;
      case '--no-stacks': opts.noStacks = true; break;
      case '--no-githooks': opts.noGithooks = true; break;
      case '--no-codex': opts.noCodex = true; break;
      case '--no-mods': opts.noMods = true; break;
      case '--codex': opts.codex = true; break;
      case '--agents':
      case '--models': {
        const value = argv[++index];
        if (!value) throw new DeployError(`${arg} needs a comma-separated list`);
        opts[arg === '--agents' ? 'agents' : 'models'] = value;
        break;
      }
      case '-h':
      case '--help': return { options: opts, help: true };
      default:
        if (arg.startsWith('--agents=')) opts.agents = arg.slice('--agents='.length);
        else if (arg.startsWith('--models=')) opts.models = arg.slice('--models='.length);
        else throw new DeployError(`unknown flag: ${arg}   (try --help)`);
    }
  }
  return { options: opts, help: false };
}

function command(program: string, args: string[], allowFailure = false): string {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new DeployError(result.error?.message ?? '', result.status ?? 1);
  }
  return (result.stdout ?? '').replace(/\n+$/, '');
}

const MARKETPLACE = 'agent-config';
const MODS = ['ledger'];
// Mods an earlier deploy installed that now live inside another mod, each with the command that replaces it.
const RETIRED_MODS = { worktrees: '/ledger:worktrees' } as const;
const modId = (name: string): string => `${name}@${MARKETPLACE}`;
const MOD_COMMANDS = MODS.map((name) => `/${name}`).join(', ');

function runClaude(args: string[]): string {
  const result = spawnSync('claude', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error || result.status !== 0) {
    throw new DeployError(`deploy: claude ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result.stdout;
}

function claudeList<T>(args: string[]): T[] {
  const listArgs = [...args, 'list', '--json'];
  const stdout = runClaude(listArgs);
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list)) {
    throw new DeployError(`deploy: claude ${listArgs.join(' ')} printed something that is not a JSON list:\n${stdout.slice(0, 200)}`);
  }
  return list as T[];
}

function samePath(first: string, second: string): boolean {
  const real = (file: string): string => existsSync(file) ? realpathSync(file) : path.resolve(file);
  return real(first) === real(second);
}

const PAST = { add: 'added', install: 'installed', uninstall: 'uninstalled' } as const;

// Installed from this repo as a folder marketplace, so repo edits reach a session through
// /reload-plugins without a reinstall. --revert leaves both in place: they live in Claude
// Code's own plugin state, which deploy does not own.
function deployMods(opts: DeployOptions): void {
  if (opts.noMods) {
    console.log('mods     skipped (--no-mods)');
    return;
  }
  if (!command('sh', ['-c', 'command -v claude'], true)) {
    console.log('mods     skipped (no claude CLI on PATH)');
    return;
  }
  const change = (verb: keyof typeof PAST, args: string[], what: string): void => {
    if (opts.dry) {
      console.log(`mods     would ${verb} ${what}`);
      return;
    }
    runClaude([...args, '--scope', 'user']);
    console.log(`mods     ${PAST[verb]} ${what}`);
  };
  const marketplace = claudeList<{ name: string; path?: string; installLocation?: string }>(['plugin', 'marketplace'])
    .find(({ name }) => name === MARKETPLACE);
  const location = marketplace?.path ?? marketplace?.installLocation;
  if (!marketplace) change('add', ['plugin', 'marketplace', 'add', REPO], `marketplace ${MARKETPLACE} (this repo)`);
  else if (location && samePath(location, REPO)) console.log(`mods     marketplace ${MARKETPLACE} already added`);
  else {
    console.log(`mods     marketplace ${MARKETPLACE} points at ${location ?? 'an unknown source'}, not this repo; to fix: claude plugin marketplace remove ${MARKETPLACE}, then run deploy again`);
    console.log(`mods     skipped install of ${MODS.map(modId).join(', ')} until the marketplace points at this repo`);
    return;
  }
  const plugins = claudeList<{ id: string; scope?: string }>(['plugin']);
  for (const name of MODS) {
    const mod = modId(name);
    if (plugins.some(({ id }) => id === mod)) console.log(`mods     ${mod} already installed`);
    else change('install', ['plugin', 'install', mod], `${mod} (/${name})`);
  }
  for (const [name, replacement] of Object.entries(RETIRED_MODS)) {
    const mod = modId(name);
    // Deploy installs at user scope only; an install at another scope is the operator's own.
    if (plugins.some(({ id, scope }) => id === mod && scope === 'user')) {
      change('uninstall', ['plugin', 'uninstall', mod], `${mod} (now ${replacement})`);
    }
  }
}

function manifestLines(filename: string): string[] {
  if (!existsSync(filename) || !statSync(filename).isFile()) return [];
  return readFileSync(filename, 'utf8').split('\n').slice(0, -1).filter(Boolean);
}

function markdownFiles(directory: string): string[] {
  const names = readdirSync(directory).filter((name) => !name.startsWith('.') && name.endsWith('.md')).sort();
  return (names.length ? names : ['*.md']).map((name) => path.join(directory, name));
}

function readReply(): string {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch (error) {
    console.error(`deploy: /dev/tty: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
  try {
    const bytes: number[] = [];
    const byte = Buffer.alloc(1);
    while (readSync(fd, byte, 0, 1, null) > 0 && byte[0] !== 10) {
      if (byte[0] !== 0) bytes.push(byte[0]);
    }
    return Buffer.from(bytes).toString('utf8').replace(/^[ \t]+|[ \t]+$/g, '');
  } catch {
    return '';
  } finally {
    closeSync(fd);
  }
}

export function deploy(opts: DeployOptions): number {
  const home = homedir();
  const claude = path.join(home, '.claude');
  const rules = path.join(claude, 'rules');
  const manifest = path.join(claude, '.agent-config-manifest');
  const backup = path.join(claude, 'backups', `deploy-${command('date', ['+%Y-%m-%d-%H%M%S'])}`);
  const githooks = path.join(home, '.config/git/hooks');
  // path.join drops the slash a HOME like /x/ ends in, so match on HOME without it.
  const homePrefix = home.replace(/\/+$/, '');
  const short = (filename: string): string => filename.startsWith(homePrefix) ? `~${filename.slice(homePrefix.length)}` : filename;
  const note = (text: string): void => console.log(`${opts.dry ? 'would ' : ''}${text}`);
  const oldWrote = manifestLines(manifest);
  let agents: string[];
  if (opts.agents) {
    const firstLine = opts.agents.split('\n')[0];
    agents = firstLine === '' ? [] : firstLine.replace(/,$/, '').split(',');
    for (const agent of agents) {
      if (!ALL_AGENTS.includes(agent)) throw new DeployError(`unknown agent: ${agent}\nknown agents: ${ALL_AGENTS.join(' ')}`);
    }
  } else {
    agents = ALL_AGENTS.filter((agent) => !(opts.noCodex && CODEX_AGENTS.includes(agent)) && !(opts.noArgent && agent === 'ui-runner'));
  }
  if (opts.dry) console.log('DRY RUN -- nothing below is written.\n');

  if (opts.revert) {
    let found = 0;
    for (const filename of oldWrote) {
      if (!lstatSync(filename, { throwIfNoEntry: false })) continue;
      found++;
      if (!opts.dry) command('rm', ['-f', filename]);
      console.log(`${opts.dry ? 'remove  ' : 'removed '} ${short(filename)}`);
    }
    if (!opts.dry && existsSync(manifest) && statSync(manifest).isFile()) command('rm', ['-f', manifest]);
    if (!found) console.log('nothing from this repo is in place');
    if (command('git', ['config', '--global', 'core.hooksPath'], true) === githooks) {
      console.log(`hooks    core.hooksPath still points at ${short(githooks)}`);
      console.log('         revert does not unset it; it is global git config, not a file');
      console.log('         to undo it fully: git config --global --unset core.hooksPath');
    }
    console.log(`mods     revert leaves the mods installed (${MOD_COMMANDS}); they are Claude Code plugin state, not files`);
    console.log('         to remove them:');
    for (const name of MODS) console.log(`           claude plugin uninstall ${name}`);
    console.log(`           claude plugin marketplace remove ${MARKETPLACE}`);
    const backups = path.join(claude, 'backups');
    const newest = existsSync(backups) ? readdirSync(backups).filter((name) => name.startsWith('deploy-')).sort().at(-1) : undefined;
    if (!newest) console.log('no backup to restore');
    else {
      const source = path.join(backups, newest);
      console.log(`backup   ${short(source)}`);
      const files = command('find', [source, '-type', 'f'], true);
      for (const file of files ? files.split('\n') : []) {
        const target = path.join(home, path.relative(source, file));
        if (!opts.dry) {
          mkdirSync(path.dirname(target), { recursive: true });
          command('cp', ['-p', file, target]);
        }
        console.log(`${opts.dry ? 'restore ' : 'restored'} ${short(target)}`);
      }
      console.log('\nRestored each file as it was at that deploy. Later local edits to those');
      console.log(`files are gone. Older backups are still in ${short(backups)}.`);
    }
    if (opts.dry) console.log('\nDRY RUN -- nothing was written.');
    return 0;
  }

  const wrote: string[] = [];
  const link = (src: string, dst: string): void => {
    const label = short(dst);
    wrote.push(dst);
    const symlink = lstatSync(dst, { throwIfNoEntry: false })?.isSymbolicLink();
    const target = symlink ? readlinkSync(dst) : undefined;
    if (target === src) return;
    const ownedRule = dst.startsWith(`${rules}/`) && oldWrote.includes(dst);
    if (opts.dry) {
      if (symlink) console.log(`relink   ${label}   (now points at ${target})`);
      else if (existsSync(dst) && ownedRule) console.log(`relink   ${label}   (replaces a copy an earlier deploy generated)`);
      else if (existsSync(dst)) console.log(`REPLACE  ${label}   (a file of your own: deploy would ask, then back it up)`);
      else console.log(`link     ${label}`);
      return;
    }
    if (existsSync(dst) && !symlink) {
      if (ownedRule) command('rm', ['-f', dst]);
      else {
        if (!opts.force) {
          if (!process.stdin.isTTY) {
            throw new DeployError(`\n${label} is a file of your own, not a symlink.\nDeploy would back it up and replace it with a symlink into this repo.\nRun bin/deploy --dry-run to see every change, then --force to proceed.`);
          }
          process.stdout.write(`${label} is your own file. Back it up and replace it with a symlink? [y/N] `);
          if (!['y', 'Y', 'yes', 'YES'].includes(readReply())) {
            console.log(`skipped  ${label}`);
            return;
          }
        }
        const saved = path.join(backup, path.relative(home, dst));
        mkdirSync(path.dirname(saved), { recursive: true });
        command('cp', ['-p', dst, saved]);
      }
    }
    mkdirSync(path.dirname(dst), { recursive: true });
    command('ln', ['-sfn', src, dst]);
    console.log(`linked   ${label}`);
  };

  const old = path.join(claude, 'CLAUDE.md');
  if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(old).startsWith(`${REPO}/`)) {
    note(`retire   ${short(old)}   (the contract now ships as rules)`);
    if (!opts.dry) command('rm', [old]);
  }
  const filtered = opts.agents || opts.models || opts.noCodex || opts.noArgent || opts.noStacks;
  if (!filtered) {
    for (const file of markdownFiles(path.join(REPO, 'rules'))) link(file, path.join(rules, path.basename(file)));
  } else {
    // A separate output directory prevents older, wider selections from being redeployed.
    const out = mkdtempSync(path.join(tmpdir(), 'agent-config-rules-'));
    try {
      const features = [...agents, opts.models || MODELS];
      if (!opts.noCodex) features.push('codex');
      if (!opts.noArgent) features.push('argent');
      if (!opts.noStacks) features.push('gh-stack');
      const status = buildRules({ src: path.join(REPO, 'rules'), out, features: features.join(',') });
      if (status !== 0) return status;
      if (!opts.dry) mkdirSync(rules, { recursive: true });
      for (const file of markdownFiles(out)) {
        const dst = path.join(rules, path.basename(file));
        wrote.push(dst);
        if (!opts.dry) {
          // Generated files must replace symlinks without writing through into the repo.
          command('rm', ['-f', dst]);
          command('cp', [file, dst]);
        }
        console.log(`${opts.dry ? 'generate' : 'generated'} ${short(dst)}`);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    console.log('rules    generated, not linked: edits in the repo need another deploy');
  }
  link(path.join(REPO, 'ledger.template.md'), path.join(claude, 'ledger.template.md'));
  for (const hook of readdirSync(path.join(REPO, 'hooks')).filter((f) => f.endsWith('.sh')).sort()) link(path.join(REPO, 'hooks', hook), path.join(claude, 'hooks', hook));
  link(path.join(REPO, 'notes/model-routing-rationale.md'), path.join(claude, 'notes/model-routing-rationale.md'));
  for (const agent of agents) link(path.join(REPO, 'agents', `${agent}.md`), path.join(claude, 'agents', `${agent}.md`));

  if (!opts.noGithooks) {
    link(path.join(REPO, 'githooks/_chain'), path.join(githooks, '_chain'));
    for (const hook of HOOKS) link(path.join(githooks, '_chain'), path.join(githooks, hook));
    const current = command('git', ['config', '--global', 'core.hooksPath'], true);
    if (!current) {
      note(`set      core.hooksPath -> ${short(githooks)}`);
      if (!opts.dry) command('git', ['config', '--global', 'core.hooksPath', githooks]);
    } else if (current !== githooks) {
      console.log(`hooks    core.hooksPath is ${current} -- left alone, so the guard is not active`);
      console.log(`         to use it: git config --global core.hooksPath ${short(githooks)}`);
    }
  }
  const skipped = ALL_AGENTS.filter((agent) => !agents.includes(agent));
  if (skipped.length) console.log(`agents   not deployed: ${skipped.join(' ')}`);
  for (const filename of oldWrote) {
    if (filename.startsWith(`${rules}/`) && !wrote.includes(filename)) {
      if (!opts.dry) command('rm', ['-f', filename]);
      console.log(opts.dry ? `remove   ${short(filename)}   (no longer selected)` : `removed  ${short(filename)}`);
    }
  }
  if (!opts.dry) writeFileSync(manifest, `${wrote.join('\n')}\n`);
  // Policy parse failures must retain the standalone CLI's diagnostics and stack.
  const policyArgs = ['--backup-dir', backup];
  if (opts.dry) policyArgs.push('--dry-run');
  if (opts.noCodex) policyArgs.push('--no-codex');
  if (opts.codex) policyArgs.push('--codex');
  const policy = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'tools/apply-policy.ts'), ...policyArgs], { cwd: REPO, stdio: 'inherit' });
  if (policy.error) throw policy.error;
  const status = policy.status ?? 1;
  if (status !== 0) return status;
  deployMods(opts);
  if (opts.dry) console.log('\nDRY RUN -- nothing was written.');
  else if (existsSync(backup) && statSync(backup).isDirectory()) console.log(`backup   ${short(backup)}`);
  return 0;
}

export function shouldRunWizard(argv: string[], stdinTTY: boolean | undefined, stdoutTTY: boolean | undefined): boolean {
  return argv.length === 0 && Boolean(stdinTTY) && Boolean(stdoutTTY);
}

const HELP = `Deploy agent-config.

  bin/deploy                  link the owned files; apply policy; Codex if present
  bin/deploy --dry-run        print every change and write nothing
  bin/deploy --no-codex       skip Codex, and the three agents that drive it
  bin/deploy --codex          require Codex; fail if ~/.codex/config.toml is missing
  bin/deploy --no-argent      skip ui-runner and the UI automation rule
  bin/deploy --no-stacks      skip the stacked-PR rule (needs the gh stack extension)
  bin/deploy --no-githooks    skip the git hook guard; leave core.hooksPath alone
  bin/deploy --no-mods        skip the Claude Code mods (${MOD_COMMANDS})
  bin/deploy --agents a,b,c   deploy only these agents
  bin/deploy --models a,b     keep only these models in the routing rules
  bin/deploy --force          replace a file of your own without asking
  bin/deploy --revert         undo the last deploy

Run --dry-run first against a config you care about.

The contract ships as rule files in ~/.claude/rules/, which Claude Code loads
for every project. Your own ~/.claude/CLAUDE.md is never touched.

NOTE for Cowork users: a Cowork session on the desktop skips a symlinked
~/.claude/rules/ file that points outside the session's working directory, so
these rules do not load there. Claude Code in the terminal is unaffected.

Deploy also installs a chaining git hook dispatcher in ~/.config/git/hooks and
points core.hooksPath at it. Each hook strips AI attribution trailers from the
commit message, then hands over to the repository's own hook of the same name,
so nothing a project keeps in .git/hooks stops working. If core.hooksPath is
already set to something else, deploy leaves it alone and says so. --revert
removes the files but does not unset core.hooksPath.

Deploy does NOT own ~/.claude/settings.json or ~/.codex/config.toml. Those hold
local state the apps write: project trust levels, plugins, marketplaces, MCP
servers, your model choice. It merges a few policy keys and leaves the rest.
`;

/** Runs the command line: the wizard in a terminal when there are no arguments, deploy otherwise. Sets process.exitCode. */
export function main(argv: string[]): void {
  const fail = (error: unknown): void => {
    if (error instanceof Error && error.message) console.error(error.message);
    process.exitCode = error instanceof DeployError ? error.status : 1;
  };
  if (shouldRunWizard(argv, process.stdin.isTTY, process.stdout.isTTY)) {
    // Not awaited: wizard.ts imports this module, so a top-level await here deadlocks.
    // Loaded on demand so scripted runs never load the prompt library.
    import('./wizard.js').then(({ runWizard }) => runWizard()).then((status) => { process.exitCode = status; }, fail);
  } else {
    try {
      const { options, help } = parseDeployArguments(argv);
      if (help) process.stdout.write(HELP);
      else process.exitCode = deploy(options);
    } catch (error) {
      fail(error);
    }
  }
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
