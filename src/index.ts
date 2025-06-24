// Core logic
export { createClipboardWatcher } from './core/clipboard';
export { findConfig, createConfig, getProjectId, ensureStateDirExists, loadConfigOrExit, findConfigPath } from './core/config';
export {
    applyOperations,
    createSnapshot,
    deleteFile,
    readFileContent,
    restoreSnapshot,
    writeFileContent,
    fileExists,
    renameFile
} from './core/executor';
export { parseLLMResponse } from './core/parser';
export {
    commitState,
    deletePendingState,
    hasBeenProcessed,
    findLatestStateFile,
    findStateFileByIdentifier,
    readStateFile,
    readAllStateFiles,
    writePendingState,
    getStateFilePath,
    getUndoneStateFilePath
} from './core/state';
export { processPatch } from './core/transaction';

// Commands
export { initCommand } from './commands/init';
export { watchCommand } from './commands/watch';
export { logCommand } from './commands/log';
export { revertCommand } from './commands/revert';
export { applyCommand } from './commands/apply';
export { gitCommitCommand } from './commands/git-commit';

// Types
export * from './types';

// Utils
export { executeShellCommand, getErrorCount } from './utils/shell';
export { logger, getErrorMessage, isEnoentError } from './utils/logger';
export { getConfirmation } from './utils/prompt';
export { formatTransactionDetails } from './utils/formatters';
export {
    createNotifier,
    notifyPatchDetected,
    notifyApprovalRequired,
    notifySuccess,
    notifyFailure,
} from './utils/notifier';
export { STATE_DIRECTORY_NAME, CONFIG_FILE_NAMES } from './utils/constants';