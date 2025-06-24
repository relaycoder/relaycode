import { loadConfigOrExit } from '../core/config';
import { findStateFileByIdentifier, readAllStateFiles } from '../core/state';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { FileOperation, ParsedLLMResponse } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { getConfirmation as defaultGetConfirmation } from '../utils/prompt';
import { formatTransactionDetails } from '../utils/formatters';
import chalk from 'chalk';

type Prompter = (question: string) => Promise<boolean>;

export const revertCommand = async (identifier?: string, cwd: string = process.cwd(), prompter?: Prompter): Promise<void> => {
    const getConfirmation = prompter || defaultGetConfirmation;
    const config = await loadConfigOrExit(cwd);

    let targetDescription: string;

    // Default to '1' to revert the latest transaction if no identifier is provided.
    const effectiveIdentifier = identifier ?? '1';

    const isIndexSearch = /^-?\d+$/.test(effectiveIdentifier);

    if (isIndexSearch) {
        const index = Math.abs(parseInt(effectiveIdentifier, 10));
        if (isNaN(index) || index <= 0) {
            logger.error(`Invalid index. Please provide a positive number (e.g., ${chalk.cyan('"1"')} for the latest).`);
            return;
        }
        targetDescription = index === 1 ? 'the latest transaction' : `the ${chalk.cyan(index)}-th latest transaction`;
    } else {
        // We assume it's a UUID, findStateFileByIdentifier will validate
        targetDescription = `transaction with UUID '${chalk.cyan(effectiveIdentifier)}'`;
    }

    logger.info(`Looking for ${targetDescription}...`);
    const stateToRevert = await findStateFileByIdentifier(cwd, effectiveIdentifier);

    if (!stateToRevert) {
        logger.error(`Could not find ${targetDescription}.`);
        if (isIndexSearch) {
            const allTransactions = await readAllStateFiles(cwd); // To give a helpful count
            logger.info(`Only ${chalk.cyan(allTransactions?.length ?? 0)} transactions exist.`);
        }
        return;
    }
    logger.log(chalk.bold(`Transaction to be reverted:`));
    formatTransactionDetails(stateToRevert).forEach(line => logger.log(line));

    const confirmed = await getConfirmation('\nAre you sure you want to revert this transaction? (y/N)');
    if (!confirmed) {
        logger.info('Revert operation cancelled.');
        return;
    }

    // 3. Generate inverse operations
    const inverse_operations = [...stateToRevert.operations]
        .reverse()
        .map((op): FileOperation | null => {
            switch (op.type) {
                case 'rename':
                    return { type: 'rename', from: op.to, to: op.from };
                case 'delete': {
                    const deletedContent = stateToRevert.snapshot[op.path];
                    if (deletedContent === null || typeof deletedContent === 'undefined') {
                        logger.warn(`Cannot revert deletion of ${chalk.cyan(op.path)}, original content not found in snapshot. Skipping.`);
                        return null;
                    }
                    return { type: 'write', path: op.path, content: deletedContent, patchStrategy: 'replace' };
                }
                case 'write': {
                    const originalContent = stateToRevert.snapshot[op.path];
                    if (typeof originalContent === 'undefined') {
                        logger.warn(`Cannot find original state for ${chalk.cyan(op.path)} in snapshot. Skipping revert for this operation.`);
                        return null;
                    }
                    if (originalContent === null) {
                        return { type: 'delete', path: op.path };
                    } else {
                        return { type: 'write', path: op.path, content: originalContent, patchStrategy: 'replace' };
                    }
                }
            }
        })
        .filter((op): op is FileOperation => op !== null);

    if (inverse_operations.length === 0) {
        logger.warn('No operations to revert for this transaction.');
        return;
    }

    // 4. Create and process a new "revert" transaction
    const newUuid = uuidv4();
    const reasoning = [
        `Reverting transaction ${stateToRevert.uuid}.`,
        `Reasoning from original transaction: ${stateToRevert.reasoning.join(' ')}`
    ];

    const parsedResponse: ParsedLLMResponse = {
        control: {
            projectId: config.projectId,
            uuid: newUuid,
        },
        operations: inverse_operations,
        reasoning,
    };

    logger.info(`Creating new transaction ${chalk.gray(newUuid)} to perform the revert.`);
    await processPatch(config, parsedResponse, { cwd, prompter });
};