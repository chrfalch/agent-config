// Proves foreign hooks and local keys survive, policy keys apply, repeat runs
// change nothing, and absent settings are created from the policy alone.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
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
  const hooks = out.hooks;
  assert.ok(typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks));
  assert.ok('PreToolUse' in hooks, 'FOREIGN HOOK LOST');
  assert.deepEqual(hooks.PreToolUse, LIVE.hooks.PreToolUse, 'FOREIGN HOOK ALTERED');
  assert.ok('SessionStart' in hooks);
  assert.notDeepEqual(hooks.SessionStart, LIVE.hooks.SessionStart, 'SessionStart not applied');
  assert.ok('PreCompact' in hooks, 'PreCompact not added');
  assert.equal(out.model, 'sonnet', 'local model lost');
  assert.deepEqual(out.permissions, LIVE.permissions, 'local permissions lost');
  assert.equal(out.tui, 'fullscreen', 'tui not applied');
  assert.ok(existsSync(path.join(home, 'backup/.claude/settings.json')), 'no backup written');
  assert.ok(policyReport(result.stdout).kept.includes('hooks.PreToolUse'), 'foreign hook not reported as kept');
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
