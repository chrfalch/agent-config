import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { buildRules } from '../tools/build-rules.js';
import { ALL_AGENTS, CODEX_AGENTS, MODELS } from '../tools/deploy.js';
import { REPO } from './helpers.js';

const GATED_RULES = ['40-model-routing.md', '50-fleet-reference.md', '60-subagent-mechanics.md'];

// Mirrors the feature list deploy() passes to buildRules for a filtered deploy.
function deployFeatures({ agents, noCodex = false }: { agents?: string[]; noCodex?: boolean }): string[] {
  const deployed = agents ?? ALL_AGENTS.filter((agent) => !(noCodex && CODEX_AGENTS.includes(agent)));
  return [...deployed, MODELS, ...(noCodex ? [] : ['codex']), 'argent', 'gh-stack'];
}

const SELECTIONS: [string, string[]][] = [
  ['features codex,codex-runner,gpt-6.1-sol', ['codex', 'codex-runner', 'gpt-6.1-sol']],
  ['--no-codex', deployFeatures({ noCodex: true })],
  ...ALL_AGENTS.map((agent): [string, string[]] => [`--agents ${agent}`, deployFeatures({ agents: [agent] })]),
];

function render(t: TestContext, features: string[]): Map<string, string> {
  const out = mkdtempSync(path.join(tmpdir(), 'ledger-rules-gates-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  assert.equal(buildRules({ src: path.join(REPO, 'rules'), out, features: features.join(',') }), 0);
  return new Map(GATED_RULES.map((name) => [name, readFileSync(path.join(out, name), 'utf8')]));
}

function namedAgents(text: string): string[] {
  return ALL_AGENTS.filter((agent) => new RegExp(`(?<![\\w-])${agent}(?![\\w-])`, 'i').test(text));
}

function listHeadersWithoutItems(text: string): string[] {
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.filter((line, index) => line.trimEnd().endsWith(':') && !/^\s*([-*|]|\d+\.)\s/.test(lines[index + 1] ?? ''));
}

test('a full render names every agent, so the gate checks below can see them', (t) => {
  const rendered = [...render(t, deployFeatures({})).values()].join('\n');
  assert.deepEqual(namedAgents(rendered), ALL_AGENTS);
});

for (const [label, features] of SELECTIONS) {
  test(`rules rendered for ${label} name only deployed agents`, (t) => {
    for (const [name, text] of render(t, features)) {
      const undeployed = namedAgents(text).filter((agent) => !features.includes(agent));
      assert.deepEqual(undeployed, [], `rules/${name} names undeployed agents`);
      assert.deepEqual(listHeadersWithoutItems(text), [], `rules/${name} has a list header with no list under it`);
      if (!features.includes('astra-implementer') && !features.includes('astra-reviewer')) {
        assert.doesNotMatch(text, /astra-impl/, `rules/${name} shows an Astra label example without an Astra agent`);
      }
    }
  });
}

const UI_RUN_SELECTIONS: [string, string[]][] = [
  ['features codex,argent,ui-runner,gpt-6.1-terra', ['codex', 'argent', 'ui-runner', 'gpt-6.1-terra']],
  ['--agents ui-runner', deployFeatures({ agents: ['ui-runner'] })],
];

for (const [label, features] of UI_RUN_SELECTIONS) {
  test(`rules rendered for ${label} keep long UI runs on ui-runner`, (t) => {
    const routing = render(t, features).get('40-model-routing.md') ?? '';
    assert.doesNotMatch(routing, /stay on gpt-6-astra/);
    assert.match(routing, /stay on ui-runner/);
  });
}

const WRAPPER_RULE = /Every Codex run goes through a wrapper/;

for (const agent of ['researcher', 'sol-implementer']) {
  test(`rules rendered for --agents ${agent} omit the wrapper-only Codex rule without codex-runner`, (t) => {
    assert.doesNotMatch(render(t, deployFeatures({ agents: [agent] })).get('60-subagent-mechanics.md') ?? '', WRAPPER_RULE);
  });
}

test('rules rendered for --agents codex-runner keep the wrapper-only Codex rule', (t) => {
  assert.match(render(t, deployFeatures({ agents: ['codex-runner'] })).get('60-subagent-mechanics.md') ?? '', WRAPPER_RULE);
});
