// Proves foreign hooks and local keys survive, policy keys apply, repeat runs
// change nothing, and absent settings are created from the policy alone.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

const APPLY_POLICY = [process.execPath, '--import', 'tsx', 'tools/apply-policy.ts'] as const;
const POLICY = path.join(REPO, 'settings.policy.json');
const LIVE = {
  model: 'sonnet',
  permissions: { allow: ['mcp__argent'] },
  tui: 'compact',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo stale' }] }],
  },
};

function readSettings(target: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(target, 'utf8'));
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function hookEntries(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks;
  assert.ok(typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks), 'hooks missing');
  const entries: unknown = (hooks as Record<string, unknown>)[event];
  assert.ok(Array.isArray(entries), `hooks.${event} missing`);
  return entries;
}

function policyReport(stdout: string): { changed: string[]; kept: string[] } {
  const applied = /^claude   policy keys applied: (.+)$/m.exec(stdout);
  assert.ok(applied, `Missing Claude policy report: ${stdout}`);
  const kept = /^         left alone: (.+)$/m.exec(stdout);
  return {
    changed: applied[1] === 'already current' ? [] : applied[1].split(', '),
    kept: kept ? kept[1].split(', ') : [],
  };
}

test('policy merge preserves foreign hooks and local keys while applying owned keys', (t) => {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, JSON.stringify(LIVE, null, 2));
  const result = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup'), '--no-codex');
  assert.equal(result.status, 0, result.stderr);
  const out = readSettings(target);
  const policy = readSettings(POLICY);
  assert.deepEqual(
    hookEntries(out, 'PreToolUse'),
    [...LIVE.hooks.PreToolUse, ...hookEntries(policy, 'PreToolUse')],
    'FOREIGN HOOK LOST OR ALTERED',
  );
  assert.deepEqual(hookEntries(out, 'SessionStart'), hookEntries(policy, 'SessionStart'), 'SessionStart not applied');
  assert.deepEqual(hookEntries(out, 'PreCompact'), hookEntries(policy, 'PreCompact'), 'PreCompact not added');
  assert.equal(out.model, 'sonnet', 'local model lost');
  assert.deepEqual(out.permissions, LIVE.permissions, 'local permissions lost');
  assert.equal(out.tui, 'fullscreen', 'tui not applied');
  assert.ok(existsSync(path.join(home, 'backup/.claude/settings.json')), 'no backup written');
  assert.ok(policyReport(result.stdout).changed.includes('hooks.PreToolUse'), 'owned gates not reported as applied');
});

function applyToHooks(t: TestContext, hooks: Record<string, unknown[]>): Record<string, unknown> {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, JSON.stringify({ hooks }, null, 2));
  const result = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup'), '--no-codex');
  assert.equal(result.status, 0, result.stderr);
  return readSettings(target);
}

const GATE = '"$HOME"/.claude/hooks/derived-data-gate.sh';
const RETRY = '"$HOME"/.claude/hooks/denied-read-retry.sh';

test('a group that mixes an owned command with a prompt hook is yours and survives unchanged', (t) => {
  const mixed = {
    matcher: 'Bash',
    hooks: [{ type: 'command', command: GATE }, { type: 'prompt', prompt: 'Is this command safe?' }],
  };
  const out = applyToHooks(t, { PreToolUse: [mixed] });
  const policy = readSettings(POLICY);
  assert.deepEqual(hookEntries(out, 'PreToolUse'), [mixed, ...hookEntries(policy, 'PreToolUse')]);
});

test('an owned command under your own matcher survives unchanged', (t) => {
  const ownMatcher = { matcher: 'Bash|Edit', hooks: [{ type: 'command', command: GATE }] };
  const out = applyToHooks(t, { PreToolUse: [ownMatcher] });
  const policy = readSettings(POLICY);
  assert.deepEqual(hookEntries(out, 'PreToolUse'), [ownMatcher, ...hookEntries(policy, 'PreToolUse')]);
});

test('foreign entries keep their order and owned entries follow them', (t) => {
  const policy = readSettings(POLICY);
  const foreignPreToolUse = [
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo first' }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: GATE }, { type: 'command', command: 'echo mine' }] },
    { hooks: [{ type: 'command', command: 'echo third' }] },
  ];
  const foreignPermissionDenied = [
    { matcher: 'Read', hooks: [{ type: 'command', command: RETRY }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo denied' }] },
  ];
  const out = applyToHooks(t, {
    PreToolUse: [foreignPreToolUse[0]!, ...hookEntries(policy, 'PreToolUse'), ...foreignPreToolUse.slice(1)],
    PermissionDenied: foreignPermissionDenied,
  });
  assert.deepEqual(hookEntries(out, 'PreToolUse'), [...foreignPreToolUse, ...hookEntries(policy, 'PreToolUse')]);
  assert.deepEqual(hookEntries(out, 'PermissionDenied'), [
    ...foreignPermissionDenied,
    ...hookEntries(policy, 'PermissionDenied'),
  ]);
});

test('an owned hook entry from an earlier deploy is replaced, not duplicated', (t) => {
  const foreignDenied = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo denied' }] };
  const ada53e6Gate = { matcher: 'Bash', hooks: [{ type: 'command', command: GATE }] };
  const out = applyToHooks(t, { PreToolUse: [ada53e6Gate], PermissionDenied: [foreignDenied] });
  const policy = readSettings(POLICY);
  assert.deepEqual(hookEntries(out, 'PreToolUse'), hookEntries(policy, 'PreToolUse'), 'earlier owned gate kept');
  assert.deepEqual(
    hookEntries(out, 'PermissionDenied'),
    [foreignDenied, ...hookEntries(policy, 'PermissionDenied')],
    'FOREIGN HOOK LOST OR ALTERED',
  );
});

test('applying policy a second time reports no changes', (t) => {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, JSON.stringify(LIVE, null, 2));
  const first = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup'), '--no-codex');
  assert.equal(first.status, 0, first.stderr);
  const before = readFileSync(target, 'utf8');
  const second = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup2'), '--no-codex');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(policyReport(second.stdout).changed, [], 'second run not idempotent');
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('absent settings are created from policy with all keys changed and none kept', (t) => {
  const home = freshHome(t);
  const target = path.join(home, '.claude/settings.json');
  unlinkSync(target);
  const result = run(home, APPLY_POLICY, '--backup-dir', path.join(home, 'backup3'), '--no-codex');
  assert.equal(result.status, 0, result.stderr);
  const report = policyReport(result.stdout);
  const policy = readSettings(POLICY);
  assert.deepEqual(report.changed.sort(), Object.keys(policy).sort());
  assert.deepEqual(report.kept, []);
  assert.deepEqual(readSettings(target), policy);
});
