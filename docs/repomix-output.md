# Directory Structure
```
package.json
relaycode.config.json
src/cli.ts
src/commands/apply.ts
src/commands/init.ts
src/commands/log.ts
src/commands/revert.ts
src/commands/undo.ts
src/commands/watch.ts
src/core/clipboard.ts
src/core/config.ts
src/core/executor.ts
src/core/parser.ts
src/core/state.ts
src/core/transaction.ts
src/index.ts
src/types.ts
src/utils/constants.ts
src/utils/logger.ts
src/utils/notifier.ts
src/utils/prompt.ts
src/utils/shell.ts
tsconfig.json
```

# Files

## File: src/utils/constants.ts
````typescript
export const CONFIG_FILE_NAME = 'relaycode.config.json';
export const STATE_DIRECTORY_NAME = '.relaycode';
export const GITIGNORE_FILE_NAME = '.gitignore';

export const CODE_BLOCK_START_MARKER = '// START';
export const CODE_BLOCK_END_MARKER = '// END';
export const DELETE_FILE_MARKER = '//TODO: delete this file';
````

## File: src/utils/prompt.ts
````typescript
import { logger } from './logger';

export const getConfirmation = (question: string): Promise<boolean> => {
  return new Promise(resolve => {
    logger.prompt(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const onData = (text: string) => {
      const cleanedText = text.trim().toLowerCase();
      if (cleanedText === 'y' || cleanedText === 'yes') {
        resolve(true);
      } else {
        resolve(false);
      }
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
  });
};
````

## File: src/commands/apply.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfigOrExit } from '../core/config';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';

export const applyCommand = async (filePath: string, cwd: string = process.cwd()): Promise<void> => {
    const config = await loadConfigOrExit(cwd);
    logger.setLevel(config.logLevel);

    let content: string;
    const absoluteFilePath = path.resolve(cwd, filePath);
    try {
        content = await fs.readFile(absoluteFilePath, 'utf-8');
        logger.info(`Reading patch from file: ${absoluteFilePath}`);
    } catch (error) {
        logger.error(`Failed to read patch file at '${absoluteFilePath}'. Aborting.`);
        return;
    }

    logger.info('Attempting to parse patch file...');
    const parsedResponse = parseLLMResponse(content);

    if (!parsedResponse) {
        logger.error('The content of the file is not a valid relaycode patch. Aborting.');
        return;
    }

    logger.success('Valid patch format detected. Processing...');
    await processPatch(config, parsedResponse, { cwd });
    logger.info('--------------------------------------------------');
};
````

## File: src/utils/notifier.ts
````typescript
const notifier = require('toasted-notifier');

const appName = 'Relaycode';

// This is a "fire-and-forget" utility. If notifications fail for any reason
// (e.g., unsupported OS, DND mode, permissions), it should not crash the app.
const sendNotification = (options: { title: string; message: string; enableNotifications?: boolean }) => {
    // Skip notification if explicitly disabled
    if (options.enableNotifications === false) {
        return;
    }
    
    try {
        notifier.notify(
            {
                title: options.title,
                message: options.message,
                sound: false, // Keep it quiet by default
                wait: false,
            },
            (err: any) => {
                if (err) {
                    // Silently ignore errors. This is a non-critical feature.
                }
            }
        );
    } catch (err) {
        // Silently ignore errors.
    }
};

const createNotifier = (messageTemplate: (param: string) => string) => {
    return (param: string, enableNotifications: boolean = true) => {
        sendNotification({
            title: appName,
            message: messageTemplate(param),
            enableNotifications,
        });
    };
};

export const notifyPatchDetected = createNotifier(
    (projectId: string) => `New patch detected for project \`${projectId}\`.`
);

export const notifyApprovalRequired = createNotifier(
    (projectId: string) => `Action required to approve changes for \`${projectId}\`.`
);

export const notifySuccess = createNotifier(
    (uuid: string) => `Patch \`${uuid}\` applied successfully.`
);

export const notifyFailure = createNotifier(
    (uuid: string) => `Patch \`${uuid}\` failed and was rolled back.`
);
````

## File: src/commands/revert.ts
````typescript
import { loadConfigOrExit } from '../core/config';
import { readStateFile } from '../core/state';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { FileOperation, ParsedLLMResponse } from '../types';
import { v4 as uuidv4 } from 'uuid';

export const revertCommand = async (uuidToRevert: string, cwd: string = process.cwd()): Promise<void> => {
    const config = await loadConfigOrExit(cwd);

    // 2. Load the state file for the transaction to revert
    logger.info(`Attempting to revert transaction: ${uuidToRevert}`);
    const stateToRevert = await readStateFile(cwd, uuidToRevert);
    if (!stateToRevert) {
        logger.error(`Transaction with UUID '${uuidToRevert}' not found or is invalid.`);
        return;
    }

    // 3. Generate inverse operations
    const inverse_operations = [...stateToRevert.operations]
        .reverse()
        .map((op): FileOperation | null => {
            switch (op.type) {
                case 'rename':
                    return { type: 'rename', from: op.to, to: op.from };
                case 'delete': {
                    const deletedContent = stateToRevert.snapshot[op.path];
                    if (deletedContent === null || typeof deletedContent === 'undefined') {
                        logger.warn(`Cannot revert deletion of ${op.path}, original content not found in snapshot. Skipping.`);
                        return null;
                    }
                    return { type: 'write', path: op.path, content: deletedContent, patchStrategy: 'replace' };
                }
                case 'write': {
                    const originalContent = stateToRevert.snapshot[op.path];
                    if (typeof originalContent === 'undefined') {
                        logger.warn(`Cannot find original state for ${op.path} in snapshot. Skipping revert for this operation.`);
                        return null;
                    }
                    if (originalContent === null) {
                        return { type: 'delete', path: op.path };
                    } else {
                        return { type: 'write', path: op.path, content: originalContent, patchStrategy: 'replace' };
                    }
                }
            }
        })
        .filter((op): op is FileOperation => op !== null);

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
````

## File: src/utils/logger.ts
````typescript
import chalk from 'chalk';
import { LogLevelName } from '../types';

const LogLevels = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
} as const;

let currentLogLevel: LogLevelName = 'info'; // Default level

export const logger = {
  setLevel: (level: LogLevelName) => {
    if (level in LogLevels) {
      currentLogLevel = level;
    }
  },
  info: (message: string) => {
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(chalk.blue(message));
    }
  },
  success: (message: string) => {
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(chalk.green(message));
    }
  },
  warn: (message: string) => {
    if (LogLevels.warn <= LogLevels[currentLogLevel]) {
      console.log(chalk.yellow(message));
    }
  },
  error: (message: string) => {
    if (LogLevels.error <= LogLevels[currentLogLevel]) {
      console.log(chalk.red(message));
    }
  },
  debug: (message: string) => {
    if (LogLevels.debug <= LogLevels[currentLogLevel]) {
      console.log(chalk.gray(message));
    }
  },
  log: (message: string) => {
    // General log, treat as info
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(message);
    }
  },
  prompt: (message: string) => {
    // Prompts are special and should be shown unless silent
        if (currentLogLevel !== 'silent') {
          console.log(chalk.cyan(message));
        }
      },
    };
    
    export const getErrorMessage = (error: unknown): string => {
        return error instanceof Error ? error.message : String(error);
    };
    
    export const isEnoentError = (error: unknown): boolean => {
        return error instanceof Error && 'code' in error && error.code === 'ENOENT';
    };
````

## File: src/commands/log.ts
````typescript
import { logger } from '../utils/logger';
import { FileOperation, StateFile } from '../types';
import { readAllStateFiles } from '../core/state';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const opToString = (op: FileOperation): string => {
    switch (op.type) {
        case 'write': return `write: ${op.path}`;
        case 'delete': return `delete: ${op.path}`;
        case 'rename': return `rename: ${op.from} -> ${op.to}`;
    }
};

