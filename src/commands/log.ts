import { logger } from '../utils/logger';
import { FileOperation, StateFile } from '../types';
import { readAllStateFiles } from '../core/state';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import chalk from 'chalk';

const opToString = (op: FileOperation): string => {
    switch (op.type) {
        case 'write': return `${chalk.green('write')}:  ${chalk.cyan(op.path)}`;
        case 'delete': return `${chalk.red('delete')}: ${chalk.cyan(op.path)}`;
        case 'rename': return `${chalk.yellow('rename')}: ${chalk.cyan(op.from)} -> ${chalk.cyan(op.to)}`;
    }
};

export const formatTransactionDetails = (
    tx: StateFile,
    options: { showOperations?: boolean, showSpacing?: boolean } = {}
): string[] => {
    const lines: string[] = [];
    lines.push(`- ${chalk.bold('UUID')}: ${chalk.gray(tx.uuid)}`);
    lines.push(`  ${chalk.bold('Date')}: ${new Date(tx.createdAt).toLocaleString()}`);
    if (tx.promptSummary) {
        lines.push(`  ${chalk.bold('Prompt Summary')}: ${tx.promptSummary}`);
    }
    if (tx.gitCommitMsg) {
        lines.push(`  ${chalk.bold('Git Commit')}: "${tx.gitCommitMsg}"`);
    }
    if (tx.reasoning && tx.reasoning.length > 0) {
        lines.push(`  ${chalk.bold('Reasoning')}:`);
        tx.reasoning.forEach(r => lines.push(`    - ${r}`));
    }
    if (options.showOperations && tx.operations && tx.operations.length > 0) {
        lines.push(`  ${chalk.bold('Changes')}:`);
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
        log(`${chalk.yellow('warn')}: State directory '${chalk.cyan(STATE_DIRECTORY_NAME)}' not found. No logs to display.`);
        log(`${chalk.blue('info')}: Run ${chalk.magenta("'relay init'")} to initialize the project.`);
        return;
    }

    if (transactions.length === 0) {
        log(`${chalk.blue('info')}: No committed transactions found.`);
        return;
    }

    log(chalk.bold('Committed Transactions (most recent first):'));
    log(chalk.gray('-------------------------------------------'));

    if (transactions.length === 0) {
        log(`${chalk.blue('info')}: No valid transactions found.`);
        return;
    }

    transactions.forEach(tx => {
        formatTransactionDetails(tx, { showOperations: true, showSpacing: true }).forEach(line => log(line));
    });
};