import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import { readStateFile } from '../core/state';
import { restoreSnapshot } from '../core/executor';
import { getConfirmation } from '../utils/prompt';
import { StateFile } from '../types';

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

// This function will find the most recent transaction file
const findLatestTransaction = async (cwd: string): Promise<StateFile | null> => {
    const stateDir = getStateDirectory(cwd);
    try {
        await fs.access(stateDir);
    } catch (e) {
        return null; // No state directory, so no transactions
    }

    const files = await fs.readdir(stateDir);
    const transactionFiles = files.filter(f => f.endsWith('.yml') && !f.endsWith('.pending.yml'));

    if (transactionFiles.length === 0) {
        return null;
    }

    const transactions: StateFile[] = [];
    for (const file of transactionFiles) {
        try {
            // readStateFile expects a UUID, which is the filename without extension
            const stateFile = await readStateFile(cwd, file.replace('.yml', ''));
            if (stateFile) {
                transactions.push(stateFile);
            }
        } catch (error) {
            // Ignore files that can't be parsed, readStateFile should return null but defensive
            logger.debug(`Could not read or parse state file ${file}: ${error}`);
        }
    }

    if (transactions.length === 0) {
        return null;
    }

    // Sort by createdAt date, descending (most recent first)
    transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return transactions[0] || null;
};


export const undoCommand = async (cwd: string = process.cwd()): Promise<void> => {
    logger.info('Attempting to undo the last transaction...');

    const latestTransaction = await findLatestTransaction(cwd);

    if (!latestTransaction) {
        logger.warn('No committed transactions found to undo.');
        return;
    }

    logger.log(`The last transaction to be undone is:`);
    logger.info(`- UUID: ${latestTransaction.uuid}`);
    logger.log(`  Date: ${new Date(latestTransaction.createdAt).toLocaleString()}`);
    if (latestTransaction.reasoning && latestTransaction.reasoning.length > 0) {
        logger.log('  Reasoning:');
        latestTransaction.reasoning.forEach(r => logger.log(`    - ${r}`));
    }
    logger.log('');

    const confirmed = await getConfirmation('Are you sure you want to undo this transaction? (y/N)');

    if (!confirmed) {
        logger.info('Undo operation cancelled.');
        return;
    }
    
    logger.info(`Undoing transaction ${latestTransaction.uuid}...`);

    try {
        await restoreSnapshot(latestTransaction.snapshot, cwd);
        logger.success('  - Successfully restored file snapshot.');

        const stateDir = getStateDirectory(cwd);
        const undoneDir = path.join(stateDir, 'undone');
        await fs.mkdir(undoneDir, { recursive: true });

        const oldPath = path.join(stateDir, `${latestTransaction.uuid}.yml`);
        const newPath = path.join(undoneDir, `${latestTransaction.uuid}.yml`);

        await fs.rename(oldPath, newPath);
        logger.success(`  - Moved transaction file to 'undone' directory.`);
        logger.success(`✅ Last transaction successfully undone.`);

    } catch (error) {
        logger.error(`Failed to undo transaction: ${error instanceof Error ? error.message : String(error)}`);
        logger.error('Your file system may be in a partially restored state. Please check your files.');
    }
};