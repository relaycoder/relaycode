import { Config, ParsedLLMResponse, StateFile, FileSnapshot } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, applyOperations, restoreSnapshot } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';

type Prompter = (question: string) => Promise<boolean>;

type TransactionDependencies = {
  config: Config;
  parsedResponse: ParsedLLMResponse;
  prompter?: Prompter;
};

// This HOF encapsulates the logic for processing a single patch.
const createTransaction = (deps: TransactionDependencies) => {
  const { config, parsedResponse, prompter = getConfirmation } = deps;
  const { control, operations, reasoning } = parsedResponse;
  const { uuid, projectId } = control;

  const affectedFilePaths = operations.map(op => op.path);

  const validate = async (): Promise<boolean> => {
    if (projectId !== config.projectId) {
      logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
      return false;
    }
    if (await hasBeenProcessed(uuid)) {
      logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
      return false;
    }
    return true;
  };
  
  const execute = async (snapshot: FileSnapshot): Promise<void> => {
    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);
    
    // Snapshot is already taken before calling this function
    logger.log('  - Snapshot of affected files taken.');
    
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
        isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
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

      const snapshot = await createSnapshot(affectedFilePaths);

      try {
        await execute(snapshot);
      } catch (error) {
        logger.error(`Transaction ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
        logger.warn('Attempting to roll back from snapshot...');
        await restoreSnapshot(snapshot);
        await deletePendingState(uuid);
        logger.success('Rollback completed due to error.');
      }
    },
  };
};

type ProcessPatchOptions = {
    prompter?: Prompter;
}

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const transaction = createTransaction({ config, parsedResponse, prompter: options?.prompter });
    await transaction.run();
};