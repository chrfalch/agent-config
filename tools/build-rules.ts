import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMain, parseArguments } from './cli.js';
import { compareCodePoints, PYTHON_WHITESPACE, splitLinesKeepingEnds } from './pycompat.js';

const MODELS = ['gpt-6-luna', 'gpt-6.1-sol', 'sonnet-5.5', 'opus-5.5', 'gpt-6-astra', 'fable-5'];
const TOOLS = ['codex', 'argent', 'gh-stack'];
const AGENTS = ['researcher', 'runner', 'ui-runner', 'opus-implementer', 'sol-implementer', 'astra-implementer', 'astra-reviewer', 'reviewer'];
const VOCABULARY = new Set([...MODELS, ...TOOLS, ...AGENTS]);
const MODEL_REQUIRES = new Map([['gpt-6-luna', 'codex'], ['gpt-6.1-sol', 'codex'], ['gpt-6-astra', 'codex']]);

const OPEN = new RegExp(`^<!--${PYTHON_WHITESPACE}*needs:${PYTHON_WHITESPACE}*(.+?)${PYTHON_WHITESPACE}*-->${PYTHON_WHITESPACE}*$`);
const CLOSE = new RegExp(`^<!--${PYTHON_WHITESPACE}*/needs${PYTHON_WHITESPACE}*-->${PYTHON_WHITESPACE}*$`);
const FRONT = /^---\n(.*?)\n---\n/s;
const strip = (text: string): string => text.replace(new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, 'g'), '');

function parseNeeds(raw: string): Set<string> {
  return new Set(raw.split(',').map(strip).filter(Boolean));
}

function includes(needs: Set<string>, features: Set<string>): boolean {
  return [...needs].every((feature) => features.has(feature));
}

function wanted(text: string, features: Set<string>): boolean {
  const front = FRONT.exec(text);
  let needs = new Set<string>();
  if (front) {
    for (const line of splitLinesKeepingEnds(front[1])) {
      if (strip(line).startsWith('needs:')) needs = parseNeeds(line.slice(line.indexOf(':') + 1));
    }
  }
  return includes(needs, features);
}

function render(text: string, features: Set<string>): string {
  const out: string[] = [];
  const stack: boolean[] = [];
  for (const line of splitLinesKeepingEnds(text)) {
    const marker = line.replace(/\n+$/, '');
    const open = OPEN.exec(marker);
    if (open) {
      stack.push(includes(parseNeeds(open[1]), features));
    } else if (CLOSE.test(marker)) {
      if (!stack.length) throw new Error('closing marker without an opening one');
      stack.pop();
    } else if (stack.every(Boolean)) {
      out.push(line);
    }
  }
  if (stack.length) throw new Error('unclosed block marker');
  return collapseBlankLineRuns(out.join('')).replace(new RegExp(`${PYTHON_WHITESPACE}+$`), '') + '\n';
}

function collapseBlankLineRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

export function buildRules({ src, out, features: rawFeatures }: { src: string; out: string; features: string }): number {
  const features = parseNeeds(rawFeatures);
  // applied here so every caller gets it
  for (const [model, tool] of MODEL_REQUIRES) {
    if (!features.has(tool)) features.delete(model);
  }
  const unknown = [...features].filter((feature) => !VOCABULARY.has(feature));
  if (unknown.length) {
    console.error(`unknown feature(s): ${unknown.sort(compareCodePoints).join(', ')}`);
    return 1;
  }
  mkdirSync(out, { recursive: true });
  let names: string[];
  try {
    names = readdirSync(src).filter((name) => name.endsWith('.md')).sort(compareCodePoints);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    names = [];
  }
  const skipped: string[] = [];
  for (const name of names) {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path.join(src, name))).replace(/\r\n?/g, '\n');
    if (!wanted(text, features)) {
      skipped.push(name);
      continue;
    }
    const dest = path.join(out, name);
    // Old deploys symlink outputs into the repository; never write through them.
    if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink() || existsSync(dest)) unlinkSync(dest);
    let rendered: string;
    try {
      rendered = render(text, features);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error(`ValueError: ${error.message}`);
      return 1;
    }
    writeFileSync(dest, rendered);
  }
  if (skipped.length) console.log(`rules    not written: ${skipped.join(', ')}`);
  return 0;
}

function main(): number {
  const args = parseArguments([
    { name: '--src', value: 'SRC', default: 'rules' },
    { name: '--out', value: 'OUT' },
    { name: '--features', value: 'FEATURES', default: '' },
    { name: '--vocabulary' },
  ]);
  if (args['--vocabulary']) {
    console.log([...VOCABULARY].sort(compareCodePoints).join(' '));
    return 0;
  }
  if (args['--out'] === undefined) {
    console.error('--out is required');
    return 1;
  }
  return buildRules({
    src: String(args['--src']) || '.',
    out: String(args['--out']) || '.',
    features: String(args['--features']),
  });
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
