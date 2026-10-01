type JsonScalar = null | boolean | string | bigint | JsonFloat;
export type JsonValue = JsonScalar | JsonValue[] | JsonObject;

class JsonFloat {
  constructor(readonly value: number) {}
}

export class JsonObject {
  readonly entries = new Map<string, JsonValue>();
}

class Parser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    const value = this.value();
    this.space();
    if (this.offset !== this.source.length) this.fail('Extra data');
    return value;
  }

  private value(): JsonValue {
    this.space();
    const char = this.source[this.offset];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    if (this.take('true')) return true;
    if (this.take('false')) return false;
    if (this.take('null')) return null;
    if (this.take('NaN')) return new JsonFloat(Number.NaN);
    if (this.take('Infinity')) return new JsonFloat(Number.POSITIVE_INFINITY);
    if (this.take('-Infinity')) return new JsonFloat(Number.NEGATIVE_INFINITY);
    return this.number();
  }

  private object(): JsonObject {
    this.offset++;
    const result = new JsonObject();
    this.space();
    if (this.source[this.offset] === '}') {
      this.offset++;
      return result;
    }
    while (true) {
      this.space();
      if (this.source[this.offset] !== '"') this.fail('Expected property name');
      const key = this.string();
      this.space();
      if (this.source[this.offset++] !== ':') this.fail("Expected ':'");
      result.entries.set(key, this.value());
      this.space();
      const delimiter = this.source[this.offset++];
      if (delimiter === '}') return result;
      if (delimiter !== ',') this.fail("Expected ','");
    }
  }

  private array(): JsonValue[] {
    this.offset++;
    const result: JsonValue[] = [];
    this.space();
    if (this.source[this.offset] === ']') {
      this.offset++;
      return result;
    }
    while (true) {
      result.push(this.value());
      this.space();
      const delimiter = this.source[this.offset++];
      if (delimiter === ']') return result;
      if (delimiter !== ',') this.fail("Expected ','");
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset++;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset++];
      if (char === '"') {
        return JSON.parse(this.source.slice(start, this.offset)) as string;
      }
      if (char === '\\') this.offset++;
      else if (char !== undefined && char.charCodeAt(0) < 0x20) this.fail('Invalid control character');
    }
    this.fail('Unterminated string');
  }

  private number(): JsonValue {
    const rest = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (!match) this.fail('Expecting value');
    this.offset += match[0].length;
    if (!/[.eE]/.test(match[0])) return BigInt(match[0]);
    return new JsonFloat(Number(match[0]));
  }

  private space(): void {
    while (' \t\r\n'.includes(this.source[this.offset] ?? '\0')) this.offset++;
  }

  private take(token: string): boolean {
    if (!this.source.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at position ${this.offset}`);
  }
}

export function parsePythonJson(source: string): JsonValue {
  return new Parser(source).parse();
}

function quote(value: string): string {
  let result = '"';
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (char === '"') result += '\\"';
    else if (char === '\\') result += '\\\\';
    else if (char === '\b') result += '\\b';
    else if (char === '\f') result += '\\f';
    else if (char === '\n') result += '\\n';
    else if (char === '\r') result += '\\r';
    else if (char === '\t') result += '\\t';
    else if (point >= 0x20 && point <= 0x7e) result += char;
    else if (point <= 0xffff) result += `\\u${point.toString(16).padStart(4, '0')}`;
    else {
      const adjusted = point - 0x10000;
      const high = 0xd800 + (adjusted >> 10);
      const low = 0xdc00 + (adjusted & 0x3ff);
      result += `\\u${high.toString(16)}\\u${low.toString(16)}`;
    }
  }
  return `${result}"`;
}

function floatString(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`;
  let rendered = String(value);
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e16)) {
    rendered = value.toExponential().replace(/\.0+e/, 'e').replace(/(\.\d*?)0+e/, '$1e');
  }
  return rendered.replace(/e([+-])(\d)$/, 'e$10$2');
}

function normalize(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return new JsonFloat(value);
  if (typeof value === 'bigint') return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof JsonObject || value instanceof JsonFloat) return value;
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = value.constructor?.name ?? typeof value;
      throw new TypeError(`Object of type ${name} is not JSON serializable`);
    }
    const result = new JsonObject();
    for (const [key, child] of Object.entries(value)) result.entries.set(key, normalize(child));
    return result;
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

function render(value: JsonValue, level: number, pretty: boolean): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof JsonFloat) return floatString(value.value);
  const innerIndent = '  '.repeat(level + 1);
  const outerIndent = '  '.repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (!pretty) return `[${value.map((child) => render(child, level + 1, pretty)).join(', ')}]`;
    return `[\n${value.map((child) => `${innerIndent}${render(child, level + 1, pretty)}`).join(',\n')}\n${outerIndent}]`;
  }
  if (value.entries.size === 0) return '{}';
  const children = [...value.entries].map(
    ([key, child]) => `${pretty ? innerIndent : ''}${quote(key)}: ${render(child, level + 1, pretty)}`,
  );
  if (!pretty) return `{${children.join(', ')}}`;
  return `{\n${children.join(',\n')}\n${outerIndent}}`;
}

export function dumpPythonJson(value: unknown, pretty = true): string {
  return render(normalize(value), 0, pretty);
}

export function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  // dict.get() returns None for a missing key, and Python's bool is an int subtype.
  if (left === undefined && right === null) return true;
  if (left === right) return true;
  if (typeof left === 'boolean' && typeof right === 'bigint') return BigInt(Number(left)) === right;
  if (typeof left === 'bigint' && typeof right === 'boolean') return left === BigInt(Number(right));
  if (typeof left === 'boolean' && right instanceof JsonFloat) return Number(left) === right.value;
  if (left instanceof JsonFloat && typeof right === 'boolean') return left.value === Number(right);
  if (typeof left === 'bigint' && right instanceof JsonFloat) {
    return Number.isInteger(right.value) && Number.isFinite(right.value) && left === BigInt(right.value);
  }
  if (left instanceof JsonFloat && typeof right === 'bigint') {
    return Number.isInteger(left.value) && Number.isFinite(left.value) && BigInt(left.value) === right;
  }
  if (left instanceof JsonFloat && right instanceof JsonFloat) return left.value === right.value;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (left instanceof JsonObject && right instanceof JsonObject) {
    if (left.entries.size !== right.entries.size) return false;
    for (const [key, value] of left.entries) {
      const other = right.entries.get(key);
      if (other === undefined && !right.entries.has(key)) return false;
      if (!jsonEqual(value, other!)) return false;
    }
    return true;
  }
  return false;
}
