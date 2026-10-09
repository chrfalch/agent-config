import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { cancel, type CANCEL_SYMBOL, confirm, intro, isCancel, log, multiselect, note, outro, select } from '@clack/prompts';
import pc from 'picocolors';
import { ALL_AGENTS, CODEX_AGENTS, deploy, DeployError, MODELS, parseDeployArguments } from './deploy.js';

const COMPONENTS = [
  { value: 'codex', label: 'Codex', flag: '--no-codex' },
  { value: 'argent', label: 'Argent UI automation', flag: '--no-argent' },
  { value: 'stacks', label: 'Stacked-PR rule', flag: '--no-stacks' },
  { value: 'githooks', label: 'Git hook guard', flag: '--no-githooks' },
  { value: 'mods', label: 'Ledger mod (/ledger)', flag: '--no-mods' },
] as const;
const ALL_MODELS = MODELS.split(',');

type Component = (typeof COMPONENTS)[number]['value'];
export type Components = Record<Component, boolean>;

export type Answers =
  | { action: 'revert'; dryRun?: boolean }
  | { action: 'deploy'; components: Components; agents: string[]; models: string[]; force?: boolean; dryRun?: boolean };

export interface Environment {
  codex: boolean;
  argent: boolean;
  stacks: boolean;
  claude: boolean;
  hooksPath: string;
}

class Cancelled extends Error {}

function impliedAgents(components: Components): string[] {
  return ALL_AGENTS.filter((agent) => (components.codex || !CODEX_AGENTS.includes(agent)) && (components.argent || agent !== 'ui-runner'));
}

function inOrder(source: string[], selected: string[]): string[] {
  return source.filter((item) => selected.includes(item));
}

export function answersToArgs(answers: Answers): string[] {
  const args: string[] = [];
  if (answers.action === 'revert') args.push('--revert');
  else {
    for (const { value, flag } of COMPONENTS) if (!answers.components[value]) args.push(flag);
    const agents = inOrder(ALL_AGENTS, answers.agents);
    if (agents.join(',') !== impliedAgents(answers.components).join(',')) args.push('--agents', agents.join(','));
    const models = inOrder(ALL_MODELS, answers.models);
    if (models.length !== ALL_MODELS.length) args.push('--models', models.join(','));
    if (answers.force) args.push('--force');
  }
  if (answers.dryRun) args.push('--dry-run');
  return args;
}

function output(program: string, args: string[]): string | undefined {
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function detectEnvironment(): Environment {
  return {
    codex: existsSync(path.join(homedir(), '.codex/config.toml')),
    argent: output('sh', ['-c', 'command -v argent']) !== undefined,
    stacks: output('gh', ['extension', 'list'])?.includes('stack') ?? false,
    claude: output('sh', ['-c', 'command -v claude']) !== undefined,
    hooksPath: output('git', ['config', '--global', 'core.hooksPath']) ?? '',
  };
}

async function ask<T>(prompt: Promise<T | typeof CANCEL_SYMBOL>): Promise<T> {
  const answer = await prompt;
  if (isCancel(answer)) throw new Cancelled();
  return answer;
}

function colour(line: string): string {
  const word = line.split(' ')[0];
  if (word === 'link') return pc.green(line);
  if (word === 'relink') return pc.yellow(line);
  if (word === 'REPLACE' || word === 'remove' || word === 'removed') return pc.red(line);
  return line.startsWith('DRY RUN') ? pc.dim(line) : line;
}

// Errors are reported here so runWizard can still close the prompt frame.
function runDeploy(args: string[]): number {
  try {
    return deploy(parseDeployArguments(args).options);
  } catch (error) {
    if (error instanceof Error && error.message) log.error(error.message);
    return error instanceof DeployError ? error.status : 1;
  }
}

// Lines are coloured as they arrive, not after the run: apply-policy is a child process
// that writes straight to stdout, and buffering ours would print the two out of order.
function preview(args: string[]): { status: number; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...data: unknown[]) => {
    for (const line of format(...data).split('\n')) {
      lines.push(line);
      original(colour(line));
    }
  };
  try {
    return { status: runDeploy(args), lines };
  } finally {
    console.log = original;
  }
}

function sameAs(args: string[]): void {
  log.info(`same as: ${['bin/deploy', ...args].join(' ')}`);
}

