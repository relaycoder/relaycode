import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { COMMITTED_STATE_FILE_SUFFIX, PENDING_STATE_FILE_SUFFIX } from '../utils/constants';
import { logger, isEnoentError } from '../utils/logger';
import { fileExists, safeRename } from '../utils/fs';
import { ensureStateDirExists, getStateFilePath, getTransactionsDirectory, getUndoneStateFilePath } from './config';

export const isRevertTransaction = (state: StateFile): boolean => {
    return state.reasoning.some(r => r.startsWith('Reverting transaction'));
}

export const getRevertedTransactionUuid = (state: StateFile): string | null => {
    for (const r of state.reasoning) {
        const match = r.match(/^Reverting transaction ([\w-]+)\./);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

const getUuidFromFileName = (fileName: string): string => {
  return fileName.replace(COMMITTED_STATE_FILE_SUFFIX, '');
};

const isUUID = (str: string): boolean => {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
};

// Helper to get all committed transaction file names.
const getCommittedTransactionFiles = async (cwd: string): Promise<{ stateDir: string; files: string[] } | null> => {
    const transactionsDir = getTransactionsDirectory(cwd);
    try {
        await fs.access(transactionsDir);
    } catch (e) {
        return null;
    }
    const files = await fs.readdir(transactionsDir);
    const transactionFiles = files.filter(f => f.endsWith(COMMITTED_STATE_FILE_SUFFIX) && !f.endsWith(PENDING_STATE_FILE_SUFFIX));
    return { stateDir: transactionsDir, files: transactionFiles };
};

const sortByDateDesc = (a: { createdAt: string | Date }, b: { createdAt: string | Date }) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
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
  await ensureStateDirExists(cwd);
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
    const parsed = StateFileSchema.safeParse(yamlContent);
    if (parsed.success) {
      return parsed.data;
    }
    logger.debug(`Could not parse state file ${committedPath}: ${parsed.error.message}`);
    return null;
  } catch (error) {
    // Can be file not found or YAML parsing error.
    // In any case, we can't get the state file.
    return null;
  }
};

interface ReadStateFilesOptions {
    skipReverts?: boolean;
}

export const readAllStateFiles = async (cwd: string = process.cwd(), options: ReadStateFilesOptions = {}): Promise<StateFile[] | null> => {
    const transactionFileInfo = await getCommittedTransactionFiles(cwd);
    if (!transactionFileInfo) {
        return null;
    }
    const { files: transactionFiles } = transactionFileInfo;
    
    const promises = transactionFiles.map(async (file) => {
        const stateFile = await readStateFile(cwd, getUuidFromFileName(file));
        if (!stateFile) {
            logger.warn(`Could not read or parse state file ${file}. Skipping.`);
        }
        return stateFile;
    });

    const results = await Promise.all(promises);
    let validResults = results.filter((sf): sf is StateFile => !!sf);

    if (options.skipReverts) {
        const revertedUuids = new Set<string>();
        validResults.forEach(sf => {
            const revertedUuid = getRevertedTransactionUuid(sf);
            if (revertedUuid) {
                revertedUuids.add(revertedUuid);
            }
        });

        validResults = validResults.filter(sf => 
            !isRevertTransaction(sf) && !revertedUuids.has(sf.uuid)
        );
    }

    // Sort transactions by date, most recent first
    validResults.sort(sortByDateDesc);

    return validResults;
}

export const findLatestStateFile = async (cwd: string = process.cwd(), options: ReadStateFilesOptions = {}): Promise<StateFile | null> => {
    // This is a case where using readAllStateFiles is simpler and the performance
    // difference is negligible for finding just the latest.
    // The optimization in the original `findLatestStateFile` is complex and this simplifies logic.
    const allFiles = await readAllStateFiles(cwd, options);
    return allFiles?.[0] ?? null;
};

export const findStateFileByIdentifier = async (cwd: string, identifier: string, options: ReadStateFilesOptions = {}): Promise<StateFile | null> => {
    if (isUUID(identifier)) {
        // When fetching by UUID, we always return it, regardless of whether it's a revert or not.
        // The user is being explicit.
        return readStateFile(cwd, identifier);
    }
    
    if (/^-?\d+$/.test(identifier)) {
        const index = Math.abs(parseInt(identifier, 10));
        if (isNaN(index) || index <= 0) {
            return null;
        }

        const transactions = await readAllStateFiles(cwd, options);
        if (transactions && transactions.length >= index) {
            return transactions[index - 1] ?? null;
        }
        return null;
    }

    return null;
};