import { logger } from '../utils/logger';
import { FileOperation, StateFile } from '../types';
import { readAllStateFiles } from '../core/state';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const opToString = (op: FileOperation): string => {
    switch (op.type) {
        case 'write': return `write: ${op.path}`;
        case 'delete': return `delete: ${op.path}`;
        case 'rename': return `rename: ${op.from} -> ${op.to}`;
    }
};

export const formatTransactionDetails = (
    tx: StateFile,
    options: { showOperations?: boolean, showSpacing?: boolean } = {}
): string[] => {
    const lines: string[] = [];
    lines.push(`- UUID: ${tx.uuid}`);
    lines.push(`  Date: ${new Date(tx.createdAt).toLocaleString()}`);
    if (tx.reasoning && tx.reasoning.length > 0) {
        lines.push('  Reasoning:');
        tx.reasoning.forEach(r => lines.push(`    - ${r}`));
    }
    if (options.showOperations && tx.operations && tx.operations.length > 0) {
        lines.push('  Changes:');
        tx.operations.forEach(op => lines.push(`    - ${opToString(op)}`));
    }
    if (options.showSpacing) {
        lines.push(''); // Newline for spacing
    }
    return lines;
};

export const logCommand = async (cwd: string = process.cwd(), outputCapture?: string[]): Promise<void> => {
    const log = (message: string) => {
        if (outputCapture) {
            outputCapture.push(message);
        } else {
            logger.log(message);
        }
    };

    const transactions = await readAllStateFiles(cwd);

    if (transactions === null) {
        log(`warn: State directory '${STATE_DIRECTORY_NAME}' not found. No logs to display.`);
        log("info: Run 'relay init' to initialize the project.");
        return;
    }

    if (transactions.length === 0) {
        log('info: No committed transactions found.');
        return;
    }

    transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    log('Committed Transactions (most recent first):');
    log('-------------------------------------------');

    if (transactions.length === 0) {
        log('info: No valid transactions found.');
        return;
    }

    transactions.forEach(tx => {
        formatTransactionDetails(tx, { showOperations: true, showSpacing: true }).forEach(line => log(line));
    });
};