import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { COMMITTED_STATE_FILE_SUFFIX, PENDING_STATE_FILE_SUFFIX, STATE_DIRECTORY_NAME, TRANSACTIONS_DIRECTORY_NAME, UNDONE_DIRECTORY_NAME } from '../utils/constants';
import { logger, isEnoentError, getErrorMessage } from '../utils/logger';
import { fileExists, safeRename } from '../utils/fs';

const stateDirectoryCache = new Map<string, boolean>();

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

export const getStateFilePath = (cwd: string, uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}${PENDING_STATE_FILE_SUFFIX}` : `${uuid}${COMMITTED_STATE_FILE_SUFFIX}`;
  return path.join(getStateDirectory(cwd), TRANSACTIONS_DIRECTORY_NAME, fileName);
};

export const getUndoneStateFilePath = (cwd: string, uuid: string): string => {
  const fileName = `${uuid}${COMMITTED_STATE_FILE_SUFFIX}`;
  return path.join(getStateDirectory(cwd), TRANSACTIONS_DIRECTORY_NAME, UNDONE_DIRECTORY_NAME, fileName);
};

const getUuidFromFileName = (fileName: string): string => {
  return fileName.replace(COMMITTED_STATE_FILE_SUFFIX, '');
};

const isUUID = (str: string): boolean => {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
};

// Helper to get all committed transaction file names.
const getCommittedTransactionFiles = async (cwd: string): Promise<{ stateDir: string; files: string[] } | null> => {
    const transactionsDir = path.join(getStateDirectory(cwd), TRANSACTIONS_DIRECTORY_NAME);
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

// Ensure state directory exists with caching for performance
const ensureStateDirectory = async (cwd: string): Promise<void> => {
  const dirPath = path.join(getStateDirectory(cwd), TRANSACTIONS_DIRECTORY_NAME);
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

export const readAllStateFiles = async (cwd: string = process.cwd()): Promise<StateFile[] | null> => {
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
    const validResults = results.filter((sf): sf is StateFile => !!sf);

    // Sort transactions by date, most recent first
    validResults.sort(sortByDateDesc);

    return validResults;
}

export const findLatestStateFile = async (cwd: string = process.cwd()): Promise<StateFile | null> => {
    const transactionFileInfo = await getCommittedTransactionFiles(cwd);
    if (!transactionFileInfo || transactionFileInfo.files.length === 0) {
        return null;
    }
    const { stateDir, files: transactionFiles } = transactionFileInfo;
    
    // Read creation date from each file without parsing the whole thing.
    // This is much faster than reading and parsing the full YAML for every file.
    const filesWithDates = await Promise.all(
        transactionFiles.map(async (file) => {
            const filePath = path.join(stateDir, file);
            let createdAt: Date | null = null;
            try {
                // Read only the first 512 bytes to find `createdAt`. This is an optimization.
                const fileHandle = await fs.open(filePath, 'r');
                const buffer = Buffer.alloc(512);
                await fileHandle.read(buffer, 0, 512, 0);
                await fileHandle.close();
                const content = buffer.toString('utf-8');
                // Extract date from a line like 'createdAt: 2023-01-01T00:00:00.000Z'
                const match = content.match(/^createdAt:\s*['"]?(.+?)['"]?$/m);
                if (match && match[1]) {
                    createdAt = new Date(match[1]);
                }
            } catch (error) {
                if (!isEnoentError(error)) {
                  logger.debug(`Could not read partial date from ${file}: ${getErrorMessage(error)}`);
                }
            }
            return { file, createdAt };
        })
    );

    const validFiles = filesWithDates.filter(f => f.createdAt instanceof Date) as { file: string; createdAt: Date }[];

    if (validFiles.length === 0) {
        // Fallback for safety, though it should be rare.
        const transactions = await readAllStateFiles(cwd);
        return transactions?.[0] ?? null;
    }

    validFiles.sort((a, b) => sortByDateDesc({ createdAt: a.createdAt }, { createdAt: b.createdAt }));

    const latestFile = validFiles[0];
    if (!latestFile) {
        return null;
    }

    // Now read the full content of only the latest file
    return readStateFile(cwd, getUuidFromFileName(latestFile.file));
};

export const findStateFileByIdentifier = async (cwd: string, identifier: string): Promise<StateFile | null> => {
    if (isUUID(identifier)) {
        return readStateFile(cwd, identifier);
    }
    
    if (/^-?\d+$/.test(identifier)) {
        const index = Math.abs(parseInt(identifier, 10));
        if (isNaN(index) || index <= 0) {
            return null;
        }
        // Optimization: use the more efficient method for the most common case.
        if (index === 1) {
            return findLatestStateFile(cwd);
        }
        const allTransactions = await readAllStateFiles(cwd);
        if (!allTransactions || allTransactions.length < index) {
            return null;
        }
        return allTransactions[index - 1] ?? null;
    }
    return null; // Invalid identifier format
};