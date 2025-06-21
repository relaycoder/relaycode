// Core logic
export { createClipboardWatcher } from './core/clipboard';
export { findConfig, createConfig, getProjectId, ensureStateDirExists, loadConfigOrExit } from './core/config';
export { 
    applyOperations, 
    createSnapshot, 
    deleteFile, 
    readFileContent, 
    restoreSnapshot, 
    writeFileContent 
} from './core/executor';
export { parseLLMResponse } from './core/parser';
export { 
    commitState,
    deletePendingState,
    hasBeenProcessed,
    findLatestStateFile,
    readStateFile,
    readAllStateFiles,
    writePendingState
} from './core/state';
export { processPatch } from './core/transaction';

// Types
export * from './types';

// Utils
export { executeShellCommand, getErrorCount } from './utils/shell';
export { logger } from './utils/logger';
export { getConfirmation } from './utils/prompt';