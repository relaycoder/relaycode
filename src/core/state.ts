import { StateFile } from '../types';
import { logger } from '../utils/logger';
import { getDb, toStateFile, fromStateFile } from './db';
import { promises as fs } from 'fs';
import path from 'path';
import { getStateDirectory } from './config';

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

const isUUID = (str: string): boolean => {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
};

const sortByDateDesc = (a: { createdAt: string | Date }, b: { createdAt: string | Date }) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
};

export const hasBeenProcessed = async (cwd: string, uuid: string): Promise<boolean> => {
  const db = getDb(cwd);
  const record = await db.query().from('transactions').where({ uuid }).first();
  // A transaction has been processed if it exists and is either committed or undone.
  // A pending transaction has not been fully processed.
  return !!record && (record.status === 'committed' || record.status === 'undone');
};

export const writePendingState = async (cwd: string, state: StateFile): Promise<void> => {
  const db = getDb(cwd);
  const data = {
    ...fromStateFile(state),
    status: 'pending',
  };
  await db.insert('transactions', data as any);
};

export const updatePendingState = async (cwd:string, state: StateFile): Promise<void> => {
    const db = getDb(cwd);
    const data = fromStateFile(state);
    const updated = await db.update('transactions').set(data as any).where({ uuid: state.uuid, status: 'pending' });
    if (updated.length === 0) {
        logger.warn(`Could not find pending transaction with uuid ${state.uuid} to update.`);
    }
}

export const commitState = async (cwd: string, uuid: string): Promise<void> => {
  const db = getDb(cwd);
  // Also update status from 'pending' to 'committed'
  const updated = await db.update('transactions').set({ status: 'committed' }).where({ uuid, status: 'pending' });
  if (updated.length === 0) {
      logger.warn(`Could not find pending transaction with uuid ${uuid} to commit.`);
  }
};

export const deletePendingState = async (cwd: string, uuid: string): Promise<void> => {
  const db = getDb(cwd);
  // In case of rollback, we mark it as 'undone' instead of deleting.
  const updated = await db.update('transactions').set({ status: 'undone' }).where({ uuid, status: 'pending' });
  if (updated.length === 0) {
    logger.debug(`Could not find pending transaction with uuid ${uuid} to mark as undone. It might have been committed or already undone.`);
  }
};

export const readStateFile = async (cwd: string, uuid: string): Promise<StateFile | null> => {
  const db = getDb(cwd);
  const record = await db.query().from('transactions').where({ uuid, status: 'committed' }).first();
  return record ? toStateFile(record) : null;
};

interface ReadStateFilesOptions {
    skipReverts?: boolean;
}

export const readAllStateFiles = async (cwd: string = process.cwd(), options: ReadStateFilesOptions = {}): Promise<StateFile[] | null> => {
    const dbDir = path.join(getStateDirectory(cwd), 'db');
    try {
        await fs.access(dbDir);
    } catch {
        return null; // DB directory does not exist, so not initialized
    }

    const db = getDb(cwd);
    let records = await db.query().from('transactions').where({ status: 'committed' }).all();
    
    if (!records) return [];
    
    let validResults = records.map(toStateFile);

    if (options.skipReverts) {
        const revertedUuids = new Set<string>();
        validResults.forEach(sf => {
            if (isRevertTransaction(sf)) {
                const revertedUuid = getRevertedTransactionUuid(sf);
                if (revertedUuid) {
                    revertedUuids.add(revertedUuid);
                }
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
    const allFiles = await readAllStateFiles(cwd, options);
    return allFiles?.[0] ?? null;
};

export const findStateFileByIdentifier = async (cwd: string, identifier: string, options: ReadStateFilesOptions = {}): Promise<StateFile | null> => {
    if (isUUID(identifier)) {
        // When fetching by UUID, we always return it if committed, regardless of whether it's a revert or not.
        const db = getDb(cwd);
        const record = await db.query().from('transactions').where({ uuid: identifier, status: 'committed' }).first();
        return record ? toStateFile(record) : null;
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