export const formatTransactionDetails = (
    tx: StateFile,
    options: { showOperations?: boolean, showSpacing?: boolean } = {}
): string[] => {
    const lines: string[] = [];
    lines.push(`- UUID: ${tx.uuid}`);
    lines.push(`  Date: ${new Date(tx.createdAt).toLocaleString()}`);
    if (tx.reasoning && tx.reasoning.length > 0) {
        lines.push('  Reasoning:');
        tx.reasoning.forEach(r => lines.push(`    - ${r}`));
    }
    if (options.showOperations && tx.operations && tx.operations.length > 0) {
        lines.push('  Changes:');
        tx.operations.forEach(op => lines.push(`    - ${opToString(op)}`));
    }
    if (options.showSpacing) {
        lines.push(''); // Newline for spacing
    }
    return lines;
};

export const logCommand = async (cwd: string = process.cwd(), outputCapture?: string[]): Promise<void> => {
    const log = (message: string) => {
        if (outputCapture) {
            outputCapture.push(message);
        } else {
            logger.log(message);
        }
    };

    const transactions = await readAllStateFiles(cwd);

    if (transactions === null) {
        log(`warn: State directory '${STATE_DIRECTORY_NAME}' not found. No logs to display.`);
        log("info: Run 'relay init' to initialize the project.");
        return;
    }

    if (transactions.length === 0) {
        log('info: No committed transactions found.');
        return;
    }

    log('Committed Transactions (most recent first):');
    log('-------------------------------------------');

    if (transactions.length === 0) {
        log('info: No valid transactions found.');
        return;
    }

    transactions.forEach(tx => {
        formatTransactionDetails(tx, { showOperations: true, showSpacing: true }).forEach(line => log(line));
    });
};
````

## File: src/commands/undo.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { logger, getErrorMessage } from '../utils/logger';
import { findLatestStateFile, getStateFilePath, getUndoneStateFilePath } from '../core/state';
import { restoreSnapshot } from '../core/executor';
import { getConfirmation as defaultGetConfirmation } from '../utils/prompt';
import { formatTransactionDetails } from './log';

type Prompter = (question: string) => Promise<boolean>;

export const undoCommand = async (cwd: string = process.cwd(), prompter?: Prompter): Promise<void> => {
    const getConfirmation = prompter || defaultGetConfirmation;
    logger.info('Attempting to undo the last transaction...');

    const latestTransaction = await findLatestStateFile(cwd);

    if (!latestTransaction) {
        logger.warn('No committed transactions found to undo.');
        return;
    }

    const [uuidLine, ...otherLines] = formatTransactionDetails(latestTransaction, { showSpacing: true });
    logger.log(`The last transaction to be undone is:`);
    if (uuidLine) {
        logger.info(uuidLine); // UUID line with info color
    }
    otherLines.forEach(line => logger.log(line));

    const confirmed = await getConfirmation('Are you sure you want to undo this transaction? (y/N)');

    if (!confirmed) {
        logger.info('Undo operation cancelled.');
        return;
    }
    
    logger.info(`Undoing transaction ${latestTransaction.uuid}...`);

    try {
        await restoreSnapshot(latestTransaction.snapshot, cwd);
        logger.success('  - Successfully restored file snapshot.');

        const oldPath = getStateFilePath(cwd, latestTransaction.uuid, false);
        const newPath = getUndoneStateFilePath(cwd, latestTransaction.uuid);

        await fs.mkdir(path.dirname(newPath), { recursive: true });
        await fs.rename(oldPath, newPath);
        logger.success(`  - Moved transaction file to 'undone' directory.`);
        logger.success(`✅ Last transaction successfully undone.`);

    } catch (error) {
        logger.error(`Failed to undo transaction: ${getErrorMessage(error)}`);
        logger.error('Your file system may be in a partially restored state. Please check your files.');
    }
};
````

## File: src/index.ts
````typescript
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
    writePendingState,
    getStateFilePath,
    getUndoneStateFilePath
} from './core/state';
export { processPatch } from './core/transaction';

// Commands
export { initCommand } from './commands/init';
export { watchCommand } from './commands/watch';
export { logCommand } from './commands/log';
export { undoCommand } from './commands/undo';
export { revertCommand } from './commands/revert';
export { applyCommand } from './commands/apply';

// Types
export * from './types';

// Utils
export { executeShellCommand, getErrorCount } from './utils/shell';
export { logger } from './utils/logger';
export { getConfirmation } from './utils/prompt';
````

## File: src/types.ts
````typescript
import { z } from 'zod';

export const LogLevelNameSchema = z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info');
export type LogLevelName = z.infer<typeof LogLevelNameSchema>;

// Schema for relaycode.config.json
export const ConfigSchema = z.object({
  projectId: z.string().min(1),
  logLevel: LogLevelNameSchema,
  clipboardPollInterval: z.number().int().positive().default(2000),
  approvalMode: z.enum(['auto', 'manual']).default('auto'),
  approvalOnErrorCount: z.number().int().min(0).default(0),
  linter: z.string().default('bun tsc --noEmit'),
  preCommand: z.string().default(''),
  postCommand: z.string().default(''),
  preferredStrategy: z.enum(['auto', 'replace', 'new-unified', 'multi-search-replace']).default('auto'),
  enableNotifications: z.boolean().default(true),
});
export type Config = z.infer<typeof ConfigSchema>;

export const PatchStrategySchema = z.enum([
  'replace',
  'new-unified',
  'multi-search-replace',
  'unified',
]).default('replace');
export type PatchStrategy = z.infer<typeof PatchStrategySchema>;

// Schema for operations parsed from code blocks
export const FileOperationSchema = z.union([
  z.object({
    type: z.literal('write'),
    path: z.string(),
    content: z.string(),
    patchStrategy: PatchStrategySchema,
  }),
  z.object({
    type: z.literal('delete'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('rename'),
    from: z.string(),
    to: z.string(),
  }),
]);
export type FileOperation = z.infer<typeof FileOperationSchema>;

// Schema for the control YAML block at the end of the LLM response
export const ControlYamlSchema = z.object({
  projectId: z.string(),
  uuid: z.string().uuid(),
  changeSummary: z.array(z.record(z.string())).optional(), // Not strictly used, but good to parse
});
export type ControlYaml = z.infer<typeof ControlYamlSchema>;

// The fully parsed response from the clipboard
export const ParsedLLMResponseSchema = z.object({
  control: ControlYamlSchema,
  operations: z.array(FileOperationSchema),
  reasoning: z.array(z.string()),
});
export type ParsedLLMResponse = z.infer<typeof ParsedLLMResponseSchema>;

// Schema for the snapshot of original files
export const FileSnapshotSchema = z.record(z.string(), z.string().nullable()); // path -> content | null (if file didn't exist)
export type FileSnapshot = z.infer<typeof FileSnapshotSchema>;

// Schema for the state file (.relaycode/{uuid}.yml or .pending.yml)
export const StateFileSchema = z.object({
  uuid: z.string().uuid(),
  projectId: z.string(),
  createdAt: z.string().datetime(),
  reasoning: z.array(z.string()),
  operations: z.array(FileOperationSchema),
  snapshot: FileSnapshotSchema,
  approved: z.boolean(),
});
export type StateFile = z.infer<typeof StateFileSchema>;

// Shell command execution result
export const ShellCommandResultSchema = z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().nullable(),
});
export type ShellCommandResult = z.infer<typeof ShellCommandResultSchema>;
````

## File: src/utils/shell.ts
````typescript
import { spawn } from 'child_process';
import path from 'path';
import { logger } from './logger';

