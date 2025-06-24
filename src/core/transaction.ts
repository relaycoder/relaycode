import { Config, ParsedLLMResponse, StateFile, FileSnapshot, FileOperation } from '../types';
import { logger, getErrorMessage } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations } from './executor';
import chalk from 'chalk';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt'
import { requestApprovalWithNotification, notifyFailure, notifySuccess, notifyPatchDetected } from '../utils/notifier';

type Prompter = (question: string) => Promise<boolean>;

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
    notifyOnStart?: boolean;
    yes?: boolean;
};

const countLineDiff = (baseLines: string[], newLines: string[]): number => {
    const baseSet = new Set(baseLines);
    let diff = 0;
    for (const line of newLines) {
        if (!baseSet.has(line)) diff++;
    }
    return diff;
}

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
    return {
        added: countLineDiff(oldLines, newLines),
        removed: countLineDiff(newLines, oldLines),
    };
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

const rollbackTransaction = async (cwd: string, uuid: string, snapshot: FileSnapshot, reason: string, enableNotifications: boolean = true, isError: boolean = true): Promise<void> => {
    if (isError) {
        logger.warn(`Rolling back changes: ${reason}`);
    }
    try {
        await restoreSnapshot(snapshot, cwd);
        logger.success('  - Files restored to original state.');
    } catch (error) {
        logger.error(`Fatal: Rollback failed: ${getErrorMessage(error)}`);
        // Do not rethrow; we're already in a final error handling state.
    } finally {
        try {
            await deletePendingState(cwd, uuid);
            logger.info(`↩️ Transaction ${chalk.gray(uuid)} rolled back.`);
            if (isError) {
                notifyFailure(uuid, enableNotifications);
            }
        } catch (cleanupError) {
            logger.error(`Fatal: Could not clean up pending state for ${chalk.gray(uuid)}: ${getErrorMessage(cleanupError)}`);
        }
    }
};

type ApprovalOptions = {
    config: Config;
    cwd: string;
    prompter: Prompter;
    skipConfirmation: boolean;
}

const handleApproval = async ({ config, cwd, prompter, skipConfirmation }: ApprovalOptions): Promise<boolean> => {
    const finalErrorCount = await getErrorCount(config.patch.linter, cwd);
    logger.log(`  - Final linter error count: ${finalErrorCount > 0 ? chalk.red(finalErrorCount) : chalk.green(finalErrorCount)}`);
    
    const getManualApproval = async (reason: string): Promise<boolean> => {
        logger.warn(reason);
        
        const notificationResult = await requestApprovalWithNotification(config.projectId, config.core.enableNotifications);

        if (notificationResult === 'approved') {
            logger.info('Approved via notification.');
            return true;
        }
        if (notificationResult === 'rejected') {
            logger.info('Rejected via notification.');
            return false;
        }

        if (notificationResult === 'timeout') {
            logger.info('Notification timed out or was dismissed. Please use the terminal to respond.');
        }

        return await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
    };

    if (skipConfirmation) {
        logger.success('  - Changes approved via -y/--yes flag.');
        return true;
    }
    if (config.patch.approvalMode === 'manual') {
        return await getManualApproval('Manual approval required because "approvalMode" is set to "manual".');
    }
    // auto mode
    const canAutoApprove = finalErrorCount <= config.patch.approvalOnErrorCount;
    if (canAutoApprove) {
        logger.success('  - Changes automatically approved based on your configuration.');
        return true;
    }
    return await getManualApproval(`Manual approval required: Linter found ${finalErrorCount} error(s) (threshold is ${config.patch.approvalOnErrorCount}).`);
};

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const cwd = options?.cwd || process.cwd();
    const prompter = options?.prompter || getConfirmation;
    const skipConfirmation = options?.yes === true;
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
        notifyPatchDetected(config.projectId, config.core.enableNotifications);
        logger.success(`Valid patch detected for project '${chalk.cyan(config.projectId)}'. Processing...`);
    }

    // 2. Pre-flight checks
    if (config.patch.preCommand) {
        logger.log(`  - Running pre-command: ${chalk.magenta(config.patch.preCommand)}`);
        const { exitCode, stderr } = await executeShellCommand(config.patch.preCommand, cwd);
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
        if (config.patch.postCommand) {
            logger.log(`  - Running post-command: ${chalk.magenta(config.patch.postCommand)}`);
            const postResult = await executeShellCommand(config.patch.postCommand, cwd);
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

        const isApproved = await handleApproval({ config, cwd, prompter, skipConfirmation });

        if (isApproved) {
            stateFile.approved = true;
            await writePendingState(cwd, stateFile); // Update state with approved: true before commit
            await commitState(cwd, uuid);
            logCompletionSummary(uuid, startTime, operations);
            notifySuccess(uuid, config.core.enableNotifications);
            await handleAutoGitBranch(config, stateFile, cwd);
        } else {
            logger.warn('Operation cancelled by user. Rolling back changes...');
            await rollbackTransaction(cwd, uuid, snapshot, 'User cancellation', config.core.enableNotifications, false);
        }
    } catch (error) {
        const reason = getErrorMessage(error);
        await rollbackTransaction(cwd, uuid, snapshot, reason, config.core.enableNotifications, true);
    }
};

const handleAutoGitBranch = async (config: Config, stateFile: StateFile, cwd: string): Promise<void> => {
    if (!config.git.autoGitBranch) return;

    let branchNameSegment = '';
    if (config.git.gitBranchTemplate === 'gitCommitMsg' && stateFile.gitCommitMsg) {
        branchNameSegment = stateFile.gitCommitMsg;
    } else {
        branchNameSegment = stateFile.uuid;
    }

    const sanitizedSegment = branchNameSegment
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove all non-word, non-space, non-hyphen chars
        .replace(/[\s_]+/g, '-') // Replace spaces and underscores with a single hyphen
        .replace(/-+/g, '-') // Collapse consecutive hyphens
        .replace(/^-|-$/g, '') // Trim leading/trailing hyphens
        .slice(0, 70); // Truncate

    if (sanitizedSegment) {
        const branchName = `${config.git.gitBranchPrefix}${sanitizedSegment}`;
        logger.info(`Creating and switching to new git branch: ${chalk.magenta(branchName)}`);
        const command = `git checkout -b "${branchName}"`;
        const result = await executeShellCommand(command, cwd);
        if (result.exitCode === 0) {
            logger.success(`Successfully created and switched to branch '${chalk.magenta(branchName)}'.`);
        } else {
            // Exit code 128 from `git checkout -b` often means the branch already exists.
            if (result.exitCode === 128 && result.stderr.includes('already exists')) {
                logger.warn(`Could not create branch '${chalk.magenta(branchName)}' because it already exists.`);
            } else {
                logger.warn(`Could not create git branch '${chalk.magenta(branchName)}'.`);
            }
            logger.debug(`'${command}' failed with: ${result.stderr}`);
        }
    } else {
        logger.warn('Could not generate a branch name segment from commit message or UUID. Skipping git branch creation.');
    }
};
