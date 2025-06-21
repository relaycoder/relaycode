import { logger } from '../utils/logger';
import { FileOperation } from '../types';
import { readAllStateFiles } from '../core/state';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const opToString = (op: FileOperation): string => {
    switch (op.type) {
        case 'write': return `write: ${op.path}`;
        case 'delete': return `delete: ${op.path}`;
        case 'rename': return `rename: ${op.from} -> ${op.to}`;
    }
};

export const logCommand = async (cwd: string = process.cwd()): Promise<void> => {
    const transactions = await readAllStateFiles(cwd);

    if (transactions === null) {
        logger.warn(`State directory '${STATE_DIRECTORY_NAME}' not found. No logs to display.`);
        logger.info("Run 'relay init' to initialize the project.");
        return;
    }

    if (transactions.length === 0) {
        logger.info('No committed transactions found.');
        return;
    }

    transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    logger.log('Committed Transactions (most recent first):');
    logger.log('-------------------------------------------');

    if (transactions.length === 0) {
        logger.info('No valid transactions found.');
        return;
    }

    transactions.forEach(tx => {
        logger.info(`- UUID: ${tx.uuid}`);
        logger.log(`  Date: ${new Date(tx.createdAt).toLocaleString()}`);
        if (tx.reasoning && tx.reasoning.length > 0) {
            logger.log('  Reasoning:');
            tx.reasoning.forEach(r => logger.log(`    - ${r}`));
        }
        if (tx.operations && tx.operations.length > 0) {
            logger.log('  Changes:');
            tx.operations.forEach(op => logger.log(`    - ${opToString(op)}`));
        }
        logger.log(''); // Newline for spacing
    });
};