import { loadConfigOrExit } from '../core/config';
import { readStateFile, readAllStateFiles } from '../core/state';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { FileOperation, ParsedLLMResponse, StateFile } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { getConfirmation as defaultGetConfirmation } from '../utils/prompt';
import { formatTransactionDetails } from './log';

type Prompter = (question: string) => Promise<boolean>;

const isUUID = (str: string): boolean => {
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
};

export const revertCommand = async (identifier?: string, cwd: string = process.cwd(), prompter?: Prompter): Promise<void> => {
    const getConfirmation = prompter || defaultGetConfirmation;
    const config = await loadConfigOrExit(cwd);

    let stateToRevert: StateFile | null = null;
    let targetDescription: string;

    // Default to '1' to revert the latest transaction if no identifier is provided.
    const effectiveIdentifier = identifier ?? '1';

    if (isUUID(effectiveIdentifier)) {
        targetDescription = `transaction with UUID '${effectiveIdentifier}'`;
        logger.info(`Attempting to revert ${targetDescription}`);
        stateToRevert = await readStateFile(cwd, effectiveIdentifier);
    } else if (/^-?\d+$/.test(effectiveIdentifier)) {
        const index = Math.abs(parseInt(effectiveIdentifier, 10));
        if (isNaN(index) || index <= 0) {
            logger.error('Invalid index. Please provide a positive number (e.g., "1" for the latest).');
            return;
        }
        targetDescription = index === 1 ? 'the latest transaction' : `the ${index}-th latest transaction`;
        logger.info(`Looking for ${targetDescription}...`);
        const allTransactions = await readAllStateFiles(cwd);
        if (!allTransactions || allTransactions.length < index) {
            logger.error(`Transaction not found. Only ${allTransactions?.length ?? 0} transactions exist.`);
            return;
        }
        stateToRevert = allTransactions[index - 1] ?? null;
    } else {
        logger.error(`Invalid identifier: '${identifier}'. Please provide a UUID or an index (e.g., '1' for the latest).`);
        return;
    }

    if (!stateToRevert) {
        logger.error(`Could not find ${targetDescription}.`);
        return;
    }

    logger.log(`Transaction to be reverted:`);
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
                        logger.warn(`Cannot revert deletion of ${op.path}, original content not found in snapshot. Skipping.`);
                        return null;
                    }
                    return { type: 'write', path: op.path, content: deletedContent, patchStrategy: 'replace' };
                }
                case 'write': {
                    const originalContent = stateToRevert.snapshot[op.path];
                    if (typeof originalContent === 'undefined') {
                        logger.warn(`Cannot find original state for ${op.path} in snapshot. Skipping revert for this operation.`);
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

    logger.info(`Creating new transaction ${newUuid} to perform the revert.`);
    await processPatch(config, parsedResponse, { cwd, prompter });
};