type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const executeShellCommand = (command: string, cwd = process.cwd()): Promise<ExecutionResult> => {
  if (!command || command.trim() === '') {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  const normalizedCwd = path.resolve(cwd);

  return new Promise((resolve) => {
    logger.debug(`Executing command: ${command} in directory: ${normalizedCwd}`);
    
    const child = spawn(command, {
      cwd: normalizedCwd,
      shell: true, // Use shell to interpret the command (e.g., cmd.exe on Windows, /bin/sh on Linux)
      stdio: ['ignore', 'pipe', 'pipe'], // stdin, stdout, stderr
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (err) => {
      // e.g., command not found
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
      });
    });
  });
};

export const getErrorCount = async (linterCommand: string, cwd = process.cwd()): Promise<number> => {
  if (!linterCommand || linterCommand.trim() === '') {
    return 0;
  }
  
  const { exitCode, stderr } = await executeShellCommand(linterCommand, cwd);
  if (exitCode === 0) return 0;

  // Try to extract a number of errors from stderr or assume 1 if non-zero exit code
  const errorMatches = stderr.match(/(\d+) error/i);
  if (errorMatches && errorMatches[1]) {
    return parseInt(errorMatches[1], 10);
  }
  return exitCode === 0 ? 0 : 1;
};
````

## File: src/core/config.ts
````typescript
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { Config, ConfigSchema } from '../types';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME } from '../utils/constants';
import { logger, isEnoentError } from '../utils/logger';

export const findConfig = async (cwd: string = process.cwd()): Promise<Config | null> => {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);
  try {
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const configJson = JSON.parse(fileContent);
    return ConfigSchema.parse(configJson);
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid configuration in ${CONFIG_FILE_NAME}: ${error.message}`);
    }
    throw error;
  }
};

export const loadConfigOrExit = async (cwd: string = process.cwd()): Promise<Config> => {
    const config = await findConfig(cwd);
    if (!config) {
        logger.error(`Configuration file '${CONFIG_FILE_NAME}' not found.`);
        logger.info("Please run 'relay init' to create one.");
        process.exit(1);
    }
    return config;
};

export const createConfig = async (projectId: string, cwd: string = process.cwd()): Promise<Config> => {
    const config = {
        projectId,
        clipboardPollInterval: 2000,
        approvalMode: 'auto' as const,
        approvalOnErrorCount: 0,
        linter: 'bun tsc --noEmit',
        preCommand: '',
        postCommand: '',
        preferredStrategy: 'auto' as const,
        enableNotifications: true,
    };
    
    // Ensure the schema defaults are applied, including for logLevel
    const validatedConfig = ConfigSchema.parse(config);

    const configPath = path.join(cwd, CONFIG_FILE_NAME);
    await fs.writeFile(configPath, JSON.stringify(validatedConfig, null, 2));

    return validatedConfig;
};

export const ensureStateDirExists = async (cwd: string = process.cwd()): Promise<void> => {
    const stateDirPath = path.join(cwd, STATE_DIRECTORY_NAME);
    await fs.mkdir(stateDirPath, { recursive: true });
};

export const getProjectId = async (cwd: string = process.cwd()): Promise<string> => {
    try {
        const pkgJsonPath = path.join(cwd, 'package.json');
        const fileContent = await fs.readFile(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(fileContent);
        if (pkgJson.name && typeof pkgJson.name === 'string') {
            return pkgJson.name;
        }
    } catch (e) {
        // Ignore if package.json doesn't exist or is invalid
    }
    return path.basename(cwd);
};
````

## File: tsconfig.json
````json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "lib": ["ESNext"],
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "allowJs": true,
    "checkJs": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
````

## File: src/commands/init.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { findConfig, createConfig, ensureStateDirExists, getProjectId } from '../core/config';
import { logger, getErrorMessage, isEnoentError } from '../utils/logger';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../utils/constants';

const getInitMessage = (projectId: string): string => `
✅ relaycode has been initialized for this project.

Configuration file created: ${CONFIG_FILE_NAME}

Project ID: ${projectId}

Next steps:
1. (Optional) Open ${CONFIG_FILE_NAME} to customize settings like 'preferredStrategy' to control how the AI generates code patches.
   - 'auto' (default): The AI can choose the best patch strategy.
   - 'new-unified': Forces the AI to use diffs, great for most changes.
   - 'replace': Forces the AI to replace entire files, good for new files or small changes.
   - 'multi-search-replace': Forces the AI to perform precise search and replace operations.

2. Run 'relay watch' in your terminal. This will start the service and display the system prompt tailored to your configuration.

3. Copy the system prompt provided by 'relay watch' and paste it into your AI assistant's "System Prompt" or "Custom Instructions".
`;


const updateGitignore = async (cwd: string): Promise<void> => {
    const gitignorePath = path.join(cwd, GITIGNORE_FILE_NAME);
    const entry = `\n# relaycode state\n/${STATE_DIRECTORY_NAME}/\n`;

    try {
        let content = await fs.readFile(gitignorePath, 'utf-8');
        if (!content.includes(STATE_DIRECTORY_NAME)) {
            content += entry;
            await fs.writeFile(gitignorePath, content);
            logger.info(`Updated ${GITIGNORE_FILE_NAME} to ignore ${STATE_DIRECTORY_NAME}/`);
        }
    } catch (error) {
        if (isEnoentError(error)) {
            await fs.writeFile(gitignorePath, entry.trim());
            logger.info(`Created ${GITIGNORE_FILE_NAME} and added ${STATE_DIRECTORY_NAME}/`);
        } else {
            logger.error(`Failed to update ${GITIGNORE_FILE_NAME}: ${getErrorMessage(error)}`);
        }
    }
};

export const initCommand = async (cwd: string = process.cwd()): Promise<void> => {
    logger.info('Initializing relaycode in this project...');

    const config = await findConfig(cwd);
    if (config) {
        logger.warn(`${CONFIG_FILE_NAME} already exists. Initialization skipped.`);
        logger.log(`
To use relaycode, please run 'relay watch'.
It will display a system prompt to copy into your LLM assistant.
You can review your configuration in ${CONFIG_FILE_NAME}.
`);
        return;
    }
    
    const projectId = await getProjectId(cwd);
    await createConfig(projectId, cwd);
    logger.success(`Created configuration file: ${CONFIG_FILE_NAME}`);
    
    await ensureStateDirExists(cwd);
    logger.success(`Created state directory: ${STATE_DIRECTORY_NAME}/`);

    await updateGitignore(cwd);

    logger.log(getInitMessage(projectId));
};
````

## File: relaycode.config.json
````json
{
  "projectId": "relaycode",
  "logLevel": "info",
  "clipboardPollInterval": 2000,
  "approvalMode": "auto",
  "approvalOnErrorCount": 0,
  "linter": "bun tsc -b --noEmit",
  "preCommand": "",
  "postCommand": "",
  "preferredStrategy": "auto",
  "enableNotifications": false
}
````

## File: src/core/clipboard.ts
````typescript
import clipboardy from 'clipboardy';
import { logger, getErrorMessage } from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

type ClipboardCallback = (content: string) => void;
type ClipboardReader = () => Promise<string>;

const WINDOWS_FALLBACK_DIR = path.join(process.cwd(), 'fallbacks', 'windows');
const WINDOWS_CLIPBOARD_EXE = 'clipboard_x86_64.exe';
const WINDOWS_CLIPBOARD_PATH = path.join(WINDOWS_FALLBACK_DIR, WINDOWS_CLIPBOARD_EXE);

