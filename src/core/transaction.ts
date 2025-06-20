// src/core/transaction.ts
import { Config, ParsedLLMResponse, StateFile, FileSnapshot } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations, readFileContent } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';

type Prompter = (question: string) => Promise<boolean>;

type TransactionDependencies = {
  config: Config;
  parsedResponse: ParsedLLMResponse;
  prompter?: Prompter;
  cwd: string;
};

type LineChanges = {
    added: number;
    removed: number;
};

// A simple LCS-based diff to calculate line changes.
const calculateLineChanges = (oldContent: string | null, newContent: string): LineChanges => {
    if (oldContent === newContent) return { added: 0, removed: 0 };

    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];

    if (oldContent === null || oldContent === '') return { added: newLines.length, removed: 0 };
    if (newContent === '') return { added: 0, removed: oldLines.length };

    // Simplified line change calculation for better performance
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    
    const added = newLines.filter(line => !oldSet.has(line)).length;
    const removed = oldLines.filter(line => !newSet.has(line)).length;
    
    return { added, removed };
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
  
  const execute = async (snapshot: FileSnapshot, startTime: number): Promise<void> => {
    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);
    
    logger.log(`  - Snapshot of ${Object.keys(snapshot).length} files taken.`);
    
    const stateFile: StateFile = {
      uuid,
      projectId,
      createdAt: new Date().toISOString(),
      reasoning,
      operations,
      snapshot,
      approved: false,
    };
    
    // Prepare state file but don't wait for write to complete yet
    const pendingStatePromise = writePendingState(cwd, stateFile);

    // --- Execution Phase ---
    const opStats: Array<{ type: 'Written' | 'Deleted', path: string, added: number, removed: number }> = [];
    
    try {
      // Wait for pending state write to complete
      await pendingStatePromise;
      logger.success('  - Staged changes to .pending.yml file.');
      
      logger.log('  - Applying file operations...');
      await applyOperations(operations, cwd);
      logger.success('File operations complete.');

      const statPromises = operations.map(async op => {
        const oldContent = snapshot[op.path] ?? null;
        if (op.type === 'write') {
            const newContent = await readFileContent(op.path, cwd);
            const { added, removed } = calculateLineChanges(oldContent, newContent ?? '');
            opStats.push({ type: 'Written', path: op.path, added, removed });
            logger.success(`✔ Written: ${op.path} (+${added}, -${removed})`);
        } else { // op.type === 'delete'
            const { added, removed } = calculateLineChanges(oldContent, '');
            opStats.push({ type: 'Deleted', path: op.path, added, removed });
            logger.success(`✔ Deleted: ${op.path}`);
        }
      });
      await Promise.all(statPromises);
      
    } catch (error) {
      logger.error(`Failed to apply file operations: ${error instanceof Error ? error.message : String(error)}. Rolling back.`);
      try {
        await restoreSnapshot(snapshot, cwd);
        logger.success('  - Files restored to original state.');
      } catch (rollbackError) {
        logger.error(`CRITICAL: Rollback after apply error failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      await deletePendingState(cwd, uuid);
      logger.success(`↩️ Transaction ${uuid} rolled back due to apply error.`);
      return; // Abort transaction
    }

    // --- Verification & Decision Phase ---
    let postCommandFailed = false;
    if (config.postCommand) {
      logger.log(`  - Running post-command: ${config.postCommand}`);
      const postResult = await executeShellCommand(config.postCommand, cwd);
      if (postResult.exitCode !== 0) {
        logger.error(`Post-command failed with exit code ${postResult.exitCode}, forcing rollback.`);
        if (postResult.stderr) logger.error(`Stderr: ${postResult.stderr}`);
        postCommandFailed = true;
      }
    }

    // Run linter check in parallel with postCommand if possible
    const finalErrorCountPromise = config.linter ? getErrorCount(config.linter, cwd) : Promise.resolve(0);
    const finalErrorCount = await finalErrorCountPromise;
    logger.log(`  - Final linter error count: ${finalErrorCount}`);

    let isApproved = false;
    if (postCommandFailed) {
      isApproved = false; // Force rollback
    } else {
      const canAutoApprove = config.approval === 'yes' && finalErrorCount <= config.approvalOnErrorCount;
      if (canAutoApprove) {
          isApproved = true;
          logger.success('  - Changes automatically approved based on your configuration.');
      } else {
          isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
      }
    }
    
    // --- Commit/Rollback Phase ---
    if (isApproved) {
        logger.log('  - Committing changes...');
        const finalState: StateFile = { ...stateFile, approved: true };
        // Update pending state and commit in parallel
        await Promise.all([
          writePendingState(cwd, finalState),
          commitState(cwd, uuid)
        ]);

        const duration = performance.now() - startTime;
        const totalSucceeded = opStats.length;
        const totalFailed = operations.length - totalSucceeded;
        const totalAdded = opStats.reduce((sum, s) => sum + s.added, 0);
        const totalRemoved = opStats.reduce((sum, s) => sum + s.removed, 0);
        
        logger.log('\nSummary:');
        logger.log(`Attempted: ${operations.length} file(s) (${totalSucceeded} succeeded, ${totalFailed} failed)`);
        logger.success(`Lines changed: +${totalAdded}, -${totalRemoved}`);
        logger.log(`Completed in ${duration.toFixed(2)}ms`);

        logger.success(`✅ Transaction ${uuid} committed successfully!`);
    } else {
        logger.warn('  - Rolling back changes...');
        
        try {
            await restoreSnapshot(snapshot, cwd);
            logger.success('  - Files restored to original state.');
            await deletePendingState(cwd, uuid);
            logger.success(`↩️ Transaction ${uuid} rolled back.`);
        } catch (error) {
            logger.error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
  };

  return {
    run: async () => {
      if (!(await validate())) return;

      if (config.preCommand) {
        logger.log(`  - Running pre-command: ${config.preCommand}`);
        const { exitCode, stderr } = await executeShellCommand(config.preCommand, cwd);
        if (exitCode !== 0) {
          logger.error(`Pre-command failed with exit code ${exitCode}, aborting transaction.`);
          if (stderr) logger.error(`Stderr: ${stderr}`);
          return;
        }
      }

      const startTime = performance.now();

      try {
        // Take a snapshot before applying any changes
        logger.log(`Taking snapshot of files that will be affected...`);
        const snapshot = await createSnapshot(affectedFilePaths, cwd);
        
        await execute(snapshot, startTime);
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