import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { REPO } from './helpers.js';

const DERIVED_DATA_GATE = path.join(REPO, 'hooks/derived-data-gate.sh');
const CC_DD_PATH = path.join(REPO, 'bin/cc-dd-path');

function environment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: root,
    GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(root),
  };
}

function run(root: string, cwd: string, command: string, args: string[], input?: string) {
  return spawnSync(command, args, { cwd, env: environment(root), input, encoding: 'utf8' });
}

function repository(root: string, name: string): { dir: string; buildFolder: string } {
  const dir = path.join(root, name);
  mkdirSync(dir);
  assert.equal(run(root, dir, 'git', ['init', '--quiet']).status, 0);
  const result = run(root, dir, 'bash', [CC_DD_PATH, 'Debug-sim']);
  assert.equal(result.status, 0, result.stderr);
  return { dir, buildFolder: result.stdout.trim() };
}

/** A session repository and a separate app repository, both inside one temp HOME. */
function repositories(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ledger-derived-data-gate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, '.gitconfig'), '');
  return { root, session: repository(root, 'session'), app: repository(root, 'app') };
}

function gate(root: string, cwd: string, command: string): string {
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
  const result = run(root, root, 'bash', [DERIVED_DATA_GATE], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function assertDenied(stdout: string): string {
  assert.notEqual(stdout, '', 'expected a deny decision, got silence');
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PreToolUse');
  assert.equal(output.permissionDecision, 'deny');
  return output.permissionDecisionReason;
}

function assertAllowed(stdout: string): void {
  assert.equal(stdout, '', `expected silence, got ${stdout}`);
}

test('the session build folder is allowed', (t) => {
  const { root, session } = repositories(t);
  assertAllowed(gate(root, session.dir, `xcodebuild -derivedDataPath ${session.buildFolder}`));
});

test('a build folder elsewhere is denied', (t) => {
  const { root, session } = repositories(t);
  assertDenied(gate(root, session.dir, 'xcodebuild -derivedDataPath /tmp/x'));
});

test('the app build folder is allowed when -workspace names the app', (t) => {
  const { root, session, app } = repositories(t);
  const workspace = path.join(app.dir, 'App.xcworkspace');
  assertAllowed(gate(root, session.dir, `xcodebuild -workspace ${workspace} -derivedDataPath ${app.buildFolder}`));
});

test('the app build folder is allowed when -project names the app', (t) => {
  const { root, session, app } = repositories(t);
  const project = path.join(app.dir, 'App.xcodeproj');
  assertAllowed(gate(root, session.dir, `xcodebuild -project ${project} -derivedDataPath ${app.buildFolder}`));
});

test('the app build folder is allowed after a leading cd into the app', (t) => {
  const { root, session, app } = repositories(t);
  const command = `cd ${app.dir} && xcodebuild -project App.xcodeproj -derivedDataPath ${app.buildFolder}`;
  assertAllowed(gate(root, session.dir, command));
});

test('the session build folder is denied when -workspace names the app', (t) => {
  const { root, session, app } = repositories(t);
  const workspace = path.join(app.dir, 'App.xcworkspace');
  assertDenied(gate(root, session.dir, `xcodebuild -workspace ${workspace} -derivedDataPath ${session.buildFolder}`));
});

test('a build folder in a shell variable is denied with the reason', (t) => {
  const { root, session } = repositories(t);
  const reason = assertDenied(gate(root, session.dir, 'xcodebuild -derivedDataPath $D'));
  assert.match(reason, /in full/);
  assert.match(reason, /shell variable/);
});

test('a command without -derivedDataPath is allowed', (t) => {
  const { root, session } = repositories(t);
  assertAllowed(gate(root, session.dir, 'xcodebuild -workspace /tmp/App.xcworkspace build'));
});

test('a build folder elsewhere is denied when -workspace names a shell variable', (t) => {
  const { root, session } = repositories(t);
  assertDenied(gate(root, session.dir, 'xcodebuild -workspace $APP/A.xcworkspace -derivedDataPath /tmp/x'));
});

test('a build folder elsewhere is denied when -workspace names a missing folder', (t) => {
  const { root, session } = repositories(t);
  assertDenied(gate(root, session.dir, 'xcodebuild -workspace /nonexistent/A.xcworkspace -derivedDataPath /tmp/x'));
});

test('the app build folder is allowed when -workspace starts with ~', (t) => {
  const { root, session, app } = repositories(t);
  const command = `xcodebuild -workspace ~/app/App.xcworkspace -derivedDataPath ${app.buildFolder}`;
  assertAllowed(gate(root, session.dir, command));
});

test('the app build folder is allowed after a leading cd into a path that starts with ~', (t) => {
  const { root, session, app } = repositories(t);
  const command = `cd ~/app && xcodebuild -project App.xcodeproj -derivedDataPath ${app.buildFolder}`;
  assertAllowed(gate(root, session.dir, command));
});

test('the app build folder is allowed when a quoted -workspace path has a space', (t) => {
  const { root, session } = repositories(t);
  const app = repository(root, 'my app');
  const workspace = path.join(app.dir, 'App.xcworkspace');
  assertAllowed(gate(root, session.dir, `xcodebuild -workspace "${workspace}" -derivedDataPath "${app.buildFolder}"`));
  assertAllowed(gate(root, session.dir, `xcodebuild -workspace '${workspace}' -derivedDataPath '${app.buildFolder}'`));
});
