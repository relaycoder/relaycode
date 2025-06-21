import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { logger } from '../utils/logger';
import { StateFile, StateFileSchema, FileOperation } from '../types';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

const opToString = (op: FileOperation): string => {
    switch (op.type) {
        case 'write': return `write: ${op.path}`;
        case 'delete': return `delete: ${op.path}`;
        case 'rename': return `rename: ${op.from} -> ${op.to}`;
    }
};

export const logCommand = async (cwd: string = process.cwd()): Promise<void> => {
    const stateDir = getStateDirectory(cwd);
    try {
        await fs.access(stateDir);
    } catch (e) {
        logger.warn(`State directory '${STATE_DIRECTORY_NAME}' not found. No logs to display.`);
        logger.info("Run 'relay init' to initialize the project.");
        return;
    }

    const files = await fs.readdir(stateDir);
    const transactionFiles = files.filter(f => f.endsWith('.yml') && !f.endsWith('.pending.yml'));

    if (transactionFiles.length === 0) {
        logger.info('No committed transactions found.');
        return;
    }

    const transactions: StateFile[] = [];
    for (const file of transactionFiles) {
        try {
            const filePath = path.join(stateDir, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const data = yaml.load(content);
            const stateFile = StateFileSchema.parse(data);
            transactions.push(stateFile);
        } catch (error) {
            logger.warn(`Could not parse state file ${file}. Skipping. Error: ${error instanceof Error ? error.message : String(error)}`);
        }
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