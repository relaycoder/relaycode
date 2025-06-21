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
test/e2e/log.test.ts
test/e2e/undo.test.ts
test/test.util.ts
tsconfig.json
```

# Files

## File: test/e2e/log.test.ts
````typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';
import { logCommand } from '../../src/commands/log';
import { initCommand } from '../../src/commands/init';

describe('e2e/log', () => {
    let context: E2ETestContext;
    let logs: string[];

    beforeEach(async () => {
        context = await setupE2ETest();
        logs = [];
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should display a warning when the state directory does not exist', async () => {
        await logCommand(context.testDir.path, logs);
        const output = logs.join('\n');
        expect(output).toContain("State directory '.relaycode' not found. No logs to display.");
        expect(output).toContain("Run 'relay init' to initialize the project.");
    });

    it('should display a message when no transactions are found in an initialized project', async () => {
        // Initialize the project to create the config and state directory
        await initCommand(context.testDir.path);

        await logCommand(context.testDir.path, logs);
        const output = logs.join('\n');
        expect(output).toContain('info: No committed transactions found.');
    });

    it('should correctly display a single transaction', async () => {
        const testFile = 'src/index.ts';
        const newContent = 'console.log("hello");';
        const reasoning = 'This is the reason for the change.';
        await createTestFile(context.testDir.path, testFile, 'original');

        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: newContent }],
            { responseOverrides: { reasoning: [reasoning] } }
        );

        await logCommand(context.testDir.path, logs);
        const output = logs.join('\n');

        expect(output).toContain('Committed Transactions (most recent first):');
        expect(output).toContain(`- UUID: ${uuid}`);
        expect(output).toContain('Date:');
        expect(output).toContain('Reasoning:');
        expect(output).toContain(`- ${reasoning}`);
        expect(output).toContain('Changes:');
        expect(output).toContain(`- write: ${testFile}`);
    });

    it('should display multiple transactions in reverse chronological order', async () => {
        // Transaction 1
        const { uuid: uuid1 } = await runProcessPatch(
            context, {},
            [{ type: 'new', path: 'src/first.ts', content: '' }]
        );
        // Wait a bit to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 50));

        // Transaction 2
        const { uuid: uuid2 } = await runProcessPatch(
            context, {},
            [{ type: 'edit', path: 'src/first.ts', content: 'v2' }]
        );

        await logCommand(context.testDir.path, logs);
        const output = logs.join('\n');

        const indexOfUuid1 = output.indexOf(uuid1);
        const indexOfUuid2 = output.indexOf(uuid2);

        expect(indexOfUuid1).toBeGreaterThan(-1);
        expect(indexOfUuid2).toBeGreaterThan(-1);
        // uuid2 is more recent, so it should appear first (lower index)
        expect(indexOfUuid2).toBeLessThan(indexOfUuid1);
        expect(output).toContain(`- write: src/first.ts`);
    });

    it('should correctly display a transaction with multiple operations', async () => {
        await createTestFile(context.testDir.path, 'src/to-delete.ts', 'content');
        await createTestFile(context.testDir.path, 'src/main.ts', 'original content');

        const { uuid } = await runProcessPatch(
            context, {},
            [
                { type: 'edit', path: 'src/main.ts', content: 'main' },
                { type: 'new', path: 'src/new.ts', content: 'new' },
                { type: 'delete', path: 'src/to-delete.ts' }
            ]
        );

        await logCommand(context.testDir.path, logs);
        const output = logs.join('\n');

        expect(output).toContain(`- UUID: ${uuid}`);
        const changesSection = output.slice(output.indexOf('Changes:'));
        expect(changesSection).toContain('- write: src/main.ts');
        expect(changesSection).toContain('- write: src/new.ts');
        expect(changesSection).toContain('- delete: src/to-delete.ts');
    });
});
````

## File: test/e2e/undo.test.ts
````typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';
import { undoCommand } from '../../src/commands/undo';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';

describe('e2e/undo', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should successfully undo a single file modification', async () => {
        const testFile = 'src/index.js';
        const originalContent = `console.log('original');`;
        const modifiedContent = `console.log('modified');`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        // 1. Apply a patch to create a transaction
        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: modifiedContent }]
        );

        // Verify file was modified
        const contentAfterPatch = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterPatch).toBe(modifiedContent);
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(true);

        // 2. Run undo command with auto-approval
        await undoCommand(context.testDir.path, async () => true);

        // 3. Verify changes
        const contentAfterUndo = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterUndo).toBe(originalContent);

        // Original transaction file should be moved to 'undone'
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(false);
        const undoneFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, 'undone', `${uuid}.yml`);
        expect(await fs.access(undoneFilePath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should cancel undo operation if user declines', async () => {
        const testFile = 'src/index.js';
        const originalContent = `console.log('original');`;
        const modifiedContent = `console.log('modified');`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: modifiedContent }]
        );

        const contentAfterPatch = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterPatch).toBe(modifiedContent);

        // Run undo command and decline confirmation
        await undoCommand(context.testDir.path, async () => false);

        // Verify that nothing changed
        const contentAfterUndo = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterUndo).toBe(modifiedContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(true);
        const undoneFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, 'undone', `${uuid}.yml`);
        expect(await fs.access(undoneFilePath).then(() => true).catch(() => false)).toBe(false);
    });

    it('should do nothing when no transactions exist', async () => {
        // Run undo in a directory with no .relaycode state
        await undoCommand(context.testDir.path);

        // The command should just log a warning and exit. No files should be created.
        const relaycodeDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const dirExists = await fs.access(relaycodeDir).then(() => true).catch(() => false);
        expect(dirExists).toBe(false);
    });

    it('should correctly undo a complex transaction (edit, delete, create)', async () => {
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await createTestFile(context.testDir.path, fileToModify, originalModifyContent);
        
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const newFilePath = 'src/components/new.ts';
        const newFileContent = 'export const c = 3;';
    
        // 1. Apply a complex patch
        const { uuid } = await runProcessPatch(
            context,
            {},
            [
                { type: 'edit', path: fileToModify, content: 'export const a = 100;' },
                { type: 'delete', path: fileToDelete },
                { type: 'new', path: newFilePath, content: newFileContent }
            ]
        );

        // Verify the patch was applied correctly
        const modifiedContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(modifiedContent).toBe('export const a = 100;');
        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);
        const newFileContentOnDisk = await fs.readFile(path.join(context.testDir.path, newFilePath), 'utf-8');
        expect(newFileContentOnDisk).toBe(newFileContent);
        const newFileDirExists = await fs.access(path.join(context.testDir.path, 'src/components')).then(() => true).catch(() => false);
        expect(newFileDirExists).toBe(true);

        // 2. Run undo
        await undoCommand(context.testDir.path, async () => true);

        // 3. Verify rollback
        const restoredModifyContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(restoredModifyContent).toBe(originalModifyContent);
        
        const restoredDeleteFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredDeleteFileExists).toBe(true);
        const restoredDeleteContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(restoredDeleteContent).toBe(originalDeleteContent);
        
        const newFileExistsAfterUndo = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExistsAfterUndo).toBe(false);
        
        // The `components` directory should also be removed as it's now empty
        const newFileDirExistsAfterUndo = await fs.access(path.join(context.testDir.path, 'src/components')).then(() => true).catch(() => false);
        expect(newFileDirExistsAfterUndo).toBe(false);

        // Verify transaction file was moved
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(false);
        const undoneFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, 'undone', `${uuid}.yml`);
        expect(await fs.access(undoneFilePath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should only undo the most recent transaction', async () => {
        const testFile = 'src/index.js';
        const originalContent = `console.log('v1');`;
        const v2Content = `console.log('v2');`;
        const v3Content = `console.log('v3');`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        // Transaction 1
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: v2Content }]);
        let content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v2Content);
        
        // Transaction 2
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: v3Content }]);
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v3Content);

        // Undo Transaction 2
        await undoCommand(context.testDir.path, async () => true);

        // Verify file is back to v2 state
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v2Content);

        // Undo again (Transaction 1)
        await undoCommand(context.testDir.path, async () => true);

        // Verify file is back to original state
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(originalContent);
    });
});
````

## File: src/commands/apply.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { loadConfigOrExit } from '../core/config';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';

export const applyCommand = async (filePath: string): Promise<void> => {
    const cwd = process.cwd();

    const config = await loadConfigOrExit(cwd);
    
    logger.setLevel(config.logLevel);

    let content: string;
    const absoluteFilePath = path.resolve(cwd, filePath);
    try {
        content = await fs.readFile(absoluteFilePath, 'utf-8');
        logger.info(`Reading patch from file: ${absoluteFilePath}`);
    } catch (error) {
        logger.error(`Failed to read patch file at '${absoluteFilePath}': ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
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

