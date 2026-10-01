import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the script Node was started with. Compares real
 * paths: Node resolves the module URL through symlinks, but argv[1] keeps the path the
 * caller used, so a plain comparison fails when the repository is reached via a symlink.
 */
export function isMain(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

interface Option {
  name: string;
  value?: string;
  help?: string;
  required?: boolean;
  default?: string;
}

export function parseArguments(options: Option[], argv = process.argv.slice(2)): Record<string, string | boolean> {
  const program = path.basename(process.argv[1]);
  const allOptions: Option[] = [{ name: '--help', help: 'show this help message and exit' }, ...options];
  const prefix = `usage: ${program} `;
  const parts = ['[-h]', ...options.map((option) => {
    const label = option.name + (option.value ? ` ${option.value}` : '');
    return option.required ? label : `[${label}]`;
  })];
  let usage = prefix;
  let width = prefix.length;
  for (const part of parts) {
    if (width > prefix.length && width + 1 + part.length > 78) {
      usage += `\n${' '.repeat(prefix.length)}`;
      width = prefix.length;
    } else if (width > prefix.length) {
      usage += ' ';
      width++;
    }
    usage += part;
    width += part.length;
  }
  usage += '\n';
  const fail = (message: string): never => {
    process.stderr.write(`${usage}${program}: error: ${message}\n`);
    process.exit(2);
  };
  const help = (): never => {
    const labels = allOptions.map((option) => option.name === '--help' ? '-h, --help' : option.name + (option.value ? ` ${option.value}` : ''));
    const column = Math.min(24, Math.max(...labels.map((label) => label.length)) + 4);
    let output = `${usage}\noptions:\n`;
    allOptions.forEach((option, index) => {
      const label = `  ${labels[index]}`;
      output += label;
      if (option.help) output += label.length + 2 > column ? `\n${' '.repeat(column)}${option.help}` : `${' '.repeat(column - label.length)}${option.help}`;
      output += '\n';
    });
    process.stdout.write(output);
    process.exit(0);
  };
  const result: Record<string, string | boolean> = {};
  for (const option of options) {
    if (!option.value) result[option.name] = false;
    else if (option.default !== undefined) result[option.name] = option.default;
  }
  const seen = new Set<string>();
  const unknown: string[] = [];
  const isOption = (arg: string): boolean => arg.startsWith('-') && arg !== '-' && !/^-\d+$|^-\d*\.\d+$/.test(arg) && !arg.includes(' ');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      unknown.push(...argv.slice(i));
      break;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    let explicit = equals < 0 ? undefined : arg.slice(equals + 1);
    let matches = allOptions.filter((option) => option.name === name);
    if (name === '-h' || (arg.startsWith('-h') && !arg.startsWith('--'))) {
      matches = [allOptions[0]];
      if (name !== '-h') help();
    } else if (!matches.length && name.startsWith('--')) {
      matches = allOptions.filter((option) => option.name.startsWith(name));
    }
    if (matches.length > 1) fail(`ambiguous option: ${name} could match ${matches.map((option) => option.name).join(', ')}`);
    const option = matches[0];
    if (!option) {
      unknown.push(arg);
      continue;
    }
    const argumentName = option.name === '--help' ? '-h/--help' : option.name;
    if (!option.value) {
      if (explicit !== undefined) fail(`argument ${argumentName}: ignored explicit argument ${JSON.stringify(explicit)}`);
      if (option.name === '--help') help();
      result[option.name] = true;
    } else {
      if (explicit === undefined) {
        if (i + 1 >= argv.length || isOption(argv[i + 1])) fail(`argument ${argumentName}: expected one argument`);
        explicit = argv[++i];
      }
      result[option.name] = explicit;
    }
    seen.add(option.name);
  }
  const missing = options.filter((option) => option.required && !seen.has(option.name));
  if (missing.length) fail(`the following arguments are required: ${missing.map((option) => option.name).join(', ')}`);
  if (unknown.length) fail(`unrecognized arguments: ${unknown.join(' ')}`);
  return result;
}
