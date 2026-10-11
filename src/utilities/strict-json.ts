// A strict JSON parser (RFC 8259): catches duplicate keys and reports the position of an error.
// The standard JSON.parse silently takes the last of duplicate keys (docs/spec.md, "Validation").
// Objects are created without a prototype, so a "__proto__" key is an ordinary key.

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`line ${line}, column ${column}: ${message}`);
    this.name = 'JsonSyntaxError';
  }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses JSON text; a leading BOM is allowed (Windows Notepad adds it). */
export function parseStrictJson(input: string): JsonValue {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const parser = new Parser(text);
  parser.skipWhitespace();
  const value = parser.parseValue('');
  parser.skipWhitespace();

  if (!parser.atEnd()) {
    parser.fail('unexpected text after the end of JSON');
  }

  return value;
}

class Parser {
  private position = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.position >= this.text.length;
  }

  fail(message: string, at = this.position): never {
    let line = 1;
    let lineStart = 0;

    for (let i = 0; i < at && i < this.text.length; i++) {
      if (this.text[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }

    throw new JsonSyntaxError(message, line, at - lineStart + 1);
  }

  skipWhitespace(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position];

      if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
        this.position++;
      } else {
        break;
      }
    }
  }

  private describeHere(): string {
    if (this.atEnd()) {
      return 'unexpected end of text';
    }

    const character = this.text[this.position]!;

    if (character === '/') {
      return 'comments are not allowed in JSON (use the "description" field for notes)';
    }

    return `unexpected character ${JSON.stringify(character)}`;
  }

  parseValue(path: string): JsonValue {
    const character = this.text[this.position];

    switch (character) {
      case '{':
        return this.parseObject(path);
      case '[':
        return this.parseArray(path);
      case '"':
        return this.parseString();
      case 't':
        return this.parseLiteral('true', true);
      case 'f':
        return this.parseLiteral('false', false);
      case 'n':
        return this.parseLiteral('null', null);
      default:
        if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
          return this.parseNumber();
        }

        return this.fail(this.describeHere());
    }
  }

  private parseLiteral<T extends JsonValue>(word: string, value: T): T {
    if (this.text.startsWith(word, this.position)) {
      this.position += word.length;

      return value;
    }

    return this.fail(this.describeHere());
  }

  private parseNumber(): number {
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numberPattern.lastIndex = this.position;
    const match = numberPattern.exec(this.text);

    if (!match) {
      return this.fail('invalid number');
    }

    this.position += match[0].length;

    return Number(match[0]);
  }

  private parseString(): string {
    const start = this.position;
    this.position++; // opening quote
    let result = '';

    while (true) {
      if (this.atEnd()) {
        this.fail('unterminated string', start);
      }

      const character = this.text[this.position]!;

      if (character === '"') {
        this.position++;

        return result;
      }

      if (character === '\\') {
        const escaped = this.text[this.position + 1];
        const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

        if (escaped !== undefined && escaped in simple) {
          result += simple[escaped];
          this.position += 2;
        } else if (escaped === 'u') {
          const hex = this.text.slice(this.position + 2, this.position + 6);

          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail('invalid \\u escape');
          }

          result += String.fromCharCode(parseInt(hex, 16));
          this.position += 6;
        } else {
          this.fail('invalid escape in string (a backslash in a path is written as \\\\)');
        }

        continue;
      }

      if (character < ' ') {
        this.fail('control character in string (use \\n, \\t)');
      }

      result += character;
      this.position++;
    }
  }

  private parseArray(path: string): JsonValue[] {
    this.position++;
    const array: JsonValue[] = [];
    this.skipWhitespace();

    if (this.text[this.position] === ']') {
      this.position++;

      return array;
    }

    while (true) {
      this.skipWhitespace();
      array.push(this.parseValue(`${path}[${array.length}]`));
      this.skipWhitespace();
      const character = this.text[this.position];

      if (character === ',') {
        this.position++;
        this.skipWhitespace();

        if (this.text[this.position] === ']') {
          this.fail('trailing comma is not allowed');
        }

        continue;
      }

      if (character === ']') {
        this.position++;

        return array;
      }

      this.fail(this.atEnd() ? 'unexpected end of text: "]" expected' : `"," or "]" expected, ${this.describeHere()}`);
    }
  }

  private parseObject(path: string): JsonObject {
    this.position++;
    const object = Object.create(null) as JsonObject;
    this.skipWhitespace();

    if (this.text[this.position] === '}') {
      this.position++;

      return object;
    }

    while (true) {
      this.skipWhitespace();

      if (this.text[this.position] !== '"') {
        this.fail(`property name in double quotes expected, ${this.describeHere()}`);
      }

      const keyPosition = this.position;
      const key = this.parseString();
      const keyPath = path ? `${path}.${key}` : key;

      if (Object.prototype.hasOwnProperty.call(object, key)) {
        this.fail(`duplicate key "${keyPath}"`, keyPosition);
      }

      this.skipWhitespace();

      if (this.text[this.position] !== ':') {
        this.fail(`":" expected, ${this.describeHere()}`);
      }

      this.position++;
      this.skipWhitespace();
      object[key] = this.parseValue(keyPath);
      this.skipWhitespace();
      const character = this.text[this.position];

      if (character === ',') {
        this.position++;
        this.skipWhitespace();

        if (this.text[this.position] === '}') {
          this.fail('trailing comma is not allowed');
        }

        continue;
      }

      if (character === '}') {
        this.position++;

        return object;
      }

      this.fail(this.atEnd() ? 'unexpected end of text: "}" expected' : `"," or "}" expected, ${this.describeHere()}`);
    }
  }
}
