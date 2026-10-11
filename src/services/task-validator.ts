// Task validation (docs/spec.md, "Fields" and "Validation"): unknown fields, no type coercion,
// all errors at once with the path to the field.

import type { Task, TaskSource } from '../interfaces/task.interface.js';
import { currentPlatform, pathApi, type PlatformKind } from '../utilities/platform.js';
import { checkAbsolutePath, isRootPath, normalizeAbsolutePath } from './absolute-path.js';
import { checkMask } from './masks.js';
import { ARCHIVE_SUFFIX, checkName } from './names.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../utilities/strict-json.js';

const TASK_JSON_TYPE: Task['jsonType'] = 'af-backup-task';
const TASK_VERSION: Task['version'] = 1;
const TASK_FIELDS = new Set<string>(['jsonType', 'version', 'description', 'exclude', 'sources'] satisfies (keyof Task)[]);
const SOURCE_FIELDS = new Set<string>(['path', 'name', 'exclude', 'compress'] satisfies (keyof TaskSource)[]);

export interface ValidatedSource {
  index: number;
  /** Normalized absolute path. */
  path: string;
  /** Name of the subfolder in the backup (given or taken from the path). */
  name: string;
  exclude: string[];
  compress: boolean;
}

export interface ValidatedTask {
  description: string | undefined;
  exclude: string[];
  sources: ValidatedSource[];
}

export type ValidationResult = { ok: true; task: ValidatedTask } | { ok: false; errors: string[] };

type AddError = (field: string, message: string) => void;

/** Checks `jsonType` and `version`: returns an error text if this is not a task file of a known format version, or null. */
function checkTaskFormat(value: JsonValue): string | null {
  if (!isJsonObject(value) || value['jsonType'] !== TASK_JSON_TYPE) {
    return `this is not an af-backup task file (the "jsonType" field must be "${TASK_JSON_TYPE}")`;
  }

  const version = value['version'];

  if (version === TASK_VERSION) {
    return null;
  }

  if (version === undefined) {
    return 'version: required field is missing';
  }

  if (typeof version === 'number' && Number.isInteger(version) && version > TASK_VERSION) {
    return 'task format is newer than the program - update af-backup';
  }

  return `version: must be ${TASK_VERSION}, got ${typeName(version)}`;
}

