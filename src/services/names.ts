// Rules for source names (docs/spec.md, "Sources").

export const ARCHIVE_SUFFIX = '.tar.gz';

const INVALID_CHARACTERS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const RESERVED = new Set(
  ['CON', 'PRN', 'AUX', 'NUL'].concat(
    ...['COM', 'LPT'].map((prefix) => ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'].map((digit) => prefix + digit)),
  ),
);

export function escapeCharacter(character: string): string {
  const code = character.codePointAt(0)!;

  return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : character;
}

/** Returns an error text, or null if the name is valid as a source name (a folder or file name in the backup). */
export function checkName(name: string): string | null {
  if (name === '') {
    return 'empty name';
  }

  for (const character of name) {
    const code = character.codePointAt(0)!;

    if (INVALID_CHARACTERS.has(character) || code < 0x20 || code === 0x7f) {
      return `invalid character "${escapeCharacter(character)}"`;
    }
  }

  if (name === '.' || name === '..') {
    return `"${name}" is not a valid name`;
  }

  if (name.endsWith('.') || name.endsWith(' ')) {
    return 'name must not end with a dot or a space (Windows drops them)';
  }

  const base = name.split('.')[0]!.trimEnd().toUpperCase();

  if (RESERVED.has(base)) {
    return `"${name}" is a reserved name on Windows`;
  }

  return null;
}