// Direct Windows clipboard reader that uses the executable directly
const createDirectWindowsClipboardReader = (): ClipboardReader => {
  return () => new Promise((resolve) => {
    try {
      if (!fs.existsSync(WINDOWS_CLIPBOARD_PATH)) {
        logger.error('Windows clipboard executable not found. Cannot watch clipboard on Windows.');
        // Resolve with empty string to avoid stopping the watcher loop, but log an error.
        return resolve('');
      }
      
      const command = `"${WINDOWS_CLIPBOARD_PATH}" --paste`;
      
      exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          // It's common for the clipboard executable to fail if the clipboard is empty
          // or contains non-text data (e.g., an image). We can treat this as "no content".
          // We don't log this as an error to avoid spamming the console during normal use.
          logger.debug(`Windows clipboard read command failed (this is often normal): ${stderr.trim()}`);
          resolve('');
        } else {
          resolve(stdout);
        }
      });
    } catch (syncError) {
      // Catch synchronous errors during setup (e.g., path issues).
      logger.error(`A synchronous error occurred while setting up clipboard reader: ${getErrorMessage(syncError)}`);
      resolve('');
    }
  });
};

// Check if the clipboard executable exists and fix path issues on Windows
const ensureClipboardExecutable = () => {
  if (process.platform === 'win32') {
    try {
      // Try to find clipboard executables in common locations
      const possiblePaths = [
        // Global installation path
        path.join(process.env.HOME || '', '.bun', 'install', 'global', 'node_modules', 'relaycode', 'fallbacks', 'windows'),
        // Local installation paths
        path.join(process.cwd(), 'node_modules', 'clipboardy', 'fallbacks', 'windows'),
        WINDOWS_FALLBACK_DIR,
      ];
      
      // Create fallbacks directory in the current project if it doesn't exist
      if (!fs.existsSync(WINDOWS_FALLBACK_DIR)) {
        fs.mkdirSync(WINDOWS_FALLBACK_DIR, { recursive: true });
      }
      
      // Find an existing executable
      let sourceExePath = null;
      for (const dir of possiblePaths) {
        const exePath = path.join(dir, WINDOWS_CLIPBOARD_EXE);
        if (fs.existsSync(exePath)) {
          sourceExePath = exePath;
          break;
        }
      }
      
      // Copy the executable to the local fallbacks directory if found
      if (sourceExePath && sourceExePath !== WINDOWS_CLIPBOARD_PATH) {
        fs.copyFileSync(sourceExePath, WINDOWS_CLIPBOARD_PATH);
        logger.info('Copied Windows clipboard executable to local fallbacks directory');
      } else if (!sourceExePath) {
        logger.error('Windows clipboard executable not found in any location');
      }
    } catch (error) {
      logger.warn('Error ensuring clipboard executable: ' + getErrorMessage(error));
    }
  }
};

export const createClipboardWatcher = (
  pollInterval: number,
  callback: ClipboardCallback,
  reader?: ClipboardReader,
) => {
  // Ensure clipboard executable exists before starting
  ensureClipboardExecutable();
  
  // On Windows, use the direct Windows reader
  // Otherwise use the provided reader or clipboardy
  const clipboardReader = process.platform === 'win32' ? 
    createDirectWindowsClipboardReader() : 
    reader || clipboardy.read;
  
  let lastContent = '';
  let intervalId: NodeJS.Timeout | null = null;

  const checkClipboard = async () => {
    try {
      const content = await clipboardReader();
      if (content && content !== lastContent) {
        lastContent = content;
        callback(content);
      }
    } catch (error) {
      // It's common for clipboard access to fail occasionally (e.g., on VM focus change)
      // So we log a warning but don't stop the watcher.
      logger.warn('Could not read from clipboard: ' + getErrorMessage(error));
    }
  };

  const start = () => {
    if (intervalId) {
      return;
    }
    logger.info(`Starting clipboard watcher (polling every ${pollInterval}ms)`);
    // Immediately check once, then start the interval
    checkClipboard();
    intervalId = setInterval(checkClipboard, pollInterval);
  };

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      logger.info('Clipboard watcher stopped.');
    }
  };

  start();
  
  return { stop };
};
````

## File: src/cli.ts
````typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { watchCommand } from './commands/watch';
import { logCommand } from './commands/log';
import { undoCommand } from './commands/undo';
import { revertCommand } from './commands/revert';
import { applyCommand } from './commands/apply';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Default version in case we can't find the package.json
let version = '0.0.0';

try {
  const require = createRequire(import.meta.url);
  let pkg;
  try {
    // This works when installed as a package
    pkg = require('relaycode/package.json');
  } catch (e) {
    // Fallback for local development
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      pkg = require(join(__dirname, '..', 'package.json'));
    } catch (e2) {
      // ignore
    }
  }
  
  if (pkg && pkg.version) {
    version = pkg.version;
  }
} catch (error) {
  // Fallback to default version if we can't find the package.json
  console.error('Warning: Could not determine package version', error);
}

const program = new Command();

program
  .name('relay')
  .version(version)
  .description('A developer assistant that automates applying code changes from LLMs.');

const commands = [
  { name: 'init', alias: 'i', description: 'Initializes relaycode in the current project.', action: initCommand },
  { name: 'watch', alias: 'w', description: 'Starts watching the clipboard for code changes to apply.', action: () => { watchCommand(); } },
  { name: 'apply', alias: 'a', description: 'Applies a patch from a specified file.', args: { syntax: '<filePath>', description: 'The path to the file containing the patch.' }, action: applyCommand },
  { name: 'log', alias: 'l', description: 'Displays a log of all committed transactions.', action: logCommand },
  { name: 'undo', alias: 'u', description: 'Reverts the last successfully committed transaction.', action: undoCommand },
  { name: 'revert', alias: 'r', description: 'Reverts a committed transaction by its UUID.', args: { syntax: '<uuid>', description: 'The UUID of the transaction to revert.' }, action: revertCommand },
];

commands.forEach(cmdInfo => {
  const command = program
    .command(cmdInfo.name)
    .alias(cmdInfo.alias)
    .description(cmdInfo.description);

  if (cmdInfo.args) {
    command.argument(cmdInfo.args.syntax, cmdInfo.args.description);
  }

  command.action(cmdInfo.action);
});

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}
````

## File: src/core/parser.ts
````typescript
import yaml from 'js-yaml';
import { z } from 'zod';
import {
    ControlYamlSchema,
    FileOperation,
    ParsedLLMResponse,
    ParsedLLMResponseSchema,
    PatchStrategy,
    PatchStrategySchema,
} from '../types';
import {
    CODE_BLOCK_START_MARKER,
    CODE_BLOCK_END_MARKER,
    DELETE_FILE_MARKER
} from '../utils/constants';
import { logger } from '../utils/logger';

const CODE_BLOCK_REGEX = /```(?:\w+)?(?:\s*\/\/\s*(.*?)|\s+(.*?))?[\r\n]([\s\S]*?)[\r\n]```/g;
const YAML_BLOCK_REGEX = /```yaml[\r\n]([\s\S]+?)```/;

const extractCodeBetweenMarkers = (content: string): string => {
    const startMarkerIndex = content.indexOf(CODE_BLOCK_START_MARKER);
    const endMarkerIndex = content.lastIndexOf(CODE_BLOCK_END_MARKER);

    if (startMarkerIndex === -1 || endMarkerIndex === -1 || endMarkerIndex <= startMarkerIndex) {
        // Normalize line endings to Unix-style \n for consistency
        return content.trim().replace(/\r\n/g, '\n');
    }

    const startIndex = startMarkerIndex + CODE_BLOCK_START_MARKER.length;
    // Normalize line endings to Unix-style \n for consistency
    return content.substring(startIndex, endMarkerIndex).trim().replace(/\r\n/g, '\n');
};

