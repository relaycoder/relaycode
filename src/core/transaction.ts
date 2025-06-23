import { Config, ParsedLLMResponse, StateFile, FileSnapshot, FileOperation } from '../types';
import { logger, getErrorMessage } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations } from './executor';
import chalk from 'chalk';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt'
import { notifyApprovalRequired, notifyFailure, notifySuccess, notifyPatchDetected } from '../utils/notifier';

type Prompter = (question: string) => Promise<boolean>;

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
    notifyOnStart?: boolean;
};

const calculateLineChanges = (
    op: FileOperation,
    snapshot: FileSnapshot,
    newContents: Map<string, string>
): { added: number; removed: number } => {
    if (op.type === 'rename') {
        return { added: 0, removed: 0 };
    }
    const oldContent = snapshot[op.path] ?? null;

    if (op.type === 'delete') {
        const oldLines = oldContent ? oldContent.split('\n') : [];
        return { added: 0, removed: oldLines.length };
    }
    
    const newContent = newContents.get(op.path) ?? null;

    if (oldContent === newContent) return { added: 0, removed: 0 };

    const oldLines = oldContent?.split('\n') ?? [];
    const newLines = newContent?.split('\n') ?? [];

    if (oldContent === null || oldContent === '') return { added: newLines.length, removed: 0 };
    if (newContent === null || newContent === '') return { added: 0, removed: oldLines.length };
    
    // This is a simplified diff, for a more accurate count a real diff algorithm is needed,
    // but this is fast and good enough for a summary.
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    
    let added = 0;
    for (const line of newLines) {
        if (!oldSet.has(line)) added++;
    }

    let removed = 0;
    for (const line of oldLines) {
        if (!newSet.has(line)) removed++;
    }
    
    return { added, removed };
};

const logCompletionSummary = (
    uuid: string,
    startTime: number,
    operations: FileOperation[]
) => {
    const duration = performance.now() - startTime;

    logger.log(chalk.bold('\nSummary:'));
    logger.log(`Applied ${chalk.cyan(operations.length)} file operation(s) successfully.`);
    logger.log(`Total time from start to commit: ${chalk.gray(`${duration.toFixed(2)}ms`)}`);
    logger.success(`✅ Transaction ${chalk.gray(uuid)} committed successfully!`);
};