export function validateTask(value: JsonValue, platform: PlatformKind = currentPlatform): ValidationResult {
  const formatError = checkTaskFormat(value);

  if (formatError) {
    return { ok: false, errors: [formatError] };
  }

  const taskObject = value as JsonObject;
  const errors: string[] = [];
  const addError: AddError = (field, message) => errors.push(`${field}: ${message}`);

  for (const field of Object.keys(taskObject)) {
    if (!TASK_FIELDS.has(field)) {
      addError(field, 'unknown field');
    }
  }

  const description = taskObject['description'];

  if (description !== undefined && typeof description !== 'string') {
    addError('description', `must be a string, got ${typeName(description)}`);
  }

  const exclude = checkMaskList(taskObject['exclude'], 'exclude', addError);

  const sources: ValidatedSource[] = [];
  const rawSources = taskObject['sources'];

  if (rawSources === undefined) {
    addError('sources', 'required field is missing');
  } else if (!Array.isArray(rawSources)) {
    addError('sources', `must be an array, got ${typeName(rawSources)}`);
  } else if (rawSources.length === 0) {
    addError('sources', 'at least one source is required');
  } else {
    rawSources.forEach((rawSource, index) => {
      const source = validateSource(rawSource, index, platform, addError);

      if (source) {
        sources.push(source);
      }
    });

    if (sources.length === rawSources.length) {
      checkSourceNames(sources, addError);
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    task: {
      description: description as string | undefined,
      exclude,
      sources,
    },
  };
}

function validateSource(value: JsonValue, index: number, platform: PlatformKind, addError: AddError): ValidatedSource | null {
  const at = `sources[${index}]`;

  if (!isJsonObject(value)) {
    addError(at, `must be an object, got ${typeName(value)}`);

    return null;
  }

  let ok = true;

  const fail: AddError = (field, message) => {
    ok = false;
    addError(`${at}.${field}`, message);
  };

  for (const field of Object.keys(value)) {
    if (!SOURCE_FIELDS.has(field)) {
      fail(field, 'unknown field');
    }
  }

  let normalized: string | undefined;
  const rawPath = value['path'];

  if (rawPath === undefined) {
    fail('path', 'required field is missing');
  } else if (typeof rawPath !== 'string') {
    fail('path', `must be a string, got ${typeName(rawPath)}`);
  } else {
    const problem = checkAbsolutePath(rawPath, platform);

    if (problem) {
      fail('path', problem);
    } else {
      normalized = normalizeAbsolutePath(rawPath, platform);
    }
  }

  let name: string | undefined;
  const rawName = value['name'];

  if (rawName !== undefined && typeof rawName !== 'string') {
    fail('name', `must be a string, got ${typeName(rawName)}`);
  } else if (typeof rawName === 'string') {
    const problem = checkName(rawName);

    if (problem) {
      fail('name', problem);
    } else {
      name = rawName;
    }
  } else if (normalized !== undefined) {
    if (isRootPath(normalized, platform)) {
      fail('name', 'required for the root of a drive or a network share (the path has no last part)');
    } else {
      const fromPath = pathApi(platform).basename(normalized);
      const problem = checkName(fromPath);

      if (problem) {
        fail('name', `name "${fromPath}" taken from the path is invalid: ${problem} - set "name" explicitly`);
      } else {
        name = fromPath;
      }
    }
  }

  const exclude = checkMaskList(value['exclude'], `${at}.exclude`, (field, message) => {
    ok = false;
    addError(field, message);
  });

  const rawCompress = value['compress'];

  if (rawCompress !== undefined && typeof rawCompress !== 'boolean') {
    fail('compress', `must be true or false, got ${typeName(rawCompress)}`);
  }

  if (!ok || normalized === undefined || name === undefined) {
    return null;
  }

  return { index, path: normalized, name, exclude, compress: rawCompress === true };
}

function checkSourceNames(sources: ValidatedSource[], addError: AddError): void {
  const byName = new Map<string, ValidatedSource>();

  for (const source of sources) {
    const lower = source.name.toLowerCase();
    const other = byName.get(lower);

    if (other) {
      addError(`sources[${source.index}].name`, `name "${source.name}" is already used by sources[${other.index}] (names are compared case-insensitively)`);
    } else {
      byName.set(lower, source);
    }
  }

  for (const source of sources) {
    if (!source.compress) {
      continue;
    }

    const archive = source.name + ARCHIVE_SUFFIX;
    const lower = archive.toLowerCase();

    const other = sources.find((candidate) => candidate !== source && candidate.name.toLowerCase() === lower);

    if (other) {
      addError(`sources[${source.index}].name`, `archive name "${archive}" matches the name of sources[${other.index}]`);
    }
  }
}

function checkMaskList(value: JsonValue | undefined, field: string, addError: AddError): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    addError(field, `must be an array of strings, got ${typeName(value)}`);

    return [];
  }

  const masks: string[] = [];

  value.forEach((mask, index) => {
    if (typeof mask !== 'string') {
      addError(`${field}[${index}]`, `must be a string, got ${typeName(mask)}`);
    } else {
      const problem = checkMask(mask);

      if (problem) {
        addError(`${field}[${index}]`, `${problem}: "${mask}"`);
      } else {
        masks.push(mask);
      }
    }
  });

  return masks;
}

function typeName(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'an array';
  }

  if (typeof value === 'object') {
    return 'an object';
  }

  if (typeof value === 'string') {
    return `a string ${JSON.stringify(value.length > 40 ? value.slice(0, 40) + '…' : value)}`;
  }

  if (typeof value === 'number') {
    return `the number ${value}`;
  }

  return `${typeof value} ${String(value)}`;
}
