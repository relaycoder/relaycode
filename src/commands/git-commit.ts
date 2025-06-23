import { findLatestStateFile } from '../core/state';
import { logger } from '../utils/logger';
import { executeShellCommand } from '../utils/shell';
import { getConfirmation as defaultGetConfirmation } from '../utils/prompt';
import { formatTransactionDetails } from './log';

type Prompter = (question: string) => Promise<boolean>;

export const gitCommitCommand = async (cwd: string = process.cwd(), prompter?: Prompter): Promise<void> => {
    const getConfirmation = prompter || defaultGetConfirmation;

    logger.info('Looking for the last transaction to commit...');
    const latestTransaction = await findLatestStateFile(cwd);

    if (!latestTransaction) {
        logger.warn('No committed transactions found.');
        return;
    }

    if (!latestTransaction.gitCommitMsg) {
        logger.warn('The latest transaction does not have a git commit message.');
        logger.log('Transaction details:');
        formatTransactionDetails(latestTransaction, { showSpacing: true }).forEach(line => logger.log(line));
        return;
    }

    logger.log('Found latest transaction with commit message:');
    formatTransactionDetails(latestTransaction).forEach(line => logger.log(line));

    const confirmed = await getConfirmation(`\nDo you want to run 'git add .' and 'git commit -m "${latestTransaction.gitCommitMsg}"'? (y/N)`);
    if (!confirmed) {
        logger.info('Commit operation cancelled.');
        return;
    }

    logger.info("Running 'git add .'...");
    const addResult = await executeShellCommand('git add .', cwd);
    if (addResult.exitCode !== 0) {
        logger.error(`'git add .' failed with exit code ${addResult.exitCode}.`);
        logger.error(addResult.stderr);
        return;
    }
    logger.success("'git add .' completed successfully.");

    const commitCmd = `git commit -m "${latestTransaction.gitCommitMsg}"`;
    logger.info(`Running '${commitCmd}'...`);
    const commitResult = await executeShellCommand(commitCmd, cwd);

    if (commitResult.exitCode !== 0) {
        logger.error(`'git commit' failed with exit code ${commitResult.exitCode}.`);
        logger.error(commitResult.stderr);
        if (commitResult.stdout) logger.log(commitResult.stdout);
        logger.warn('You may need to resolve commit issues manually.');
        return;
    }
    
    logger.success('✅ Git commit successful!');
    logger.log(commitResult.stdout);
};