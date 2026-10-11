// Exclusion masks (docs/spec.md, "Exclusions").
//
// `*` - any characters within one name, `**` - any number of folder levels (only as a whole segment),
// everything else is literal. A mask without `/` is matched against the name at any depth,
// a mask with `/` - against the path from the source root.

/** Returns an error text, or null if the mask is valid. */
export function checkMask(mask: string): string | null {
  if (mask === '') {
    return 'empty mask';
  }

  if (mask.includes('\\')) {
    return 'the separator in masks is "/", "\\" is not allowed';
  }

  if (mask.startsWith('/') || /^[A-Za-z]:/.test(mask)) {
    return 'mask must not be an absolute path (masks are relative to the source root)';
  }

  if (mask.endsWith('/')) {
    return 'mask must not end with "/" (a matching folder is excluded entirely anyway)';
  }

  const segments = mask.split('/');

  for (const segment of segments) {
    if (segment === '') {
      return 'empty path segment ("//")';
    }

    if (segment === '.' || segment === '..') {
      return `path segment "${segment}" is not allowed`;
    }

    if (segment.includes('**') && segment !== '**') {
      return '"**" must be a whole path segment (for example, "**/logs")';
    }
  }

  if (segments[segments.length - 1] === '**') {
    return 'mask must not end with "**" (a matching folder is excluded entirely anyway)';
  }

  if (segments.every((segment) => /^\*+$/.test(segment))) {
    return 'mask consists only of "*" and "**" and would exclude whole levels of the source';
  }

  return null;
}

export interface CompiledMask {
  /** The mask as written in the task. */
  readonly text: string;
  readonly anchored: boolean;
  /**
   * @param relativePath path from the source root, separator "/"
   * @param name the item name (the last segment of `relativePath`)
   */
  matches(relativePath: string, name: string): boolean;
}

function segmentRegExp(segment: string, caseInsensitive: boolean): RegExp {
  const body = segment
    .split('*')
    .map((part) => part.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&'))
    .join('[^/]*');

  return new RegExp(`^${body}$`, caseInsensitive ? 'iu' : 'u');
}

/** Compiles a valid mask (checkMask returned null). */
export function compileMask(text: string, caseInsensitive: boolean): CompiledMask {
  if (!text.includes('/')) {
    const nameRegExp = segmentRegExp(text, caseInsensitive);

    return { text, anchored: false, matches: (_relativePath, name) => nameRegExp.test(name) };
  }

  const patterns: (RegExp | '**')[] = text.split('/').map((segment) => (segment === '**' ? '**' : segmentRegExp(segment, caseInsensitive)));

  return {
    text,
    anchored: true,
    matches: (relativePath) => matchSegments(patterns, relativePath.split('/'), 0, 0),
  };
}

function matchSegments(patterns: (RegExp | '**')[], parts: string[], patternIndex: number, partIndex: number): boolean {
  while (patternIndex < patterns.length) {
    const pattern = patterns[patternIndex]!;

    if (pattern === '**') {
      for (let nextPartIndex = partIndex; nextPartIndex <= parts.length; nextPartIndex++) {
        if (matchSegments(patterns, parts, patternIndex + 1, nextPartIndex)) {
          return true;
        }
      }

      return false;
    }

    if (partIndex >= parts.length || !pattern.test(parts[partIndex]!)) {
      return false;
    }

    patternIndex++;
    partIndex++;
  }

  return partIndex === parts.length;
}
