import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonSyntaxError, parseStrictJson } from './strict-json.js';

test('parses the same values as JSON.parse', () => {
  const samples = [
    '{"a":1,"b":[true,false,null],"c":"x\\ny\\u0041\\\\","d":{"e":-1.5e3}}',
    '[]',
    '{}',
    '"str"',
    '0',
    ' \n\t{ "a" : [ 1 , 2 ] }\r\n',
  ];

  for (const sample of samples) {
    assert.deepEqual(JSON.parse(JSON.stringify(parseStrictJson(sample))), JSON.parse(sample), sample);
  }
});

test('a BOM is allowed', () => {
  assert.deepEqual({ ...(parseStrictJson('﻿{"a":1}') as object) }, { a: 1 });
});

test('duplicate keys are an error with the path to the key', () => {
  assert.throws(() => parseStrictJson('{"copies":1,\n "copies":2}'), (error: unknown) => {
    assert.ok(error instanceof JsonSyntaxError);
    assert.equal(error.line, 2);
    assert.equal(error.column, 2);
    assert.match(error.message, /duplicate key "copies"/);

    return true;
  });

  assert.throws(() => parseStrictJson('{"s":[{"a":1},{"a":1,"a":2}]}'), /duplicate key "s\[1\]\.a"/);
});

test('__proto__ is an ordinary key', () => {
  const value = parseStrictJson('{"__proto__":{"x":1}}') as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(value), null);
  assert.deepEqual(Object.keys(value), ['__proto__']);
});

test('syntax errors', () => {
  for (const sample of ['', '{', '{"a":1,}', '[1,]', '{a:1}', "{'a':1}", '{"a":1} x', '// c\n{}', '{"a":"\\x"}', '{"a":"\u0001"}', '01', '1.', 'tru']) {
    assert.throws(() => parseStrictJson(sample), JsonSyntaxError, JSON.stringify(sample));
  }

  assert.throws(() => parseStrictJson('{"a": 1 // note\n}'), /comments are not allowed/);
});
