import { Config, ParsedLLMResponse, StateFile } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, applyOperations, restoreSnapshot } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';

type TransactionDependencies = {
  config: Config;
  parsedResponse: ParsedLLMResponse;
};

// This HOF encapsulates the logic for processing a single patch.
const createTransaction = (deps: TransactionDependencies) => {
  const { config, parsedResponse } = deps;
  const { control, operations, reasoning } = parsedResponse;
  const { uuid, projectId } = control;

  const affectedFilePaths = operations.map(op => op.path);

  const validate = async (): Promise<boolean> => {
    if (projectId !== config.projectId) {
      logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
      return false;
    }
    if (await hasBeenProcessed(uuid)) {
      // This is not a warning because it's expected if you copy the same response twice.
      logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
      return false;
    }
    return true;
  };
  
  const execute = async (): Promise<void> => {
    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);
    
    // --- Staging Phase ---
    logger.log('  - Taking snapshot of affected files...');
    const snapshot = await createSnapshot(affectedFilePaths);
    
    if(config.preCommand) {
      logger.log(`  - Running pre-command: ${config.preCommand}`);
      await executeShellCommand(config.preCommand);
    }
    
    await getErrorCount(config.linter); // Run initial check, primarily for logging.

    const stateFile: StateFile = {
      uuid,
      projectId,
      createdAt: new Date().toISOString(),
      reasoning,
      operations,
      snapshot,
      approved: false,
    };
    await writePendingState(stateFile);
    logger.success('  - Staged changes to .pending.yml file.');

    // --- Execution Phase ---
    logger.log('  - Applying file operations...');
    await applyOperations(operations);
    logger.success('  - File operations applied.');

    // --- Verification & Decision Phase ---
    if(config.postCommand) {
      logger.log(`  - Running post-command: ${config.postCommand}`);
      await executeShellCommand(config.postCommand);
    }
    const finalErrorCount = await getErrorCount(config.linter);
    logger.log(`  - Final linter error count: ${finalErrorCount}`);

    let isApproved = false;
    const canAutoApprove = config.approval === 'yes' && finalErrorCount <= config.approvalOnErrorCount;

    if (canAutoApprove) {
        isApproved = true;
        logger.success('  - Changes automatically approved based on your configuration.');
    } else {
        isApproved = await getConfirmation('Changes applied. Do you want to approve and commit them? (y/N)');
    }
    
    // --- Commit/Rollback Phase ---
    if (isApproved) {
        logger.log('  - Committing changes...');
        const finalState: StateFile = { ...stateFile, approved: true };
        await writePendingState(finalState); 
        await commitState(uuid);
        logger.success(`✅ Transaction ${uuid} committed successfully!`);
    } else {
        logger.warn('  - Rolling back changes...');
        await restoreSnapshot(snapshot);
        await deletePendingState(uuid);
        logger.success(`↩️ Transaction ${uuid} rolled back.`);
    }
  };

  return {
    run: async () => {
      if (!(await validate())) return;

      try {
        await execute();
      } catch (error) {
        logger.error(`Transaction ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
        logger.warn('Attempting to roll back from snapshot...');
        const snapshot = await createSnapshot(affectedFilePaths); // Re-create snapshot just in case it failed before writing
        await restoreSnapshot(snapshot);
        await deletePendingState(uuid);
        logger.success('Rollback attempted.');
      }
    },
  };
};

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse): Promise<void> => {
    const transaction = createTransaction({ config, parsedResponse });
    await transaction.run();
};