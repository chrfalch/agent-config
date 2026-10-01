import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ALL_AGENTS, CODEX_AGENTS, MODELS, parseDeployArguments, shouldRunWizard } from '../tools/deploy.js';
import { answersToArgs, detectedComponents, detectEnvironment, type Components } from '../tools/wizard.js';

const allModels = MODELS.split(',');
const allOn: Components = { codex: true, argent: true, stacks: true, githooks: true };

function deployAnswers(components: Partial<Components> = {}, agents?: string[], models = allModels) {
  const selected = { ...allOn, ...components };
  const implied = ALL_AGENTS.filter((agent) => !(!selected.codex && CODEX_AGENTS.includes(agent)) && !(!selected.argent && agent === 'ui-runner'));
  return { action: 'deploy' as const, components: selected, agents: agents ?? implied, models };
}

test('wizard runs only with no arguments and a terminal on both stdin and stdout', () => {
  assert.equal(shouldRunWizard([], true, true), true);
  assert.equal(shouldRunWizard([], false, true), false);
  assert.equal(shouldRunWizard([], true, false), false);
  assert.equal(shouldRunWizard([], undefined, undefined), false);
  assert.equal(shouldRunWizard(['--dry-run'], true, true), false);
});

test('default deploy answers map to no flags', () => {
  assert.deepEqual(answersToArgs(deployAnswers()), []);
});

test('each component turned off maps to its --no flag', () => {
  assert.deepEqual(answersToArgs(deployAnswers({ codex: false })), ['--no-codex']);
  assert.deepEqual(answersToArgs(deployAnswers({ argent: false })), ['--no-argent']);
  assert.deepEqual(answersToArgs(deployAnswers({ stacks: false })), ['--no-stacks']);
  assert.deepEqual(answersToArgs(deployAnswers({ githooks: false })), ['--no-githooks']);
  assert.deepEqual(
    answersToArgs(deployAnswers({ codex: false, argent: false, stacks: false, githooks: false })),
    ['--no-codex', '--no-argent', '--no-stacks', '--no-githooks'],
  );
});

test('--agents appears only when the selection differs from the set the flags imply', () => {
  assert.deepEqual(answersToArgs(deployAnswers({}, [...ALL_AGENTS])), []);
  assert.deepEqual(
    answersToArgs(deployAnswers({ codex: false }, [...ALL_AGENTS])),
    ['--no-codex', '--agents', ALL_AGENTS.join(',')],
  );
  assert.deepEqual(
    answersToArgs(deployAnswers({ argent: false }, [...ALL_AGENTS])),
    ['--no-argent', '--agents', ALL_AGENTS.join(',')],
  );
});

test('--agents and --models keep the order of the source lists', () => {
  assert.deepEqual(answersToArgs(deployAnswers({}, ['reviewer', 'runner', 'researcher'])), ['--agents', 'researcher,runner,reviewer']);
  assert.deepEqual(
    answersToArgs(deployAnswers({}, undefined, ['opus-5.5', 'gpt-6-luna'])),
    ['--models', 'gpt-6-luna,opus-5.5'],
  );
});

test('force and the preview add --force and --dry-run', () => {
  assert.deepEqual(answersToArgs({ ...deployAnswers(), force: true }), ['--force']);
  assert.deepEqual(answersToArgs({ ...deployAnswers(), dryRun: true }), ['--dry-run']);
  assert.deepEqual(
    answersToArgs({ ...deployAnswers({ stacks: false }, ['runner']), dryRun: true }),
    ['--no-stacks', '--agents', 'runner', '--dry-run'],
  );
});

test('revert maps to --revert, plus --dry-run for the preview', () => {
  assert.deepEqual(answersToArgs({ action: 'revert' }), ['--revert']);
  assert.deepEqual(answersToArgs({ action: 'revert', dryRun: true }), ['--revert', '--dry-run']);
});

test('every component combination parses and never requires Codex', () => {
  for (let mask = 0; mask < 16; mask++) {
    const args = answersToArgs(deployAnswers({ codex: !(mask & 1), argent: !(mask & 2), stacks: !(mask & 4), githooks: !(mask & 8) }));
    assert.ok(!args.includes('--codex'), args.join(' '));
    assert.ok(!args.includes('--agents'), args.join(' '));
    assert.doesNotThrow(() => parseDeployArguments(args));
  }
});

test('environment detection reports nothing found instead of throwing', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-config-wizard-'));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  t.after(() => {
    Object.assign(process.env, saved);
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.PATH = '';
  assert.deepEqual(detectEnvironment(), { codex: false, argent: false, stacks: false, hooksPath: '' });

  mkdirSync(path.join(home, '.codex'));
  writeFileSync(path.join(home, '.codex/config.toml'), '');
  assert.equal(detectEnvironment().codex, true);
});

test('the git hook guard counts as detected when core.hooksPath names its directory in any spelling', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'agent-config-wizard-'));
  const saved = process.env.HOME;
  t.after(() => {
    process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  const guard = (hooksPath: string) => detectedComponents({ codex: false, argent: false, stacks: false, hooksPath }).githooks;

  assert.equal(guard(''), true);
  assert.equal(guard(path.join(home, '.config/git/hooks')), true);
  assert.equal(guard(path.join(home, '.config/git/hooks/')), true);
  assert.equal(guard('~/.config/git/hooks'), true);
  assert.equal(guard('~/.config/git/hooks/'), true);
  assert.equal(guard(path.join(home, '.config/git/../git/hooks')), true);
  assert.equal(guard('~/.config/git'), false);
  assert.equal(guard('/elsewhere/hooks'), false);
  assert.equal(guard('.githooks'), false);
});

test('a relative core.hooksPath never counts as the guard, even from the home directory', (t) => {
  // realpath, because a tmpdir under /var reads back from process.cwd() as /private/var.
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'agent-config-wizard-')));
  const saved = { HOME: process.env.HOME, cwd: process.cwd() };
  t.after(() => {
    process.chdir(saved.cwd);
    process.env.HOME = saved.HOME;
    rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.chdir(home);
  const guard = (hooksPath: string) => detectedComponents({ codex: false, argent: false, stacks: false, hooksPath }).githooks;

  assert.equal(guard('.config/git/hooks'), false);
  assert.equal(guard('./.config/git/hooks/'), false);
});

test('detected components pass the other findings through', () => {
  assert.deepEqual(
    detectedComponents({ codex: true, argent: false, stacks: true, hooksPath: '/elsewhere/hooks' }),
    { codex: true, argent: false, stacks: true, githooks: false },
  );
});