const rollbackTransaction = async (cwd: string, uuid: string, snapshot: FileSnapshot, reason: string, enableNotifications: boolean = true): Promise<void> => {
    logger.warn(`Rolling back changes: ${reason}`);
    try {
        await restoreSnapshot(snapshot, cwd);
        logger.success('  - Files restored to original state.');
    } catch (error) {
        logger.error(`Fatal: Rollback failed: ${getErrorMessage(error)}`);
        // Do not rethrow; we're already in a final error handling state.
    } finally {
        try {
            await deletePendingState(cwd, uuid);
            logger.success(`↩️ Transaction ${chalk.gray(uuid)} rolled back.`);
            notifyFailure(uuid, enableNotifications);
        } catch (cleanupError) {
            logger.error(`Fatal: Could not clean up pending state for ${chalk.gray(uuid)}: ${getErrorMessage(cleanupError)}`);
        }
    }
};

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const cwd = options?.cwd || process.cwd();
    const prompter = options?.prompter || getConfirmation;
    const notifyOnStart = options?.notifyOnStart ?? false;
    const { control, operations, reasoning } = parsedResponse;
    const { uuid, projectId } = control;
    const startTime = performance.now();

    // 1. Validation
    if (projectId !== config.projectId) {
        logger.warn(`Skipping patch: projectId mismatch (expected '${chalk.cyan(config.projectId)}', got '${chalk.cyan(projectId)}').`);
        return;
    }
    if (await hasBeenProcessed(cwd, uuid)) {
        logger.info(`Skipping patch: uuid '${chalk.gray(uuid)}' has already been processed.`);
        return;
    }

    // Notify if coming from watch mode, now that we know it's a new patch.
    if (notifyOnStart) {
        notifyPatchDetected(config.projectId, config.enableNotifications);
        logger.success(`Valid patch detected for project '${chalk.cyan(config.projectId)}'. Processing...`);
    }

    // 2. Pre-flight checks
    if (config.preCommand) {
        logger.log(`  - Running pre-command: ${chalk.magenta(config.preCommand)}`);
        const { exitCode, stderr } = await executeShellCommand(config.preCommand, cwd);
        if (exitCode !== 0) {
            logger.error(`Pre-command failed with exit code ${chalk.red(exitCode)}, aborting transaction.`);
            if (stderr) logger.error(`Stderr: ${stderr}`);
            return;
        }
    }

    logger.info(`🚀 Starting transaction for patch ${chalk.gray(uuid)}...`);
    logger.log(`${chalk.bold('Reasoning:')}\n  ${reasoning.join('\n  ')}`);

    const affectedFilePaths = operations.reduce<string[]>((acc, op) => {
        if (op.type === 'rename') {
            acc.push(op.from, op.to);
        } else {
            acc.push(op.path);
        }
        return acc;
    }, []);
    const snapshot = await createSnapshot(affectedFilePaths, cwd);
    
    const stateFile: StateFile = {
        uuid,
        projectId,
        createdAt: new Date().toISOString(),
        gitCommitMsg: control.gitCommitMsg,
        promptSummary: control.promptSummary,
        reasoning,
        operations,
        snapshot,
        approved: false,
    };

    try {
        await writePendingState(cwd, stateFile);
        logger.success('  - Staged changes to .pending.yml file.');

        // Apply changes
        logger.log('  - Applying file operations...');
        const newContents = await applyOperations(operations, cwd);
        logger.success('  - File operations complete.');

        const opStats = operations.map(op => {
            const stats = calculateLineChanges(op, snapshot, newContents);
            if (op.type === 'write') {
                logger.success(`✔ Written: ${chalk.cyan(op.path)} (${chalk.green(`+${stats.added}`)}, ${chalk.red(`-${stats.removed}`)})`);
            } else if (op.type === 'delete') {
                logger.success(`✔ Deleted: ${chalk.cyan(op.path)}`);
            } else if (op.type === 'rename') {
                logger.success(`✔ Renamed: ${chalk.cyan(op.from)} -> ${chalk.cyan(op.to)}`);
            }
            return stats;
        });

        // Run post-command
        if (config.postCommand) {
            logger.log(`  - Running post-command: ${chalk.magenta(config.postCommand)}`);
            const postResult = await executeShellCommand(config.postCommand, cwd);
            if (postResult.exitCode !== 0) {
                logger.error(`Post-command failed with exit code ${chalk.red(postResult.exitCode)}.`);
                if (postResult.stderr) logger.error(`Stderr: ${postResult.stderr}`);
                throw new Error('Post-command failed, forcing rollback.');
            }
        }

        // Log summary before asking for approval
        const checksDuration = performance.now() - startTime;
        const totalAdded = opStats.reduce((sum, s) => sum + s.added, 0);
        const totalRemoved = opStats.reduce((sum, s) => sum + s.removed, 0);

        logger.log(chalk.bold('\nPre-flight summary:'));
        logger.success(`Lines changed: ${chalk.green(`+${totalAdded}`)}, ${chalk.red(`-${totalRemoved}`)}`);
        logger.log(`Checks completed in ${chalk.gray(`${checksDuration.toFixed(2)}ms`)}`);

        // Check for approval
        const finalErrorCount = await getErrorCount(config.linter, cwd);
        logger.log(`  - Final linter error count: ${finalErrorCount > 0 ? chalk.red(finalErrorCount) : chalk.green(finalErrorCount)}`);
        
        let isApproved: boolean;
        if (config.approvalMode === 'auto') { // Auto mode allows conditional auto-approval
            const canAutoApprove = finalErrorCount <= config.approvalOnErrorCount;

            if (canAutoApprove) {
                logger.success('  - Changes automatically approved based on your configuration.');
                isApproved = true;
            } else {
                notifyApprovalRequired(config.projectId, config.enableNotifications);
                isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
            }
        } else { // Manual mode always requires user approval
            logger.warn('Manual approval required because "approvalMode" is set to "manual".');
            notifyApprovalRequired(config.projectId, config.enableNotifications);
            isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
        }

        if (isApproved) {
            stateFile.approved = true;
            await writePendingState(cwd, stateFile); // Update state with approved: true before commit
            await commitState(cwd, uuid);
            logCompletionSummary(uuid, startTime, operations);
            notifySuccess(uuid, config.enableNotifications);
        } else {
            throw new Error('Changes were not approved.');
        }
    } catch (error) {
        const reason = getErrorMessage(error);
        await rollbackTransaction(cwd, uuid, snapshot, reason, config.enableNotifications);
    }
};