// git expands a leading ~ in core.hooksPath, so ~/x and $HOME/x/ name the same directory.
// A relative core.hooksPath names a different directory in each repository, so it has no
// single location to compare.
function resolveHome(file: string): string | undefined {
  const expanded = file.replace(/^~(?=\/|$)/, homedir());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
}

export function detectedComponents(env: Environment): Components {
  const guardDir = path.resolve(homedir(), '.config/git/hooks');
  return {
    codex: env.codex,
    argent: env.argent,
    stacks: env.stacks,
    githooks: !env.hooksPath || resolveHome(env.hooksPath) === guardDir,
    mods: env.claude,
  };
}

async function askDeployAnswers(env: Environment): Promise<Answers> {
  const found = detectedComponents(env);
  const missing: Record<Component, string> = {
    codex: 'no ~/.codex/config.toml',
    argent: 'argent is not on PATH',
    stacks: 'gh stack extension not installed',
    githooks: `core.hooksPath is ${env.hooksPath}`,
    mods: 'no claude CLI on PATH',
  };
  const selected = await ask(multiselect<Component>({
    message: 'Which components should deploy install?',
    options: COMPONENTS.map(({ value, label }) => ({ value, label, hint: found[value] ? undefined : missing[value] })),
    initialValues: COMPONENTS.map(({ value }) => value).filter((value) => found[value]),
    required: false,
  }));
  const components: Components = { codex: false, argent: false, stacks: false, githooks: false, mods: false };
  for (const value of selected) components[value] = true;
  const agents = await ask(multiselect<string>({
    message: 'Which agents?',
    options: ALL_AGENTS.map((value) => ({ value })),
    initialValues: impliedAgents(components),
    required: true,
  }));
  const models = await ask(multiselect<string>({
    message: 'Which models should the routing rules keep?',
    options: ALL_MODELS.map((value) => ({ value })),
    initialValues: ALL_MODELS,
    required: true,
  }));
  return { action: 'deploy', components, agents, models };
}

async function confirmApply(answers: Answers, lines: string[]): Promise<Answers> {
  if (!lines.some((line) => line.startsWith('REPLACE'))) {
    if (!(await ask(confirm({ message: 'Apply these changes?' })))) throw new Cancelled();
    return answers;
  }
  const choice = await ask(select<'force' | 'ask' | 'cancel'>({
    message: 'Some files in the way are your own. What should deploy do with them?',
    options: [
      { value: 'force', label: 'Back up and replace all' },
      { value: 'ask', label: 'Ask for each file' },
      { value: 'cancel', label: 'Cancel' },
    ],
  }));
  if (choice === 'cancel') throw new Cancelled();
  return choice === 'force' && answers.action === 'deploy' ? { ...answers, force: true } : answers;
}

function describe(env: Environment): string {
  return [
    `~/.codex/config.toml  ${env.codex ? 'found' : 'not found'}`,
    `argent                ${env.argent ? 'on PATH' : 'not on PATH'}`,
    `gh stack              ${env.stacks ? 'installed' : 'not installed'}`,
    `claude                ${env.claude ? 'on PATH' : 'not on PATH'}`,
    `core.hooksPath        ${env.hooksPath || 'not set'}`,
  ].join('\n');
}

export async function runWizard(): Promise<number> {
  try {
    intro('agent-config');
    const action = await ask(select<'deploy' | 'revert'>({
      message: 'What do you want to do?',
      options: [
        { value: 'deploy', label: 'Deploy' },
        { value: 'revert', label: 'Revert the last deploy' },
      ],
    }));
    const env = detectEnvironment();
    note(describe(env), 'Found on this machine');
    const answers: Answers = action === 'revert' ? { action } : await askDeployAnswers(env);

    log.step('Preview');
    const args = answersToArgs(answers);
    const { status, lines } = preview(answersToArgs({ ...answers, dryRun: true }));
    if (status !== 0) {
      cancel('The preview failed. Nothing was written.');
      return status;
    }
    sameAs(args);

    const final = answersToArgs(await confirmApply(answers, lines));
    if (final.join(' ') !== args.join(' ')) sameAs(final);
    const applied = runDeploy(final);
    outro(applied === 0 ? 'Done.' : `Deploy exited with status ${applied}.`);
    return applied;
  } catch (error) {
    // runDeploy catches its own errors, so anything that lands here came before the apply.
    cancel('Nothing was written.');
    if (error instanceof Cancelled) return 1;
    throw error;
  }
}
