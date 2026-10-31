import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { REPO } from './helpers.js';

const WRAPPERS = ['sol-implementer', 'astra-implementer', 'astra-reviewer', 'codex-runner'];

function splitAgent(agent: string): { tools: string[]; body: string } {
  const text = readFileSync(path.join(REPO, 'agents', `${agent}.md`), 'utf8');
  const [, frontmatter = '', body = ''] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text) ?? [];
  const tools = /^tools:(.*)$/m.exec(frontmatter)?.[1] ?? '';
  return { tools: tools.split(',').map((tool) => tool.trim()), body };
}

function rule(name: string): string {
  return readFileSync(path.join(REPO, 'rules', name), 'utf8');
}

for (const agent of WRAPPERS) {
  test(`Codex wrapper ${agent} waits on a done-file with Monitor`, () => {
    assert.ok(existsSync(path.join(REPO, 'agents', `${agent}.md`)), `agents/${agent}.md exists`);
    const { tools, body } = splitAgent(agent);
    assert.ok(tools.includes('Monitor'), `tools include Monitor: ${JSON.stringify(tools)}`);
    assert.ok(!/background and poll/i.test(body), 'the body does not say "background and poll"');
    assert.ok(body.includes('done-file'), 'the body names the done-file');
  });

  test(`Codex wrapper ${agent} creates the done-file only when Codex ends`, () => {
    const wait = /\*\*Wait for Codex to end\.\*\*[\s\S]*?(?=\n\d+\. \*\*|$)/.exec(splitAgent(agent).body)?.[0] ?? '';
    assert.ok(wait, 'the body has a "Wait for Codex to end" step');
    assert.match(wait, /`mktemp -d`/);
    assert.match(wait, /\bdo not create the done-file\b/i);
    assert.doesNotMatch(wait, /\b(make|create)\b[^.`]*\ba done-file\b/i, 'no step makes the done-file before the run');
    assert.match(wait, /`<codex command> [^`]*;\s*touch <done-file>`/);
    assert.match(wait, /`until \[ -f <done-file> \]; do sleep \d+; done`/);
    assert.match(wait, /\b30 minutes\b/);
    assert.match(wait, /\bdefault is 5 minutes\b/);
    assert.match(wait, /\barm it again\b/i);
    assert.match(wait, /\bnon-zero\b/);
    assert.match(wait, /\boutput file is empty\b/);
    assert.match(wait, /\bnever return while Codex runs\b/i);
    assert.match(wait, /`timeout_ms: 1800000`/);
    assert.ok(!wait.includes('explicit `timeout`'), 'a background Bash command takes no timeout');
    assert.ok(!wait.includes('stopped Codex at the timeout'), 'Bash does not stop a background command at a timeout');
    const largeNumbers = (wait.match(/\d+/g) ?? []).map(Number).filter((n) => n > 600000 && n !== 1800000);
    assert.deepEqual(largeNumbers, [], 'no deadline above 600000 ms other than Monitor\'s maximum');
  });
}

test('the routing rule sends Codex work to a wrapper, not to codex exec', () => {
  assert.ok(!rule('40-model-routing.md').includes('codex exec'), 'rules/40-model-routing.md does not run codex exec');
});

test('the orchestrator never runs the Codex CLI itself', () => {
  assert.ok(
    rule('60-subagent-mechanics.md').includes('never runs `codex exec` or `codex review` itself'),
    'rules/60-subagent-mechanics.md says the orchestrator never runs codex exec or codex review itself',
  );
});