## File: src/commands/revert.ts
````typescript
import { loadConfigOrExit } from '../core/config';
import { readStateFile } from '../core/state';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { FileOperation, ParsedLLMResponse } from '../types';
import { v4 as uuidv4 } from 'uuid';

export const revertCommand = async (uuidToRevert: string): Promise<void> => {
    const cwd = process.cwd();

    const config = await loadConfigOrExit(cwd);

    // 2. Load the state file for the transaction to revert
    logger.info(`Attempting to revert transaction: ${uuidToRevert}`);
    const stateToRevert = await readStateFile(cwd, uuidToRevert);
    if (!stateToRevert) {
        logger.error(`Transaction with UUID '${uuidToRevert}' not found or is invalid.`);
        return;
    }

    // 3. Generate inverse operations
    const inverse_operations: FileOperation[] = [];
    // Process operations in reverse order to handle dependencies correctly
    for (const op of [...stateToRevert.operations].reverse()) {
        switch (op.type) {
            case 'rename':
                inverse_operations.push({ type: 'rename', from: op.to, to: op.from });
                break;
            case 'delete':
                const deletedContent = stateToRevert.snapshot[op.path];
                if (deletedContent === null || typeof deletedContent === 'undefined') {
                    logger.warn(`Cannot revert deletion of ${op.path}, original content not found in snapshot. Skipping.`);
                    continue;
                }
                inverse_operations.push({
                    type: 'write',
                    path: op.path,
                    content: deletedContent,
                    patchStrategy: 'replace',
                });
                break;
            case 'write':
                const originalContent = stateToRevert.snapshot[op.path];
                if (typeof originalContent === 'undefined') {
                    logger.warn(`Cannot find original state for ${op.path} in snapshot. Skipping revert for this operation.`);
                    continue;
                }
                if (originalContent === null) {
                    // This was a new file. The inverse is to delete it.
                    inverse_operations.push({ type: 'delete', path: op.path });
                } else {
                    // This was a file modification. The inverse is to restore original content.
                    inverse_operations.push({
                        type: 'write',
                        path: op.path,
                        content: originalContent,
                        patchStrategy: 'replace',
                    });
                }
                break;
        }
    }

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

## File: src/commands/log.ts
````typescript
import { logger } from '../utils/logger';
import { FileOperation } from '../types';
import { readAllStateFiles } from '../core/state';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const opToString = (op: FileOperation): string => {
    switch (op.type) {
        case 'write': return `write: ${op.path}`;
        case 'delete': return `delete: ${op.path}`;
        case 'rename': return `rename: ${op.from} -> ${op.to}`;
    }
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

    transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    log('Committed Transactions (most recent first):');
    log('-------------------------------------------');

    if (transactions.length === 0) {
        log('info: No valid transactions found.');
        return;
    }

    transactions.forEach(tx => {
        log(`- UUID: ${tx.uuid}`);
        log(`  Date: ${new Date(tx.createdAt).toLocaleString()}`);
        if (tx.reasoning && tx.reasoning.length > 0) {
            log('  Reasoning:');
            tx.reasoning.forEach(r => log(`    - ${r}`));
        }
        if (tx.operations && tx.operations.length > 0) {
            log('  Changes:');
            tx.operations.forEach(op => log(`    - ${opToString(op)}`));
        }
        log(''); // Newline for spacing
    });
};
````

## File: src/commands/undo.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import { findLatestStateFile } from '../core/state';
import { restoreSnapshot } from '../core/executor';
import { getConfirmation as defaultGetConfirmation } from '../utils/prompt';

type Prompter = (question: string) => Promise<boolean>;

export const undoCommand = async (cwd: string = process.cwd(), prompter?: Prompter): Promise<void> => {
    const getConfirmation = prompter || defaultGetConfirmation;
    logger.info('Attempting to undo the last transaction...');

    const latestTransaction = await findLatestStateFile(cwd);

    if (!latestTransaction) {
        logger.warn('No committed transactions found to undo.');
        return;
    }

    logger.log(`The last transaction to be undone is:`);
    logger.info(`- UUID: ${latestTransaction.uuid}`);
    logger.log(`  Date: ${new Date(latestTransaction.createdAt).toLocaleString()}`);
    if (latestTransaction.reasoning && latestTransaction.reasoning.length > 0) {
        logger.log('  Reasoning:');
        latestTransaction.reasoning.forEach(r => logger.log(`    - ${r}`));
    }
    logger.log('');

    const confirmed = await getConfirmation('Are you sure you want to undo this transaction? (y/N)');

    if (!confirmed) {
        logger.info('Undo operation cancelled.');
        return;
    }
    
    logger.info(`Undoing transaction ${latestTransaction.uuid}...`);

    try {
        await restoreSnapshot(latestTransaction.snapshot, cwd);
        logger.success('  - Successfully restored file snapshot.');

        const stateDir = path.resolve(cwd, STATE_DIRECTORY_NAME);
        const undoneDir = path.join(stateDir, 'undone');
        await fs.mkdir(undoneDir, { recursive: true });

        const oldPath = path.join(stateDir, `${latestTransaction.uuid}.yml`);
        const newPath = path.join(undoneDir, `${latestTransaction.uuid}.yml`);

        await fs.rename(oldPath, newPath);
        logger.success(`  - Moved transaction file to 'undone' directory.`);
        logger.success(`✅ Last transaction successfully undone.`);

    } catch (error) {
        logger.error(`Failed to undo transaction: ${error instanceof Error ? error.message : String(error)}`);
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
    writePendingState
} from './core/state';
export { processPatch } from './core/transaction';

// Types
export * from './types';

// Utils
export { executeShellCommand, getErrorCount } from './utils/shell';
export { logger } from './utils/logger';
export { getConfirmation } from './utils/prompt';
````

## File: src/core/config.ts
````typescript
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { Config, ConfigSchema } from '../types';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME } from '../utils/constants';
import { logger } from '../utils/logger';

export const findConfig = async (cwd: string = process.cwd()): Promise<Config | null> => {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);
  try {
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const configJson = JSON.parse(fileContent);
    return ConfigSchema.parse(configJson);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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
        approval: 'yes' as const,
        approvalOnErrorCount: 0,
        linter: 'bun tsc --noEmit',
        preCommand: '',
        postCommand: '',
        preferredStrategy: 'auto' as const,
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
  approval: z.enum(['yes', 'no']).default('yes'),
  approvalOnErrorCount: z.number().int().min(0).default(0),
  linter: z.string().default('bun tsc --noEmit'),
  preCommand: z.string().default(''),
  postCommand: z.string().default(''),
  preferredStrategy: z.enum(['auto', 'replace', 'new-unified', 'multi-search-replace']).default('auto'),
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

## File: src/commands/init.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { findConfig, createConfig, ensureStateDirExists, getProjectId } from '../core/config';
import { logger } from '../utils/logger';
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
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            await fs.writeFile(gitignorePath, entry.trim());
            logger.info(`Created ${GITIGNORE_FILE_NAME} and added ${STATE_DIRECTORY_NAME}/`);
        } else {
            logger.error(`Failed to update ${GITIGNORE_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
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
  "approval": "yes",
  "approvalOnErrorCount": 0,
  "linter": "bun tsc -b --noEmit",
  "preCommand": "",
  "postCommand": "",
  "preferredStrategy": "auto"
}
````

## File: src/core/clipboard.ts
````typescript
import clipboardy from 'clipboardy';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

type ClipboardCallback = (content: string) => void;
type ClipboardReader = () => Promise<string>;


// Direct Windows clipboard reader that uses the executable directly
const createDirectWindowsClipboardReader = (): ClipboardReader => {
  return () => new Promise((resolve) => {
    try {
      const localExePath = path.join(process.cwd(), 'fallbacks', 'windows', 'clipboard_x86_64.exe');
      if (!fs.existsSync(localExePath)) {
        logger.error('Windows clipboard executable not found. Cannot watch clipboard on Windows.');
        // Resolve with empty string to avoid stopping the watcher loop, but log an error.
        return resolve('');
      }
      
      const command = `"${localExePath}" --paste`;
      
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
      logger.error(`A synchronous error occurred while setting up clipboard reader: ${syncError instanceof Error ? syncError.message : String(syncError)}`);
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
        path.join(process.cwd(), 'fallbacks', 'windows')
      ];
      
      // Create fallbacks directory in the current project if it doesn't exist
      const localFallbacksDir = path.join(process.cwd(), 'fallbacks', 'windows');
      if (!fs.existsSync(localFallbacksDir)) {
        fs.mkdirSync(localFallbacksDir, { recursive: true });
      }
      
      // Find an existing executable
      let sourceExePath = null;
      for (const dir of possiblePaths) {
        const exePath = path.join(dir, 'clipboard_x86_64.exe');
        if (fs.existsSync(exePath)) {
          sourceExePath = exePath;
          break;
        }
      }
      
      // Copy the executable to the local fallbacks directory if found
      if (sourceExePath && sourceExePath !== path.join(localFallbacksDir, 'clipboard_x86_64.exe')) {
        fs.copyFileSync(sourceExePath, path.join(localFallbacksDir, 'clipboard_x86_64.exe'));
        logger.info('Copied Windows clipboard executable to local fallbacks directory');
      } else if (!sourceExePath) {
        logger.error('Windows clipboard executable not found in any location');
      }
    } catch (error) {
      logger.warn('Error ensuring clipboard executable: ' + (error instanceof Error ? error.message : String(error)));
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
      logger.warn('Could not read from clipboard: ' + (error instanceof Error ? error.message : String(error)));
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

## File: test/test.util.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { Config, PatchStrategy } from '../src/types';
import { CONFIG_FILE_NAME } from '../src/utils/constants';
import { logger } from '../src/utils/logger';
import { processPatch } from '../src/core/transaction';
import { parseLLMResponse } from '../src/core/parser';

export type Prompter = (message: string) => Promise<boolean>;
export interface TestDir {
    path: string;
    cleanup: () => Promise<void>;
}

export const setupTestDirectory = async (): Promise<TestDir> => {
    const testDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'relaycode-test-'));

    const cleanup = async () => {
        await fs.rm(testDirPath, { recursive: true, force: true });
    };

    return { path: testDirPath, cleanup };
};

export interface E2ETestContext {
    testDir: TestDir;
    cleanup: () => Promise<void>;
}

export const setupE2ETest = async (options: { withTsconfig?: boolean } = {}): Promise<E2ETestContext> => {
    const testDir = await setupTestDirectory();

    if (options.withTsconfig) {
        await createTestFile(testDir.path, 'tsconfig.json', JSON.stringify({
            "compilerOptions": { "strict": true, "noEmit": true, "isolatedModules": true },
            "include": ["src/**/*.ts"]
        }, null, 2));
    }
    
    // Suppress logger output
    const originalLogger = {
        info: (logger as any).info,
        log: (logger as any).log,
        warn: (logger as any).warn,
        error: (logger as any).error,
        success: (logger as any).success,
        prompt: (logger as any).prompt,
    };
    
    (logger as any).info = () => {};
    (logger as any).log = () => {};
    (logger as any).warn = () => {};
    (logger as any).error = () => {};
    if ((logger as any).success) (logger as any).success = () => {};
    if ((logger as any).prompt) (logger as any).prompt = () => {};


    const cleanup = async () => {
        // Restore logger
        (logger as any).info = originalLogger.info;
        (logger as any).log = originalLogger.log;
        (logger as any).warn = originalLogger.warn;
        (logger as any).error = originalLogger.error;
        if (originalLogger.success) (logger as any).success = originalLogger.success;
        if (originalLogger.prompt) (logger as any).prompt = originalLogger.prompt;
        
        // Give fs operations time to complete before cleanup
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Cleanup directory
        await testDir.cleanup();
    };

    return { testDir, cleanup };
};

export interface TestOperation {
    type: 'edit' | 'new' | 'delete';
    path: string;
    content?: string;
    strategy?: PatchStrategy;
}

export function createLLMResponseString(
    operations: TestOperation[],
    overrides: { uuid?: string, projectId?: string, reasoning?: string[] } = {}
): { response: string, uuid: string } {
    const uuid = overrides.uuid ?? uuidv4();
    const projectId = overrides.projectId ?? 'test-project';
    const reasoning = overrides.reasoning ?? [LLM_RESPONSE_START];

    const blocks = operations.map(op => {
        if (op.type === 'delete') {
            return createDeleteFileBlock(op.path);
        }
        return createFileBlock(op.path, op.content ?? '', op.strategy);
    });

    const changeSummary = operations.map(op => ({ [op.type]: op.path }));

    const response = [
        ...reasoning,
        ...blocks,
        LLM_RESPONSE_END(uuid, changeSummary, projectId)
    ].join('\n');

    return { response, uuid };
}

export async function runProcessPatch(
    context: E2ETestContext,
    configOverrides: Partial<Config>,
    operations: TestOperation[],
    options: { prompter?: Prompter, responseOverrides?: { uuid?: string, projectId?: string, reasoning?: string[] } } = {}
): Promise<{ uuid: string; config: Config }> {
    const config = await createTestConfig(context.testDir.path, configOverrides);
    
    const { response, uuid } = createLLMResponseString(operations, { ...options.responseOverrides, projectId: options.responseOverrides?.projectId ?? config.projectId });

    const parsedResponse = parseLLMResponse(response);
    if (!parsedResponse) {
        throw new Error("Failed to parse mock LLM response");
    }

    await processPatch(config, parsedResponse, { prompter: options.prompter, cwd: context.testDir.path });
    
    return { uuid, config };
}


export const createTestConfig = async (cwd: string, overrides: Partial<Config> = {}): Promise<Config> => {
    const defaultConfig: Config = {
        projectId: 'test-project',
        clipboardPollInterval: 100,
        approval: 'yes',
        approvalOnErrorCount: 0,
        linter: `bun -e "process.exit(0)"`, // A command that always succeeds
        preCommand: '',
        postCommand: '',
        logLevel: 'info',
        preferredStrategy: 'auto',
    };
    const config = { ...defaultConfig, ...overrides };
    await fs.writeFile(path.join(cwd, CONFIG_FILE_NAME), JSON.stringify(config, null, 2));
    return config;
};

export const createTestFile = async (cwd: string, filePath: string, content: string): Promise<void> => {
    const absolutePath = path.resolve(cwd, filePath);
    const dir = path.dirname(absolutePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absolutePath, content);
};

export const LLM_RESPONSE_START = `
I have analyzed your request and here are the changes.
First, I will edit the main file.
`;

export const LLM_RESPONSE_END = (uuid: string, changeSummary: { [key: string]: string }[] = [], projectId: string = 'test-project') => `
\`\`\`yaml
projectId: ${projectId}
uuid: ${uuid}
changeSummary: ${JSON.stringify(changeSummary)}
\`\`\`
`;

export const createFileBlock = (filePath: string, content: string, patchStrategy?: PatchStrategy): string => {
    const strategyString = patchStrategy ? ` ${patchStrategy}` : '';
    return `
\`\`\`typescript // ${filePath}${strategyString}
// START

${content}

// END
\`\`\`
`;
};

export const createDeleteFileBlock = (filePath: string): string => {
    return `
\`\`\`typescript // ${filePath}
//TODO: delete this file
\`\`\`
`;
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

## File: src/core/state.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { STATE_DIRECTORY_NAME } from '../utils/constants';
import { logger } from '../utils/logger';

const stateDirectoryCache = new Map<string, boolean>();

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

const getStateFilePath = (cwd: string, uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}.pending.yml` : `${uuid}.yml`;
  return path.join(getStateDirectory(cwd), fileName);
};

const getUndoneStateFilePath = (cwd: string, uuid: string): string => {
  const fileName = `${uuid}.yml`;
  return path.join(getStateDirectory(cwd),'undone', fileName);
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
  const undonePath = getUndoneStateFilePath(cwd,uuid);
  try {
    // Only check for a committed state file.
    // This allows re-processing a transaction that failed and left an orphaned .pending.yml
    await fs.access(committedPath);
    return true;
  } catch (e) {
    try {
      await fs.access(undonePath);
      return true;
    } catch (e) {
      return false;
    }
  }
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

  try {
    // fs.rename is atomic on most POSIX filesystems if src and dest are on the same partition.
    await fs.rename(pendingPath, committedPath);
  } catch (error) {
    // If rename fails with EXDEV, it's likely a cross-device move. Fallback to copy+unlink.
    if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
      await fs.copyFile(pendingPath, committedPath);
      await fs.unlink(pendingPath);
    } else {
      // Re-throw other errors
      throw error;
    }
  }
};

export const deletePendingState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  try {
    await fs.unlink(pendingPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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
    return StateFileSchema.parse(yamlContent);
  } catch (error) {
    // Can be file not found, YAML parsing error, or Zod validation error.
    // In any case, we can't get the state file.
    return null;
  }
};

export const readAllStateFiles = async (cwd: string = process.cwd()): Promise<StateFile[] | null> => {
    const stateDir = getStateDirectory(cwd);
    try {
        await fs.access(stateDir);
    } catch (e) {
        return null; // No state directory, so no transactions
    }

    const files = await fs.readdir(stateDir);
    const transactionFiles = files.filter(f => f.endsWith('.yml') && !f.endsWith('.pending.yml'));

    const promises = transactionFiles.map(async (file) => {
        const stateFile = await readStateFile(cwd, file.replace('.yml', ''));
        if (!stateFile) {
            logger.warn(`Could not read or parse state file ${file}. Skipping.`);
        }
        return stateFile;
    });

    const results = await Promise.all(promises);
    return results.filter((sf): sf is StateFile => !!sf);
}

export const findLatestStateFile = async (cwd: string = process.cwd()): Promise<StateFile | null> => {
    const transactions = await readAllStateFiles(cwd);
    if (!transactions || transactions.length === 0) {
        return null;
    }

    transactions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return transactions[0] || null;
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
import { dirname, join, resolve } from 'node:path';
import fs from 'node:fs';

// Default version in case we can't find the package.json
let version = '0.0.0';

try {
  // Try multiple strategies to find the package.json
  const require = createRequire(import.meta.url);
  let pkg;
  
  // Strategy 1: Try to find package.json relative to the current file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // Try different possible locations
  const possiblePaths = [
    join(__dirname, 'package.json'),
    join(__dirname, '..', 'package.json'),
    join(__dirname, '..', '..', 'package.json'),
    resolve(process.cwd(), 'package.json')
  ];
  
  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      pkg = require(path);
      break;
    }
  }
  
  // Strategy 2: If we still don't have it, try to get it from the npm package name
  if (!pkg) {
    try {
      pkg = require('relaycode/package.json');
    } catch (e) {
      // Ignore this error
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

program
  .command('init')
  .alias('i')
  .description('Initializes relaycode in the current project.')
  .action(() => initCommand());

program
  .command('watch')
  .alias('w')
  .description('Starts watching the clipboard for code changes to apply.')
  .action(watchCommand);

program
  .command('apply')
  .alias('a')
  .description('Applies a patch from a specified file.')
  .argument('<filePath>', 'The path to the file containing the patch.')
  .action(applyCommand);

program
  .command('log')
  .alias('l')
  .description('Displays a log of all committed transactions.')
  .action(() => logCommand());

program
  .command('undo')
  .alias('u')
  .description('Reverts the last successfully committed transaction.')
  .action(() => undoCommand());

program
  .command('revert')
  .alias('r')
  .description('Reverts a committed transaction by its UUID.')
  .argument('<uuid>', 'The UUID of the transaction to revert.')
  .action(revertCommand);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}
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

    let syntax = '';
    let strategyDetails = '';

    switch (preferredStrategy) {
        case 'replace':
            syntax = syntaxReplace;
            strategyDetails = ''; // Covered in 'otherOps'
            break;
        case 'new-unified':
            syntax = syntaxNewUnified;
            strategyDetails = sectionNewUnified;
            break;
        case 'multi-search-replace':
            syntax = syntaxMultiSearchReplace;
            strategyDetails = sectionMultiSearchReplace;
            break;
        case 'auto':
        default:
            syntax = syntaxAuto;
            strategyDetails = `${sectionNewUnified}\n${sectionMultiSearchReplace}`;
            break;
    }

    return [header, intro, syntax, strategyDetails, otherOps, finalSteps, footer].filter(Boolean).join('\n');
}

export const watchCommand = async (): Promise<void> => {
  let clipboardWatcher: ReturnType<typeof createClipboardWatcher> | null = null;
  const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
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

      notifyPatchDetected(config.projectId);
      logger.success(`Valid patch detected for project '${config.projectId}'. Processing...`);
      await processPatch(config, parsedResponse);
      logger.info('--------------------------------------------------');
      logger.info('Watching for next patch...');
    });
  };

  const handleConfigChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      logger.info(`Configuration file change detected. Reloading...`);
      try {
        const newConfig = await findConfig();
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
  const initialConfig = await loadConfigOrExit();
  logger.success('Configuration loaded. Starting relaycode watch...');
  startServices(initialConfig);

  // Watch for changes after initial setup
  fs.watch(configPath, handleConfigChange);
};
````

## File: src/core/executor.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';
import { newUnifiedDiffStrategyService, multiSearchReplaceService, unifiedDiffService } from 'diff-apply';

export const readFileContent = async (filePath: string, cwd: string = process.cwd()): Promise<string | null> => {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // File already deleted, which is fine.
      return;
    }
    throw error;
  }
};

export const renameFile = async (fromPath: string, toPath: string, cwd: string = process.cwd()): Promise<void> => {
  const fromAbsolutePath = path.resolve(cwd, fromPath);
  const toAbsolutePath = path.resolve(cwd, toPath);
  await fs.mkdir(path.dirname(toAbsolutePath), { recursive: true });
  try {
    await fs.rename(fromAbsolutePath, toAbsolutePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
      await fs.copyFile(fromAbsolutePath, toAbsolutePath);
      await fs.unlink(fromAbsolutePath);
    } else {
      throw error;
    }
  }
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
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
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

export const applyOperations = async (operations: FileOperation[], cwd: string = process.cwd()): Promise<void> => {
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
    
    if (op.patchStrategy === 'replace') {
      await writeFileContent(op.path, op.content, cwd);
      continue;
    }

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
        await writeFileContent(op.path, result.content, cwd);
      } else {
        throw new Error(result.error);
      }
    } catch (e) {
      throw new Error(`Error applying patch for ${op.path} with strategy ${op.patchStrategy}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
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
      console.warn(`Failed to clean up directory ${dirPath}:`, error);
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

## File: src/core/transaction.ts
````typescript
import { Config, ParsedLLMResponse, StateFile, FileSnapshot, FileOperation } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations, readFileContent } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';
import { notifyApprovalRequired, notifyFailure, notifySuccess } from '../utils/notifier';

type Prompter = (question: string) => Promise<boolean>;

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
};

const calculateLineChanges = async (op: FileOperation, snapshot: FileSnapshot, cwd: string): Promise<{ added: number; removed: number }> => {
    if (op.type === 'rename') {
        return { added: 0, removed: 0 };
    }
    const oldContent = snapshot[op.path] ?? null;

    if (op.type === 'delete') {
        const oldLines = oldContent ? oldContent.split('\n') : [];
        return { added: 0, removed: oldLines.length };
    }

    // After applyOperations, the new content is on disk
    const newContent = await readFileContent(op.path, cwd);
    if (oldContent === newContent) return { added: 0, removed: 0 };

    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];

    if (oldContent === null || oldContent === '') return { added: newLines.length, removed: 0 };
    if (newContent === null || newContent === '') return { added: 0, removed: oldLines.length };
    
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    
    const added = newLines.filter(line => !oldSet.has(line)).length;
    const removed = oldLines.filter(line => !newSet.has(line)).length;
    
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

const rollbackTransaction = async (cwd: string, uuid: string, snapshot: FileSnapshot, reason: string): Promise<void> => {
    logger.warn(`Rolling back changes: ${reason}`);
    try {
        await restoreSnapshot(snapshot, cwd);
        logger.success('  - Files restored to original state.');
    } catch (error) {
        logger.error(`Fatal: Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        // Do not rethrow; we're already in a final error handling state.
    } finally {
        try {
            await deletePendingState(cwd, uuid);
            logger.success(`↩️ Transaction ${uuid} rolled back.`);
            notifyFailure(uuid);
        } catch (cleanupError) {
            logger.error(`Fatal: Could not clean up pending state for ${uuid}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
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
        await applyOperations(operations, cwd);
        logger.success('  - File operations complete.');

        const opStatsPromises = operations.map(async op => {
            const stats = await calculateLineChanges(op, snapshot, cwd);
            if (op.type === 'write') {
                logger.success(`✔ Written: ${op.path} (+${stats.added}, -${stats.removed})`);
            } else if (op.type === 'delete') {
                logger.success(`✔ Deleted: ${op.path}`);
            } else if (op.type === 'rename') {
                logger.success(`✔ Renamed: ${op.from} -> ${op.to}`);
            }
            return stats;
        });
        const opStats = await Promise.all(opStatsPromises);

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
        if (config.approval === 'yes') { // config.approval === 'yes' is default, allows auto-approval
            const canAutoApprove = finalErrorCount <= config.approvalOnErrorCount;

            if (canAutoApprove) {
                logger.success('  - Changes automatically approved based on your configuration.');
                isApproved = true;
            } else {
                notifyApprovalRequired(config.projectId);
                isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
            }
        } else { // config.approval === 'no' now means "always prompt"
            logger.warn('Manual approval required because "approval" is set to "no".');
            notifyApprovalRequired(config.projectId);
            isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
        }

        if (isApproved) {
            stateFile.approved = true;
            await writePendingState(cwd, stateFile); // Update state with approved: true before commit
            await commitState(cwd, uuid);
            logCompletionSummary(uuid, startTime, operations);
            notifySuccess(uuid);
        } else {
            throw new Error('Changes were not approved.');
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await rollbackTransaction(cwd, uuid, snapshot, reason);
    }
};
````

## File: package.json
````json
{
  "name": "relaycode",
  "version": "1.0.11",
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
    "relaycode": "^1.0.2",
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