export const parseLLMResponse = (rawText: string): ParsedLLMResponse | null => {
    try {
        logger.debug('Parsing LLM response...');
        const yamlMatch = rawText.match(YAML_BLOCK_REGEX);
        logger.debug(`YAML match: ${yamlMatch ? 'Found' : 'Not found'}`);
        if (!yamlMatch || typeof yamlMatch[1] !== 'string') {
            logger.debug('No YAML block found or match[1] is not a string');
            return null;
        }

        let control;
        try {
            const yamlContent = yaml.load(yamlMatch[1]);
            logger.debug(`YAML content parsed: ${JSON.stringify(yamlContent)}`);
            control = ControlYamlSchema.parse(yamlContent);
            logger.debug(`Control schema parsed: ${JSON.stringify(control)}`);
        } catch (e) {
            logger.debug(`Error parsing YAML or control schema: ${e}`);
            return null;
        }

        const textWithoutYaml = rawText.replace(YAML_BLOCK_REGEX, '').trim();
        
        const operations: FileOperation[] = [];
        const matchedBlocks: string[] = [];
        
        let match;
        logger.debug('Looking for code blocks...');
        let blockCount = 0;
        while ((match = CODE_BLOCK_REGEX.exec(textWithoutYaml)) !== null) {
            blockCount++;
            logger.debug(`Found code block #${blockCount}`);
            const [fullMatch, commentHeaderLine, spaceHeaderLine, rawContent] = match;

            // Get the header line from either the comment style or space style
            const headerLineUntrimmed = commentHeaderLine || spaceHeaderLine || '';
            
            if (typeof headerLineUntrimmed !== 'string' || typeof rawContent !== 'string') {
                logger.debug('Header line or raw content is not a string, skipping');
                continue;
            }

            const headerLine = headerLineUntrimmed.trim();
            const content = rawContent.trim();

            // Handle rename operation as a special case
            if (headerLine === 'rename-file') {
                logger.debug(`Found rename-file operation`);
                matchedBlocks.push(fullMatch);
                try {
                    const renameData = JSON.parse(content);
                    const RenameFileContentSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
                    const renameOp = RenameFileContentSchema.parse(renameData);
                    operations.push({ type: 'rename', from: renameOp.from, to: renameOp.to });
                } catch (e) {
                    logger.debug(`Invalid rename operation content, skipping: ${e instanceof Error ? e.message : String(e)}`);
                }
                continue;
            }


            if (headerLine === '') {
                logger.debug('Empty header line, skipping');
                continue;
            }

            logger.debug(`Header line: ${headerLine}`);
            matchedBlocks.push(fullMatch);
            
            let filePath = '';
            let strategyProvided = false;
            let patchStrategy: PatchStrategy = 'replace'; // Default
            
            const quotedMatch = headerLine.match(/^"(.+?)"(?:\s+(.*))?$/);
            if (quotedMatch) {
                filePath = quotedMatch[1]!;
                const strategyStr = (quotedMatch[2] || '').trim();
                if (strategyStr) {
                    const parsedStrategy = PatchStrategySchema.safeParse(strategyStr);
                    if (!parsedStrategy.success) {
                        logger.debug('Invalid patch strategy for quoted path, skipping');
                        continue;
                    }
                    patchStrategy = parsedStrategy.data;
                    strategyProvided = true;
                }
            } else {
                const parts = headerLine.split(/\s+/);
                if (parts.length > 1) {
                    const potentialStrategy = parts[parts.length - 1]; // peek
                    const parsedStrategy = PatchStrategySchema.safeParse(potentialStrategy);
                    if (!parsedStrategy.success) {
                        filePath = parts.join(' ');
                    } else {
                        parts.pop(); // consume
                        patchStrategy = parsedStrategy.data;
                        strategyProvided = true;
                        filePath = parts.join(' ');
                    }
                } else {
                    filePath = headerLine;
                }
            }

            if (!strategyProvided) {
                // Check for multi-search-replace format with a more precise pattern
                // Looking for the exact pattern at the start of a line AND the ending marker
                if (/^<<<<<<< SEARCH\s*$/m.test(content) && content.includes('>>>>>>> REPLACE')) {
                    patchStrategy = 'multi-search-replace';
                    logger.debug('Inferred patch strategy: multi-search-replace');
                } 
                // Check for new-unified format with more precise pattern
                else if (content.startsWith('--- ') && content.includes('+++ ') && content.includes('@@')) {
                    patchStrategy = 'new-unified';
                    logger.debug('Inferred patch strategy: new-unified');
                }
                // If neither pattern is detected, keep the default 'replace' strategy
                else {
                    logger.debug('No specific patch format detected, using default replace strategy');
                }
            }

            logger.debug(`File path: ${filePath}`);
            logger.debug(`Patch strategy: ${patchStrategy}`);
            
            if (!filePath) {
                logger.debug('Empty file path, skipping');
                continue;
            }

            if (content === DELETE_FILE_MARKER) {
                logger.debug(`Adding delete operation for: ${filePath}`);
                operations.push({ type: 'delete', path: filePath });
            } else {
                const cleanContent = extractCodeBetweenMarkers(content);
                logger.debug(`Adding write operation for: ${filePath}`);
                operations.push({ 
                    type: 'write', 
                    path: filePath, 
                    content: cleanContent, 
                    patchStrategy 
                });
            }
        }
        
        logger.debug(`Found ${blockCount} code blocks, ${operations.length} operations`);
        
        let reasoningText = textWithoutYaml;
        for (const block of matchedBlocks) {
            reasoningText = reasoningText.replace(block, '');
        }
        const reasoning = reasoningText.split('\n').map(line => line.trim()).filter(Boolean);

        if (operations.length === 0) {
            logger.debug('No operations found, returning null');
            return null;
        }

        try {
            const parsedResponse = ParsedLLMResponseSchema.parse({
                control,
                operations,
                reasoning,
            });
            logger.debug('Successfully parsed LLM response');
            return parsedResponse;
        } catch (e) {
            logger.debug(`Error parsing final response schema: ${e}`);
            return null;
        }
    } catch (e) {
        if (e instanceof z.ZodError) {
            logger.debug(`ZodError: ${JSON.stringify(e.errors)}`);
        } else {
            logger.debug(`Unexpected error: ${e}`);
        }
        return null;
    }
};
````

## File: src/commands/watch.ts
````typescript
import { findConfig, loadConfigOrExit } from '../core/config';
import { createClipboardWatcher } from '../core/clipboard';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME } from '../utils/constants';
import { notifyPatchDetected } from '../utils/notifier';
import { Config } from '../types';
import fs from 'fs';
import path from 'path';

