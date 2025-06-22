import { promises as fs } from 'fs';
import path from 'path';
import { logger, getErrorMessage } from '../utils/logger';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import { findLatestStateFile } from '../core/state';
import { restoreSnapshot } from '../core/executor';
import { getConfirmation as defaultGetConfirmation } from '../utils/prompt';
import { formatTransactionDetails } from './log';

type Prompter = (question: string) => Promise<boolean>;

export const undoCommand = async (cwd: string = process.cwd(), prompter?: Prompter): Promise<void> => {
    const getConfirmation = prompter || defaultGetConfirmation;
    logger.info('Attempting to undo the last transaction...');

    const latestTransaction = await findLatestStateFile(cwd);

    if (!latestTransaction) {
        logger.warn('No committed transactions found to undo.');
        return;
    }

    const [uuidLine, ...otherLines] = formatTransactionDetails(latestTransaction, { showSpacing: true });
    logger.log(`The last transaction to be undone is:`);
    if (uuidLine) {
        logger.info(uuidLine); // UUID line with info color
    }
    otherLines.forEach(line => logger.log(line));

    const confirmed = await getConfirmation('Are you sure you want to undo this transaction? (y/N)');

    if (!confirmed) {
        logger.info('Undo operation cancelled.');
        return;
    }
    
    logger.info(`Undoing transaction ${latestTransaction.uuid}...`);

    try {
        await restoreSnapshot(latestTransaction.snapshot, cwd);
        logger.success('  - Successfully restored file snapshot.');

        const stateDir = path.resolve(cwd, STATE_DIRECTORY_NAME);
        const undoneDir = path.join(stateDir, 'undone');
        await fs.mkdir(undoneDir, { recursive: true });

        const oldPath = path.join(stateDir, `${latestTransaction.uuid}.yml`);
        const newPath = path.join(undoneDir, `${latestTransaction.uuid}.yml`);

        await fs.rename(oldPath, newPath);
        logger.success(`  - Moved transaction file to 'undone' directory.`);
        logger.success(`✅ Last transaction successfully undone.`);

    } catch (error) {
        logger.error(`Failed to undo transaction: ${getErrorMessage(error)}`);
        logger.error('Your file system may be in a partially restored state. Please check your files.');
    }
};