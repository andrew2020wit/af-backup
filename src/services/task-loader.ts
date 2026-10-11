// Loading the task file `af-backup-task.json` from the destination folder (docs/spec.md, "Destination folder").

import { StartError, describeError, errorCode } from '../utilities/errors.js';
import { taskFilePath } from '../utilities/destination-layout.js';
import { fileSystemOperations } from './file-system-operations.js';
import { JsonSyntaxError, parseStrictJson, type JsonValue } from '../utilities/strict-json.js';
import { validateTask, type ValidatedTask } from './task-validator.js';

const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** Reads and parses a JSON file; throws an Error with a readable message. */
async function readJsonFile(filePath: string): Promise<JsonValue> {
  const bytes = await fileSystemOperations.readFile(filePath);
  let text: string;

  try {
    text = textDecoder.decode(bytes);
  } catch {
    throw new Error('the file is not in UTF-8 encoding');
  }

  return parseStrictJson(text);
}

/** Loads and validates the task of a destination folder (step 2 of "Task execution"); any problem is a level 1 error. */
export async function loadTask(destinationFolder: string): Promise<ValidatedTask> {
  const filePath = taskFilePath(destinationFolder);
  let value: JsonValue;

  try {
    value = await readJsonFile(filePath);
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      throw new StartError(`task file ${filePath}: invalid JSON: ${error.message}`);
    }

    if (errorCode(error) === 'ENOENT') {
      throw new StartError(`task file not found: ${filePath} - the disk may not be connected`);
    }

    throw new StartError(`cannot read task file ${filePath}: ${describeError(error)}`);
  }

  const validationResult = validateTask(value);

  if (!validationResult.ok) {
    throw new StartError(validationResult.errors.map((validationError) => `task file ${filePath}: ${validationError}`));
  }

  return validationResult.task;
}