const getSystemPrompt = (projectId: string, preferredStrategy: Config['preferredStrategy']): string => {
    const header = `
✅ relaycode is watching for changes.

IMPORTANT: For relaycode to work, you must configure your AI assistant.
Copy the entire text below and paste it into your LLM's "System Prompt"
or "Custom Instructions" section.
---------------------------------------------------------------------------`;

    const intro = `You are an expert AI programmer. To modify a file, you MUST use a code block with a specified patch strategy.`;

    const syntaxAuto = `
**Syntax:**
\`\`\`typescript // filePath {patchStrategy}
... content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- \`patchStrategy\`: (Optional) One of \`new-unified\`, \`multi-search-replace\`. If omitted, the entire file is replaced (this is the \`replace\` strategy).

**Examples:**
\`\`\`typescript // src/components/Button.tsx
...
\`\`\`
\`\`\`typescript // "src/components/My Component.tsx" new-unified
...
\`\`\``;

    const syntaxReplace = `
**Syntax:**
\`\`\`typescript // filePath
... content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- Only the \`replace\` strategy is enabled. This means you must provide the ENTIRE file content for any change. This is suitable for creating new files or making changes to small files.`;

    const syntaxNewUnified = `
**Syntax:**
\`\`\`typescript // filePath new-unified
... diff content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- You must use the \`new-unified\` patch strategy for all modifications.`;

    const syntaxMultiSearchReplace = `
**Syntax:**
\`\`\`typescript // filePath multi-search-replace
... diff content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- You must use the \`multi-search-replace\` patch strategy for all modifications.`;

    const sectionNewUnified = `---

### Strategy 1: Advanced Unified Diff (\`new-unified\`) - RECOMMENDED

Use for most changes, like refactoring, adding features, and fixing bugs. It's resilient to minor changes in the source file.

**Diff Format:**
1.  **File Headers**: Start with \`--- {filePath}\` and \`+++ {filePath}\`.
2.  **Hunk Header**: Use \`@@ ... @@\`. Exact line numbers are not needed.
3.  **Context Lines**: Include 2-3 unchanged lines before and after your change for context.
4.  **Changes**: Mark additions with \`+\` and removals with \`-\`. Maintain indentation.

**Example:**
\`\`\`diff
--- src/utils.ts
+++ src/utils.ts
@@ ... @@
    function calculateTotal(items: number[]): number {
-      return items.reduce((sum, item) => {
-        return sum + item;
-      }, 0);
+      const total = items.reduce((sum, item) => {
+        return sum + item * 1.1;  // Add 10% markup
+      }, 0);
+      return Math.round(total * 100) / 100;  // Round to 2 decimal places
+    }
\`\`\`
`;

    const sectionMultiSearchReplace = `---

### Strategy 2: Multi-Search-Replace (\`multi-search-replace\`)

Use for precise, surgical replacements. The \`SEARCH\` block must be an exact match of the content in the file.

**Diff Format:**
Repeat this block for each replacement.
\`\`\`diff
<<<<<<< SEARCH
:start_line: (optional)
:end_line: (optional)
-------
[exact content to find including whitespace]
=======
[new content to replace with]
>>>>>>> REPLACE
\`\`\`
`;

    const otherOps = `---

### Other Operations

-   **Creating a file**: Use the default \`replace\` strategy (omit the strategy name) and provide the full file content.
-   **Deleting a file**:
    \`\`\`typescript // path/to/file.ts
    //TODO: delete this file
    \`\`\`
    \`\`\`typescript // "path/to/My Old Component.ts"
    //TODO: delete this file
    \`\`\`
-   **Renaming/Moving a file**:
    \`\`\`json // rename-file
    {
      "from": "src/old/path/to/file.ts",
      "to": "src/new/path/to/file.ts"
    }
    \`\`\`
`;

    const finalSteps = `---

### Final Steps

1.  Add your step-by-step reasoning in plain text before each code block.
2.  ALWAYS add the following YAML block at the very end of your response. Use the exact projectId shown here. Generate a new random uuid for each response.

    \`\`\`yaml
    projectId: ${projectId}
    uuid: (generate a random uuid)
    changeSummary:
      - edit: src/main.ts
      - new: src/components/Button.tsx
      - delete: src/utils/old-helper.ts
    \`\`\`
`;
    
    const footer = `---------------------------------------------------------------------------`;

    const syntaxMap = {
        auto: syntaxAuto,
        replace: syntaxReplace,
        'new-unified': syntaxNewUnified,
        'multi-search-replace': syntaxMultiSearchReplace,
    };

    const strategyDetailsMap = {
        auto: `${sectionNewUnified}\n${sectionMultiSearchReplace}`,
        replace: '', // Covered in 'otherOps'
        'new-unified': sectionNewUnified,
        'multi-search-replace': sectionMultiSearchReplace,
    };

    const syntax = syntaxMap[preferredStrategy] ?? syntaxMap.auto;
    const strategyDetails = strategyDetailsMap[preferredStrategy] ?? strategyDetailsMap.auto;

    return [header, intro, syntax, strategyDetails, otherOps, finalSteps, footer].filter(Boolean).join('\n');
}

