// Escaping control characters in names, so that a log event always takes one line
// (docs/spec.md, "Log").

export function escapeControl(text: string): string {
  let escaped = '';

  for (const character of text) {
    const code = character.codePointAt(0)!;

    if (character === '\n') {
      escaped += '\\n';
    } else if (character === '\t') {
      escaped += '\\t';
    } else if (character === '\r') {
      escaped += '\\r';
    } else if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      escaped += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      escaped += character;
    }
  }

  return escaped;
}

/** A name from raw bytes: valid UTF-8 sequences as text, invalid bytes as \xNN. */
export function escapeBytes(bytes: Buffer): string {
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  let escaped = '';
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i]!;
    const sequenceLength = byte < 0x80 ? 1 : byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 0;

    if (sequenceLength > 0 && i + sequenceLength <= bytes.length) {
      try {
        escaped += escapeControl(textDecoder.decode(bytes.subarray(i, i + sequenceLength)));
        i += sequenceLength;
        continue;
      } catch {
        // invalid sequence - escape the first byte and go on
      }
    }

    escaped += `\\x${byte.toString(16).padStart(2, '0')}`;
    i++;
  }

  return escaped;
}
