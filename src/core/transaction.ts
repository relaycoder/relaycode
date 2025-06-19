import { Config, ParsedLLMResponse, StateFile, FileSnapshot } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, applyOperations, restoreSnapshot } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';
import path from 'path';

type Prompter = (question: string) => Promise<boolean>;

type TransactionDependencies = {
  config: Config;
  parsedResponse: ParsedLLMResponse;
  prompter?: Prompter;
  cwd: string;
};

// This HOF encapsulates the logic for processing a single patch.
const createTransaction = (deps: TransactionDependencies) => {
  const { config, parsedResponse, prompter = getConfirmation, cwd } = deps;
  const { control, operations, reasoning } = parsedResponse;
  const { uuid, projectId } = control;

  // Get file paths that will be affected
  const affectedFilePaths = operations.map(op => op.path);

  const validate = async (): Promise<boolean> => {
    if (projectId !== config.projectId) {
      logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
      return false;
    }
    if (await hasBeenProcessed(cwd, uuid)) {
      logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
      return false;
    }
    return true;
  };
  
  const execute = async (snapshot: FileSnapshot): Promise<void> => {
    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);
    
    // Log the snapshot for debugging
    logger.log(`  - Snapshot of ${Object.keys(snapshot).length} files taken.`);
    
    if(config.preCommand) {
      logger.log(`  - Running pre-command: ${config.preCommand}`);
      await executeShellCommand(config.preCommand, cwd);
    }
    
    const initialErrorCount = await getErrorCount(config.linter, cwd);

    const stateFile: StateFile = {
      uuid,
      projectId,
      createdAt: new Date().toISOString(),
      reasoning,
      operations,
      snapshot,
      approved: false,
    };
    await writePendingState(cwd, stateFile);
    logger.success('  - Staged changes to .pending.yml file.');

    // --- Execution Phase ---
    logger.log('  - Applying file operations...');
    await applyOperations(operations, cwd);
    logger.success('  - File operations applied.');

    // --- Verification & Decision Phase ---
    if(config.postCommand) {
      logger.log(`  - Running post-command: ${config.postCommand}`);
      await executeShellCommand(config.postCommand, cwd);
    }
    const finalErrorCount = await getErrorCount(config.linter, cwd);
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
        await writePendingState(cwd, finalState); 
        await commitState(cwd, uuid);
        logger.success(`✅ Transaction ${uuid} committed successfully!`);
    } else {
        logger.warn('  - Rolling back changes...');
        
        // Debug log for each file in the snapshot
        for (const [filePath, content] of Object.entries(snapshot)) {
            logger.log(`    - Restoring ${filePath} to ${content === null ? 'non-existence' : 'original content'}`);
        }
        
        try {
            await restoreSnapshot(snapshot, cwd);
            logger.success('  - Files restored to original state.');
            await deletePendingState(cwd, uuid);
            logger.success(`↩️ Transaction ${uuid} rolled back.`);
            
            // Verify files were properly restored
            for (const filePath of affectedFilePaths) {
                const originalContent = snapshot[filePath];
                const fullPath = path.resolve(cwd, filePath);
                
                try {
                    const currentContent = await Bun.file(fullPath).text();
                    if (originalContent !== null && currentContent !== originalContent) {
                        logger.warn(`    - Failed to restore ${filePath} to original content`);
                    }
                } catch (err) {
                    if (originalContent !== null) {
                        logger.warn(`    - Failed to verify restored content for ${filePath}`);
                    }
                }
            }
        } catch (error) {
            logger.error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
  };

  return {
    run: async () => {
      if (!(await validate())) return;

      try {
        // Take a snapshot before applying any changes
        logger.log(`Taking snapshot of files that will be affected...`);
        const snapshot = await createSnapshot(affectedFilePaths, cwd);
        
        await execute(snapshot);
      } catch (error) {
        logger.error(`Transaction ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
};

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
}

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const cwd = options?.cwd || process.cwd();
    const transaction = createTransaction({ config, parsedResponse, prompter: options?.prompter, cwd });
    await transaction.run();
};