export const watchCommand = async (cwd: string = process.cwd()): Promise<{ stop: () => void }> => {
  let clipboardWatcher: ReturnType<typeof createClipboardWatcher> | null = null;
  const configPath = path.resolve(cwd, CONFIG_FILE_NAME);
  let debounceTimer: NodeJS.Timeout | null = null;

  const startServices = (config: Config) => {
    // Stop existing watcher if it's running
    if (clipboardWatcher) {
      clipboardWatcher.stop();
    }

    logger.setLevel(config.logLevel);
    logger.debug(`Log level set to: ${config.logLevel}`);
    logger.debug(`Preferred strategy set to: ${config.preferredStrategy}`);

    logger.log(getSystemPrompt(config.projectId, config.preferredStrategy));

    clipboardWatcher = createClipboardWatcher(config.clipboardPollInterval, async (content) => {
      logger.info('New clipboard content detected. Attempting to parse...');
      const parsedResponse = parseLLMResponse(content);

      if (!parsedResponse) {
        logger.warn('Clipboard content is not a valid relaycode patch. Ignoring.');
        return;
      }

      // Check project ID before notifying and processing.
      if (parsedResponse.control.projectId !== config.projectId) {
        logger.debug(`Ignoring patch for different project (expected '${config.projectId}', got '${parsedResponse.control.projectId}').`);
        return;
      }

      notifyPatchDetected(config.projectId, config.enableNotifications);
      logger.success(`Valid patch detected for project '${config.projectId}'. Processing...`);
      await processPatch(config, parsedResponse, { cwd });
      logger.info('--------------------------------------------------');
      logger.info('Watching for next patch...');
    });
  };

  const handleConfigChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      logger.info(`Configuration file change detected. Reloading...`);
      try {
        const newConfig = await findConfig(cwd);
        if (newConfig) {
          logger.success('Configuration reloaded. Restarting services...');
          startServices(newConfig);
        } else {
          logger.error(`${CONFIG_FILE_NAME} is invalid or has been deleted. Services paused.`);
          if (clipboardWatcher) {
            clipboardWatcher.stop();
            clipboardWatcher = null;
          }
        }
      } catch (error) {
        logger.error(`Error reloading configuration: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 250);
  };

  // Initial startup
  const initialConfig = await loadConfigOrExit(cwd);
  logger.success('Configuration loaded. Starting relaycode watch...');
  startServices(initialConfig);

  // Watch for changes after initial setup
  const configWatcher = fs.watch(configPath, handleConfigChange);

  const stopAll = () => {
    if (clipboardWatcher) {
      clipboardWatcher.stop();
    }
    if (configWatcher) {
      configWatcher.close();
      logger.info('Configuration file watcher stopped.');
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
  };
  return { stop: stopAll };
};
````

## File: src/core/executor.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';
import { newUnifiedDiffStrategyService, multiSearchReplaceService, unifiedDiffService } from 'diff-apply';
import { getErrorMessage, isEnoentError } from '../utils/logger';

export const readFileContent = async (filePath: string, cwd: string = process.cwd()): Promise<string | null> => {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), 'utf-8');
  } catch (error) {
    if (isEnoentError(error)) {
      return null; // File doesn't exist
    }
    throw error;
  }
};

export const writeFileContent = async (filePath: string, content: string, cwd: string = process.cwd()): Promise<void> => {
  const absolutePath = path.resolve(cwd, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');
};

export const deleteFile = async (filePath: string, cwd: string = process.cwd()): Promise<void> => {
  try {
    await fs.unlink(path.resolve(cwd, filePath));
  } catch (error) {
    if (isEnoentError(error)) {
      // File already deleted, which is fine.
      return;
    }
    throw error;
  }
};

export const fileExists = async (filePath: string, cwd: string = process.cwd()): Promise<boolean> => {
  try {
    await fs.access(path.resolve(cwd, filePath));
    return true;
  } catch {
    return false;
  }
};

export const safeRename = async (fromPath: string, toPath:string): Promise<void> => {
    try {
        await fs.rename(fromPath, toPath);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
            await fs.copyFile(fromPath, toPath);
            await fs.unlink(fromPath);
        } else {
            throw error;
        }
    }
};

export const renameFile = async (fromPath: string, toPath: string, cwd: string = process.cwd()): Promise<void> => {
  const fromAbsolutePath = path.resolve(cwd, fromPath);
  const toAbsolutePath = path.resolve(cwd, toPath);
  await fs.mkdir(path.dirname(toAbsolutePath), { recursive: true });
  await safeRename(fromAbsolutePath, toAbsolutePath);
};

export const createSnapshot = async (filePaths: string[], cwd: string = process.cwd()): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = {};
  
  // Process file reads in parallel for better performance
  const snapshotPromises = filePaths.map(async (filePath) => {
    try {
      const absolutePath = path.resolve(cwd, filePath);
      try {
        const content = await fs.readFile(absolutePath, 'utf-8');
        return { path: filePath, content };
      } catch (error) {
        if (isEnoentError(error)) {
          return { path: filePath, content: null }; // File doesn't exist, which is fine.
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`Error creating snapshot for ${filePath}:`, error);
      throw error;
    }
  });
  
  const results = await Promise.all(snapshotPromises);
  
  // Combine results into snapshot object
  for (const result of results) {
    snapshot[result.path] = result.content;
  }
  
  return snapshot;
};

export const applyOperations = async (operations: FileOperation[], cwd: string = process.cwd()): Promise<Map<string, string>> => {
  const newContents = new Map<string, string>();
  // Operations must be applied sequentially to ensure that if one fails,
  // we can roll back from a known state.
  for (const op of operations) {
    if (op.type === 'delete') {
      await deleteFile(op.path, cwd);
      continue;
    }
    if (op.type === 'rename') {
      await renameFile(op.from, op.to, cwd);
      continue;
    }
    
    let finalContent: string;

    if (op.patchStrategy === 'replace') {
      finalContent = op.content;
    } else {
      // For patch strategies, apply them sequentially
      const originalContent = await readFileContent(op.path, cwd);
      if (originalContent === null && op.patchStrategy === 'multi-search-replace') {
        throw new Error(`Cannot use 'multi-search-replace' on a new file: ${op.path}`);
      }

      try {
        const diffParams = {
          originalContent: originalContent ?? '',
          diffContent: op.content,
        };

        let result;
        switch (op.patchStrategy) {
          case 'new-unified':
            const newUnifiedStrategy = newUnifiedDiffStrategyService.newUnifiedDiffStrategyService.create(0.95);
            result = await newUnifiedStrategy.applyDiff(diffParams);
            break;
          case 'multi-search-replace':
            result = await multiSearchReplaceService.multiSearchReplaceService.applyDiff(diffParams);
            break;
          case 'unified':
            result = await unifiedDiffService.unifiedDiffService.applyDiff(diffParams.originalContent, diffParams.diffContent);
            break;
          default:
            throw new Error(`Unknown patch strategy: ${op.patchStrategy}`);
        }

        if (result.success) {
          finalContent = result.content;
        } else {
          throw new Error(result.error);
        }
      } catch (e) {
        throw new Error(`Error applying patch for ${op.path} with strategy ${op.patchStrategy}: ${getErrorMessage(e)}`);
      }
    }
    
    await writeFileContent(op.path, finalContent, cwd);
    newContents.set(op.path, finalContent);
  }
  return newContents;
};

// Helper to check if a directory is empty
const isDirectoryEmpty = async (dirPath: string): Promise<boolean> => {
  try {
    const files = await fs.readdir(dirPath);
    return files.length === 0;
  } catch (error) {
    // If directory doesn't exist or is not accessible, consider it "not empty"
    return false;
  }
};

// Recursively remove all empty parent directories up to a limit
const removeEmptyParentDirectories = async (dirPath: string, rootDir: string): Promise<void> => {
  if (!dirPath.startsWith(rootDir) || dirPath === rootDir) {
    return;
  }
  
  try {
    const isEmpty = await isDirectoryEmpty(dirPath);
    if (isEmpty) {
      await fs.rmdir(dirPath);
      // Recursively check parent directory
      await removeEmptyParentDirectories(path.dirname(dirPath), rootDir);
    }
  } catch (error) {
    // Ignore directory removal errors, but don't continue up the chain
    if (!(error instanceof Error && 'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) {
      console.warn(`Failed to clean up directory ${dirPath}:`, getErrorMessage(error));
    }
  }
};

export const restoreSnapshot = async (snapshot: FileSnapshot, cwd: string = process.cwd()): Promise<void> => {
  const projectRoot = path.resolve(cwd);
  const entries = Object.entries(snapshot);
  const directoriesDeleted = new Set<string>();

  // Handle all file operations sequentially to ensure atomicity during rollback
  for (const [filePath, content] of entries) {
    const fullPath = path.resolve(cwd, filePath);
    try {
      if (content === null) {
        // If the file didn't exist in the snapshot, make sure it doesn't exist after restore
        try {
          await fs.unlink(fullPath);
          directoriesDeleted.add(path.dirname(fullPath));
        } catch (error) {
          if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            // File or directory already doesn't exist, which is fine
          } else {
            throw error;
          }
        }
      } else {
        // Create directory structure if needed
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        
        // Write the original content back to the file
        await fs.writeFile(fullPath, content, 'utf-8');
      }
    } catch (error) {
      console.error(`Failed to restore ${filePath}:`, error);
      throw error;
    }
  }
  
  // After all files are processed, clean up empty directories
  // Sort directories by depth (deepest first) to clean up nested empty dirs properly
  const sortedDirs = Array.from(directoriesDeleted)
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  
  // Process each directory that had files deleted
  for (const dir of sortedDirs) {
    await removeEmptyParentDirectories(dir, projectRoot);
  }
};
````

## File: src/core/state.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import { logger, isEnoentError, getErrorMessage } from '../utils/logger';
import { fileExists, safeRename } from './executor';

const stateDirectoryCache = new Map<string, boolean>();

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

export const getStateFilePath = (cwd: string, uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}.pending.yml` : `${uuid}.yml`;
  return path.join(getStateDirectory(cwd), fileName);
};

export const getUndoneStateFilePath = (cwd: string, uuid: string): string => {
  const fileName = `${uuid}.yml`;
  return path.join(getStateDirectory(cwd),'undone', fileName);
};

// Helper to get all committed transaction file names.
const getCommittedTransactionFiles = async (cwd: string): Promise<{ stateDir: string; files: string[] } | null> => {
    const stateDir = getStateDirectory(cwd);
    try {
        await fs.access(stateDir);
    } catch (e) {
        return null;
    }
    const files = await fs.readdir(stateDir);
    const transactionFiles = files.filter(f => f.endsWith('.yml') && !f.endsWith('.pending.yml'));
    return { stateDir, files: transactionFiles };
};

// Ensure state directory exists with caching for performance
const ensureStateDirectory = async (cwd: string): Promise<void> => {
  const dirPath = getStateDirectory(cwd);
  if (!stateDirectoryCache.has(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
    stateDirectoryCache.set(dirPath, true);
  }
};

export const hasBeenProcessed = async (cwd: string, uuid: string): Promise<boolean> => {
  const committedPath = getStateFilePath(cwd, uuid, false);
  const undonePath = getUndoneStateFilePath(cwd, uuid);
  // Check if a transaction has been committed or undone.
  // This allows re-processing a transaction that failed and left an orphaned .pending.yml
  // because we don't check for `.pending.yml` files.
  return (await fileExists(committedPath)) || (await fileExists(undonePath));
};

export const writePendingState = async (cwd: string, state: StateFile): Promise<void> => {
  const validatedState = StateFileSchema.parse(state);
  const yamlString = yaml.dump(validatedState);
  const filePath = getStateFilePath(cwd, state.uuid, true);
  
  // Ensure directory exists (cached)
  await ensureStateDirectory(cwd);
  
  // Write file
  await fs.writeFile(filePath, yamlString, 'utf-8');
};

export const commitState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  const committedPath = getStateFilePath(cwd, uuid, false);
  await safeRename(pendingPath, committedPath);
};

export const deletePendingState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  try {
    await fs.unlink(pendingPath);
  } catch (error) {
    if (isEnoentError(error)) {
      // Already gone, that's fine.
      return;
    }
    throw error;
  }
};

export const readStateFile = async (cwd: string, uuid: string): Promise<StateFile | null> => {
  const committedPath = getStateFilePath(cwd, uuid, false);
  try {
    const fileContent = await fs.readFile(committedPath, 'utf-8');
    const yamlContent = yaml.load(fileContent);
    const parsed = StateFileSchema.safeParse(yamlContent);
    if (parsed.success) {
      return parsed.data;
    }
    logger.debug(`Could not parse state file ${committedPath}: ${parsed.error.message}`);
    return null;
  } catch (error) {
    // Can be file not found or YAML parsing error.
    // In any case, we can't get the state file.
    return null;
  }
};

export const readAllStateFiles = async (cwd: string = process.cwd()): Promise<StateFile[] | null> => {
    const transactionFileInfo = await getCommittedTransactionFiles(cwd);
    if (!transactionFileInfo) {
        return null;
    }
    const { files: transactionFiles } = transactionFileInfo;
    
    const promises = transactionFiles.map(async (file) => {
        const stateFile = await readStateFile(cwd, file.replace('.yml', ''));
        if (!stateFile) {
            logger.warn(`Could not read or parse state file ${file}. Skipping.`);
        }
        return stateFile;
    });

    const results = await Promise.all(promises);
    const validResults = results.filter((sf): sf is StateFile => !!sf);

    // Sort transactions by date, most recent first
    validResults.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return validResults;
}

export const findLatestStateFile = async (cwd: string = process.cwd()): Promise<StateFile | null> => {
    const transactionFileInfo = await getCommittedTransactionFiles(cwd);
    if (!transactionFileInfo || transactionFileInfo.files.length === 0) {
        return null;
    }
    const { stateDir, files: transactionFiles } = transactionFileInfo;
    
    // Read creation date from each file without parsing the whole thing.
    // This is much faster than reading and parsing the full YAML for every file.
    const filesWithDates = await Promise.all(
        transactionFiles.map(async (file) => {
            const filePath = path.join(stateDir, file);
            let createdAt: Date | null = null;
            try {
                // Read only the first 512 bytes to find `createdAt`. This is an optimization.
                const fileHandle = await fs.open(filePath, 'r');
                const buffer = Buffer.alloc(512);
                await fileHandle.read(buffer, 0, 512, 0);
                await fileHandle.close();
                const content = buffer.toString('utf-8');
                // Extract date from a line like 'createdAt: 2023-01-01T00:00:00.000Z'
                const match = content.match(/^createdAt:\s*['"]?(.+?)['"]?$/m);
                if (match && match[1]) {
                    createdAt = new Date(match[1]);
                }
            } catch (error) {
                if (!isEnoentError(error)) {
                  logger.debug(`Could not read partial date from ${file}: ${getErrorMessage(error)}`);
                }
            }
            return { file, createdAt };
        })
    );

    const validFiles = filesWithDates.filter(f => f.createdAt instanceof Date) as { file: string; createdAt: Date }[];

    if (validFiles.length === 0) {
        // Fallback for safety, though it should be rare.
        const transactions = await readAllStateFiles(cwd);
        return transactions?.[0] ?? null;
    }

    validFiles.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const latestFile = validFiles[0];
    if (!latestFile) {
        return null;
    }

    // Now read the full content of only the latest file
    return readStateFile(cwd, latestFile.file.replace('.yml', ''));
};
````

## File: src/core/transaction.ts
````typescript
import { Config, ParsedLLMResponse, StateFile, FileSnapshot, FileOperation } from '../types';
import { logger, getErrorMessage } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';
import { notifyApprovalRequired, notifyFailure, notifySuccess } from '../utils/notifier';

type Prompter = (question: string) => Promise<boolean>;

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
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

    logger.log('\nSummary:');
    logger.log(`Applied ${operations.length} file operation(s) successfully.`);
    logger.log(`Total time from start to commit: ${duration.toFixed(2)}ms`);
    logger.success(`✅ Transaction ${uuid} committed successfully!`);
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
            logger.success(`↩️ Transaction ${uuid} rolled back.`);
            notifyFailure(uuid, enableNotifications);
        } catch (cleanupError) {
            logger.error(`Fatal: Could not clean up pending state for ${uuid}: ${getErrorMessage(cleanupError)}`);
        }
    }
};

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const cwd = options?.cwd || process.cwd();
    const prompter = options?.prompter || getConfirmation;
    const { control, operations, reasoning } = parsedResponse;
    const { uuid, projectId } = control;
    const startTime = performance.now();

    // 1. Validation
    if (projectId !== config.projectId) {
        logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
        return;
    }
    if (await hasBeenProcessed(cwd, uuid)) {
        logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
        return;
    }

    // 2. Pre-flight checks
    if (config.preCommand) {
        logger.log(`  - Running pre-command: ${config.preCommand}`);
        const { exitCode, stderr } = await executeShellCommand(config.preCommand, cwd);
        if (exitCode !== 0) {
            logger.error(`Pre-command failed with exit code ${exitCode}, aborting transaction.`);
            if (stderr) logger.error(`Stderr: ${stderr}`);
            return;
        }
    }

    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);

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
        uuid, projectId, createdAt: new Date().toISOString(), reasoning, operations, snapshot, approved: false,
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
                logger.success(`✔ Written: ${op.path} (+${stats.added}, -${stats.removed})`);
            } else if (op.type === 'delete') {
                logger.success(`✔ Deleted: ${op.path}`);
            } else if (op.type === 'rename') {
                logger.success(`✔ Renamed: ${op.from} -> ${op.to}`);
            }
            return stats;
        });

        // Run post-command
        if (config.postCommand) {
            logger.log(`  - Running post-command: ${config.postCommand}`);
            const postResult = await executeShellCommand(config.postCommand, cwd);
            if (postResult.exitCode !== 0) {
                logger.error(`Post-command failed with exit code ${postResult.exitCode}.`);
                if (postResult.stderr) logger.error(`Stderr: ${postResult.stderr}`);
                throw new Error('Post-command failed, forcing rollback.');
            }
        }

        // Log summary before asking for approval
        const checksDuration = performance.now() - startTime;
        const totalAdded = opStats.reduce((sum, s) => sum + s.added, 0);
        const totalRemoved = opStats.reduce((sum, s) => sum + s.removed, 0);

        logger.log('\nPre-flight summary:');
        logger.success(`Lines changed: +${totalAdded}, -${totalRemoved}`);
        logger.log(`Checks completed in ${checksDuration.toFixed(2)}ms`);

        // Check for approval
        const finalErrorCount = await getErrorCount(config.linter, cwd);
        logger.log(`  - Final linter error count: ${finalErrorCount}`);
        
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
````

## File: package.json
````json
{
  "name": "relaycode",
  "version": "1.0.13",
  "description": "A developer assistant that automates applying code changes from LLMs.",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "relay": "./dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "clean": "rm -rf dist",
    "build": "bun run clean && bun build ./src/index.ts ./src/cli.ts --outdir ./dist --target node",
    "test": "bun test",
    "dev": "bun run src/cli.ts",
    "prepublishOnly": "bun run build"
  },
  "dependencies": {
    "chalk": "^5.4.1",
    "clipboardy": "^4.0.0",
    "commander": "^12.1.0",
    "diff-apply": "^1.0.6",
    "js-yaml": "^4.1.0",
    "toasted-notifier": "^10.1.0",
    "uuid": "^9.0.1",
    "zod": "^3.25.67"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/js-yaml": "^4.0.9",
    "@types/uuid": "^9.0.8",
    "typescript": "^5.8.3"
  },
  "keywords": [
    "ai",
    "llm",
    "automation",
    "codegen",
    "developer-tool",
    "cli"
  ],
  "author": "Relay Code",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/relaycoder/relaycode.git"
  },
  "homepage": "https://relay.code"
}
````
