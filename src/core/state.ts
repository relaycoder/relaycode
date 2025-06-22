import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import { logger, isEnoentError } from '../utils/logger';
import { fileExists, safeRename } from './executor';

const stateDirectoryCache = new Map<string, boolean>();

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

export const getStateFilePath = (cwd: string, uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}.pending.yml` : `${uuid}.yml`;
  return path.join(getStateDirectory(cwd), fileName);
};

export const getUndoneStateFilePath = (cwd: string, uuid: string): string => {
  const fileName = `${uuid}.yml`;
  return path.join(getStateDirectory(cwd),'undone', fileName);
};

// Ensure state directory exists with caching for performance
const ensureStateDirectory = async (cwd: string): Promise<void> => {
  const dirPath = getStateDirectory(cwd);
  if (!stateDirectoryCache.has(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
    stateDirectoryCache.set(dirPath, true);
  }
};

export const hasBeenProcessed = async (cwd: string, uuid: string): Promise<boolean> => {
  const committedPath = getStateFilePath(cwd, uuid, false);
  const undonePath = getUndoneStateFilePath(cwd, uuid);
  // Check if a transaction has been committed or undone.
  // This allows re-processing a transaction that failed and left an orphaned .pending.yml
  // because we don't check for `.pending.yml` files.
  return (await fileExists(committedPath)) || (await fileExists(undonePath));
};

export const writePendingState = async (cwd: string, state: StateFile): Promise<void> => {
  const validatedState = StateFileSchema.parse(state);
  const yamlString = yaml.dump(validatedState);
  const filePath = getStateFilePath(cwd, state.uuid, true);
  
  // Ensure directory exists (cached)
  await ensureStateDirectory(cwd);
  
  // Write file
  await fs.writeFile(filePath, yamlString, 'utf-8');
};

export const commitState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  const committedPath = getStateFilePath(cwd, uuid, false);
  await safeRename(pendingPath, committedPath);
};

export const deletePendingState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  try {
    await fs.unlink(pendingPath);
  } catch (error) {
    if (isEnoentError(error)) {
      // Already gone, that's fine.
      return;
    }
    throw error;
  }
};

export const readStateFile = async (cwd: string, uuid: string): Promise<StateFile | null> => {
  const committedPath = getStateFilePath(cwd, uuid, false);
  try {
    const fileContent = await fs.readFile(committedPath, 'utf-8');
    const yamlContent = yaml.load(fileContent);
    return StateFileSchema.parse(yamlContent);
  } catch (error) {
    // Can be file not found, YAML parsing error, or Zod validation error.
    // In any case, we can't get the state file.
    return null;
  }
};

export const readAllStateFiles = async (cwd: string = process.cwd()): Promise<StateFile[] | null> => {
    const stateDir = getStateDirectory(cwd);
    try {
        await fs.access(stateDir);
    } catch (e) {
        return null; // No state directory, so no transactions
    }

    const files = await fs.readdir(stateDir);
    const transactionFiles = files.filter(f => f.endsWith('.yml') && !f.endsWith('.pending.yml'));

    const promises = transactionFiles.map(async (file) => {
        const stateFile = await readStateFile(cwd, file.replace('.yml', ''));
        if (!stateFile) {
            logger.warn(`Could not read or parse state file ${file}. Skipping.`);
        }
        return stateFile;
    });

    const results = await Promise.all(promises);
    return results.filter((sf): sf is StateFile => !!sf);
}

export const findLatestStateFile = async (cwd: string = process.cwd()): Promise<StateFile | null> => {
    const transactions = await readAllStateFiles(cwd);
    if (!transactions || transactions.length === 0) {
        return null;
    }

    transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return transactions[0] || null;
};