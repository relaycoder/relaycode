import { loadConfigOrExit } from '../core/config';
import { readStateFile } from '../core/state';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { FileOperation, ParsedLLMResponse } from '../types';
import { v4 as uuidv4 } from 'uuid';

export const revertCommand = async (uuidToRevert: string): Promise<void> => {
    const cwd = process.cwd();

    const config = await loadConfigOrExit(cwd);

    // 2. Load the state file for the transaction to revert
    logger.info(`Attempting to revert transaction: ${uuidToRevert}`);
    const stateToRevert = await readStateFile(cwd, uuidToRevert);
    if (!stateToRevert) {
        logger.error(`Transaction with UUID '${uuidToRevert}' not found or is invalid.`);
        return;
    }

    // 3. Generate inverse operations
    const inverse_operations: FileOperation[] = [];
    // Process operations in reverse order to handle dependencies correctly
    for (const op of [...stateToRevert.operations].reverse()) {
        switch (op.type) {
            case 'rename':
                inverse_operations.push({ type: 'rename', from: op.to, to: op.from });
                break;
            case 'delete':
                const deletedContent = stateToRevert.snapshot[op.path];
                if (deletedContent === null || typeof deletedContent === 'undefined') {
                    logger.warn(`Cannot revert deletion of ${op.path}, original content not found in snapshot. Skipping.`);
                    continue;
                }
                inverse_operations.push({
                    type: 'write',
                    path: op.path,
                    content: deletedContent,
                    patchStrategy: 'replace',
                });
                break;
            case 'write':
                const originalContent = stateToRevert.snapshot[op.path];
                if (typeof originalContent === 'undefined') {
                    logger.warn(`Cannot find original state for ${op.path} in snapshot. Skipping revert for this operation.`);
                    continue;
                }
                if (originalContent === null) {
                    // This was a new file. The inverse is to delete it.
                    inverse_operations.push({ type: 'delete', path: op.path });
                } else {
                    // This was a file modification. The inverse is to restore original content.
                    inverse_operations.push({
                        type: 'write',
                        path: op.path,
                        content: originalContent,
                        patchStrategy: 'replace',
                    });
                }
                break;
        }
    }

    if (inverse_operations.length === 0) {
        logger.warn('No operations to revert for this transaction.');
        return;
    }

    // 4. Create and process a new "revert" transaction
    const newUuid = uuidv4();
    const reasoning = [
        `Reverting transaction ${uuidToRevert}.`,
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
    await processPatch(config, parsedResponse, { cwd });
};