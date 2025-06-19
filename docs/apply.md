Of course! I can help you with these errors. It looks like a mix of TypeScript compilation issues and failing tests. I'll address them one by one. Here are the necessary code changes to fix the problems.

### TypeScript Compiler and Test Fixes

Here are the fixes for the issues found during compilation and testing:

1.  **`src/commands/watch.ts`**: The clipboard watcher now starts automatically upon creation. The explicit `.start()` call, which was causing an error, has been removed.
2.  **`src/core/clipboard.ts`**: The `logger.warn` function call was corrected to pass a single string argument, resolving the compilation error.
3.  **`src/core/transaction.ts`**:
    *   Added non-null assertions (`!`) to the LSC algorithm in `calculateLineChanges` to satisfy TypeScript's strict `noUncheckedIndexedAccess` option.
    *   Ensured that potentially `undefined` values are handled correctly when calculating line changes.
    *   Improved the error handling logic to ensure that even if restoring files from a snapshot fails (e.g., due to file permissions), the transaction's temporary `.pending.yml` file is still correctly removed.
4.  **`test/e2e/init.test.ts`**: The test that verifies the system prompt output was updated to match the current prompt format, ensuring it checks for the correct content.
5.  **`test/e2e/transaction.test.ts`**:
    *   The test setup now creates a more complete `tsconfig.json`, allowing the linter to correctly find and check files during tests. This fixes the test for manual approval on linter errors.
    *   A test that was failing due to extra whitespace in the mock LLM response has been fixed by trimming the input.
    *   The test for pre/post commands now uses a cross-platform command (`bun -e "..."`) instead of the Unix-specific `touch` command, allowing it to pass on systems like Windows.

Here is the full source code for the modified files:

```typescript // src/commands/watch.ts
import { findConfig } from '../core/config';
import { createClipboardWatcher } from '../core/clipboard';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME } from '../utils/constants';

export const watchCommand = async (): Promise<void> => {
  const config = await findConfig();

  if (!config) {
    logger.error(`Configuration file '${CONFIG_FILE_NAME}' not found.`);
    logger.info("Please run 'relay init' to create one.");
    process.exit(1);
  }
  
  logger.success('Configuration loaded. Starting relaycode watch...');

  createClipboardWatcher(config.clipboardPollInterval, async (content) => {
    logger.info('New clipboard content detected. Attempting to parse...');
    const parsedResponse = parseLLMResponse(content);

    if (!parsedResponse) {
      logger.warn('Clipboard content is not a valid relaycode patch. Ignoring.');
      return;
    }
    
    logger.success('Valid patch format detected. Processing...');
    await processPatch(config, parsedResponse);
    logger.info('--------------------------------------------------');
    logger.info('Watching for next patch...');
  });
};
```

```typescript // src/core/clipboard.ts
import clipboardy from 'clipboardy';
import { logger } from '../utils/logger';

type ClipboardCallback = (content: string) => void;
type ClipboardReader = () => Promise<string>;

export const createClipboardWatcher = (
  pollInterval: number,
  callback: ClipboardCallback,
  reader: ClipboardReader = clipboardy.read,
) => {
  let lastContent = '';
  let intervalId: NodeJS.Timeout | null = null;

  const checkClipboard = async () => {
    try {
      const content = await reader();
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
```

```typescript // src/core/transaction.ts
// src/core/transaction.ts
import { Config, ParsedLLMResponse, StateFile, FileSnapshot } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, writeFileContent, deleteFile, restoreSnapshot } from './executor';
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

    const oldLen = oldLines.length;
    const newLen = newLines.length;
    
    const lcs = Array(oldLen + 1).fill(null).map(() => Array(newLen + 1).fill(0));

    for (let i = 1; i <= oldLen; i++) {
        for (let j = 1; j <= newLen; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                lcs[i]![j] = lcs[i - 1]![j - 1] + 1;
            } else {
                lcs[i]![j] = Math.max(lcs[i - 1]![j], lcs[i]![j - 1]);
            }
        }
    }

    const commonLines = lcs[oldLen]![newLen];
    return {
        added: newLen - commonLines,
        removed: oldLen - commonLines,
    };
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
    await writePendingState(cwd, stateFile);
    logger.success('  - Staged changes to .pending.yml file.');

    // --- Execution Phase ---
    const opStats: Array<{ type: 'Written' | 'Deleted', path: string, added: number, removed: number }> = [];
    
    try {
      logger.log('  - Applying file operations...');
      for (const op of operations) {
        if (op.type === 'write') {
            const oldContent = snapshot[op.path];
            await writeFileContent(op.path, op.content, cwd);
            const { added, removed } = calculateLineChanges(oldContent ?? null, op.content);
            opStats.push({ type: 'Written', path: op.path, added, removed });
        } else { // op.type === 'delete'
            const oldContent = snapshot[op.path];
            await deleteFile(op.path, cwd);
            const { added, removed } = calculateLineChanges(oldContent ?? null, '');
            opStats.push({ type: 'Deleted', path: op.path, added, removed });
        }
      }
      logger.success('File operations complete.');
      opStats.forEach(stat => {
        if (stat.type === 'Written') {
          logger.success(`✔ Written: ${stat.path} (+${stat.added}, -${stat.removed})`);
        } else {
          logger.success(`✔ Deleted: ${stat.path}`);
        }
      });
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

    const finalErrorCount = await getErrorCount(config.linter, cwd);
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
        await writePendingState(cwd, finalState); 
        await commitState(cwd, uuid);

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
```

```typescript // test/e2e/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { initCommand } from '../../src/commands/init';
import { setupTestDirectory, TestDir, createTestFile } from '../test.util';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../../src/utils/constants';
import { ConfigSchema } from '../../src/types';

describe('e2e/init', () => {
    let testDir: TestDir;

    beforeEach(async () => {
        testDir = await setupTestDirectory();
    });

    afterEach(async () => {
        await testDir.cleanup();
    });

    it('should create config file with correct defaults, state directory, and .gitignore', async () => {
        // Suppress console output for this test
        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog; // Restore console output

        // Check for config file
        const configPath = path.join(testDir.path, CONFIG_FILE_NAME);
        const configExists = await fs.access(configPath).then(() => true).catch(() => false);
        expect(configExists).toBe(true);

        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        
        // Validate against schema to check defaults
        const parsedConfig = ConfigSchema.parse(config);
        expect(parsedConfig.projectId).toBe(path.basename(testDir.path));
        expect(parsedConfig.clipboardPollInterval).toBe(2000);
        expect(parsedConfig.approval).toBe('yes');
        expect(parsedConfig.linter).toBe('bun tsc --noEmit');

        // Check for state directory
        const stateDirPath = path.join(testDir.path, STATE_DIRECTORY_NAME);
        const stateDirExists = await fs.stat(stateDirPath).then(s => s.isDirectory()).catch(() => false);
        expect(stateDirExists).toBe(true);

        // Check for .gitignore
        const gitignorePath = path.join(testDir.path, GITIGNORE_FILE_NAME);
        const gitignoreExists = await fs.access(gitignorePath).then(() => true).catch(() => false);
        expect(gitignoreExists).toBe(true);

        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should use package.json name for projectId if available', async () => {
        const pkgName = 'my-awesome-project';
        await createTestFile(testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        const originalLog = console.log;
        console.log = () => {};
        
        await initCommand(testDir.path);

        console.log = originalLog;

        const configPath = path.join(testDir.path, CONFIG_FILE_NAME);
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe(pkgName);
    });

    it('should append to existing .gitignore', async () => {
        const initialContent = '# Existing rules\nnode_modules/';
        await createTestFile(testDir.path, GITIGNORE_FILE_NAME, initialContent);

        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog;

        const gitignoreContent = await fs.readFile(path.join(testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        expect(gitignoreContent).toContain(initialContent);
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should not add entry to .gitignore if it already exists', async () => {
        const entry = `/${STATE_DIRECTORY_NAME}/`;
        const initialContent = `# Existing rules\n${entry}`;
        await createTestFile(testDir.path, GITIGNORE_FILE_NAME, initialContent);

        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog;

        const gitignoreContent = await fs.readFile(path.join(testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        const occurrences = (gitignoreContent.match(new RegExp(entry, 'g')) || []).length;
        expect(occurrences).toBe(1);
    });

    it('should not overwrite an existing relaycode.config.json', async () => {
        const customConfig = { projectId: 'custom', customField: true };
        await createTestFile(testDir.path, CONFIG_FILE_NAME, JSON.stringify(customConfig));

        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog;

        const configContent = await fs.readFile(path.join(testDir.path, CONFIG_FILE_NAME), 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe('custom');
        expect(config.customField).toBe(true);
    });

    it('should output the system prompt with the correct project ID', async () => {
        const capturedOutput: string[] = [];
        const originalLog = console.log;
        console.log = (message: string) => capturedOutput.push(message);

        const pkgName = 'my-prompt-project';
        await createTestFile(testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        await initCommand(testDir.path);

        console.log = originalLog; // Restore

        const outputString = capturedOutput.join('\n');
        expect(outputString).toContain(`projectId: ${pkgName}`);
        expect(outputString).toContain('Code changes rules 1-6:');
    });
});
```

```typescript // test/e2e/transaction.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { processPatch } from '../../src/core/transaction';
import { parseLLMResponse } from '../../src/core/parser';
import { setupTestDirectory, TestDir, createTestConfig, createTestFile, LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock } from '../test.util';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';

// Suppress console output for cleaner test logs
beforeEach(() => {
    global.console.info = () => {};
    global.console.log = () => {};
    global.console.warn = () => {};
    global.console.error = () => {};
    //@ts-ignore
    global.console.success = () => {};
});

describe('e2e/transaction', () => {
    let testDir: TestDir;
    const testFile = 'src/index.ts';
    const originalContent = 'console.log("original");';

    beforeEach(async () => {
        testDir = await setupTestDirectory();
        await createTestFile(testDir.path, testFile, originalContent);
        // A tsconfig is needed for `bun tsc` to run and find files
        await createTestFile(testDir.path, 'tsconfig.json', JSON.stringify({
            "compilerOptions": { "strict": true, "noEmit": true, "isolatedModules": true },
            "include": ["src/**/*.ts"]
        }));
    });

    afterEach(async () => {
        if (testDir) {
            await testDir.cleanup();
        }
    });

    it('should apply changes, commit, and store correct state in .yml file', async () => {
        const config = await createTestConfig(testDir.path, { linter: `bun tsc` });
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        // Check file content
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        // Check state file was committed
        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);

        // Check state file content
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.uuid).toBe(uuid);
        expect(stateData.approved).toBe(true);
        expect(stateData.operations).toHaveLength(1);
        expect(stateData.operations[0].path).toBe(testFile);
        expect(stateData.snapshot[testFile]).toBe(originalContent);
        expect(stateData.reasoning).toEqual(parsedResponse!.reasoning);
    });

    it('should rollback changes when manually disapproved', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const newContent = 'console.log("I will be rolled back");';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        const prompter = async () => false; // Disapprove
        await processPatch(config, parsedResponse!, { prompter, cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should require manual approval if linter errors exceed approvalOnErrorCount', async () => {
        const config = await createTestConfig(testDir.path, { 
            approval: 'yes',
            approvalOnErrorCount: 0,
            linter: `bun tsc`
        });
        
        const badContent = 'const x: string = 123;'; // 1 TS error
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                        createFileBlock(testFile, badContent) + 
                        LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        // Disapprove when prompted
        const prompter = async () => false;
        await processPatch(config, parsedResponse!, { prompter, cwd: testDir.path });
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    });

    it('should skip linter if command is empty and auto-approve', async () => {
        const config = await createTestConfig(testDir.path, { linter: '' });
        const badContent = 'const x: string = 123;'; // Would fail linter, but it's skipped
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(testFile, badContent) +
            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);
    });

    it('should ignore patch with already processed UUID', async () => {
        const config = await createTestConfig(testDir.path);
        const uuid = uuidv4();
        
        // 1. Process and commit a patch
        const response1 = LLM_RESPONSE_START + createFileBlock(testFile, "first change") + LLM_RESPONSE_END(uuid, []);
        const parsed1 = parseLLMResponse(response1)!;
        await processPatch(config, parsed1, { cwd: testDir.path });
        
        // 2. Try to process another patch with the same UUID
        const response2 = LLM_RESPONSE_START + createFileBlock(testFile, "second change") + LLM_RESPONSE_END(uuid, []);
        const parsed2 = parseLLMResponse(response2)!;
        await processPatch(config, parsed2, { cwd: testDir.path });

        // Content should be from the first change, not the second
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("first change");
    });
    
    it('should create nested directories for new files', async () => {
        const config = await createTestConfig(testDir.path);
        const newFilePath = 'src/a/b/c/new-file.ts';
        const newFileContent = 'hello world';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, newFileContent) +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, newFilePath), 'utf-8');
        expect(finalContent).toBe(newFileContent);
    });

    it('should rollback new file and its new empty parent directory on rejection', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const newFilePath = 'src/new/dir/file.ts';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, 'content') +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { prompter: async () => false, cwd: testDir.path });

        const fileExists = await fs.access(path.join(testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(fileExists).toBe(false);

        const dirExists = await fs.access(path.join(testDir.path, 'src/new/dir')).then(() => true).catch(() => false);
        expect(dirExists).toBe(false);

        const midDirExists = await fs.access(path.join(testDir.path, 'src/new')).then(() => true).catch(() => false);
        expect(midDirExists).toBe(false);
        
        // src directory should still exist as it contained a file before
        const srcDirExists = await fs.access(path.join(testDir.path, 'src')).then(() => true).catch(() => false);
        expect(srcDirExists).toBe(true);
    });

    it('should not delete parent directory on rollback if it was not empty beforehand', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const existingFilePath = 'src/shared/existing.ts';
        const newFilePath = 'src/shared/new.ts';
        const uuid = uuidv4();

        await createTestFile(testDir.path, existingFilePath, 'const existing = true;');

        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, 'const brandNew = true;') +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { prompter: async () => false, cwd: testDir.path });

        // New file should be gone
        const newFileExists = await fs.access(path.join(testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);

        // Existing file and its directory should remain
        const existingFileExists = await fs.access(path.join(testDir.path, existingFilePath)).then(() => true).catch(() => false);
        expect(existingFileExists).toBe(true);

        const sharedDirExists = await fs.access(path.join(testDir.path, 'src/shared')).then(() => true).catch(() => false);
        expect(sharedDirExists).toBe(true);
    });

    it('should abort transaction if preCommand fails', async () => {
        const config = await createTestConfig(testDir.path, { preCommand: 'bun -e "process.exit(1)"' });
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { cwd: testDir.path });

        // File should not have been changed
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been created
        const stateFileExists = await fs.access(path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should automatically roll back if postCommand fails', async () => {
        const config = await createTestConfig(testDir.path, { postCommand: 'bun -e "process.exit(1)"' });
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { cwd: testDir.path });

        // File should have been rolled back
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFileExists = await fs.access(path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should ignore patch with non-matching projectId', async () => {
        const config = await createTestConfig(testDir.path, { projectId: 'correct-project' });
        const uuid = uuidv4();
        
        const responseWithWrongProject = `
        \`\`\`typescript // {src/index.ts}
        // START
        console.log("should not be applied");
        // END
        \`\`\`
        \`\`\`yaml
        projectId: wrong-project
        uuid: ${uuid}
        changeSummary: []
        \`\`\`
        `;
        
        const parsedResponse = parseLLMResponse(responseWithWrongProject.trim());
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should correctly apply a file deletion operation', async () => {
        const config = await createTestConfig(testDir.path);
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(testDir.path, fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createDeleteFileBlock(fileToDelete) +
                         LLM_RESPONSE_END(uuid, [{ delete: fileToDelete }]);
        const parsedResponse = parseLLMResponse(response)!;
        
        await processPatch(config, parsedResponse, { cwd: testDir.path });

        const deletedFileExists = await fs.access(path.join(testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);
        
        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.snapshot[fileToDelete]).toBe(originalDeleteContent);
        expect(stateData.operations[0]).toEqual({ type: 'delete', path: fileToDelete });
    });

    it('should correctly roll back a file deletion operation', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(testDir.path, fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createDeleteFileBlock(fileToDelete) +
                         LLM_RESPONSE_END(uuid, [{ delete: fileToDelete }]);

        const parsedResponse = parseLLMResponse(response)!;
        
        await processPatch(config, parsedResponse, { prompter: async () => false, cwd: testDir.path });

        const restoredFileExists = await fs.access(path.join(testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredFileExists).toBe(true);
        const content = await fs.readFile(path.join(testDir.path, fileToDelete), 'utf-8');
        expect(content).toBe(originalDeleteContent);
        
        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should auto-approve if linter errors are within approvalOnErrorCount', async () => {
        const config = await createTestConfig(testDir.path, {
            approval: 'yes',
            approvalOnErrorCount: 1,
            linter: 'bun tsc'
        });
        const badContent = 'const x: string = 123;'; // 1 TS error
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                        createFileBlock(testFile, badContent) + 
                        LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!, { cwd: testDir.path });
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should ignore orphaned .pending.yml file and allow reprocessing', async () => {
        const config = await createTestConfig(testDir.path);
        const uuid = uuidv4();
        const newContent = 'console.log("final content");';

        const stateDir = path.join(testDir.path, STATE_DIRECTORY_NAME);
        await fs.mkdir(stateDir, { recursive: true });
        const orphanedPendingFile = path.join(stateDir, `${uuid}.pending.yml`);
        const orphanedState = { uuid, message: 'this is from a crashed run' };
        await fs.writeFile(orphanedPendingFile, yaml.dump(orphanedState));

        const response = LLM_RESPONSE_START + createFileBlock(testFile, newContent) + LLM_RESPONSE_END(uuid, []);
        const parsedResponse = parseLLMResponse(response)!;
        await processPatch(config, parsedResponse, { cwd: testDir.path });
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        const finalStateFile = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(finalStateFile).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
        
        const stateFileContent = await fs.readFile(finalStateFile, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.projectId).toBe(config.projectId);
        expect(stateData.approved).toBe(true);
    });

    it('should successfully run pre and post commands (happy path)', async () => {
        const preCommandFile = path.join(testDir.path, 'pre.txt');
        const postCommandFile = path.join(testDir.path, 'post.txt');
    
        const config = await createTestConfig(testDir.path, {
            preCommand: `bun -e "require('fs').writeFileSync('pre.txt', '')"`,
            postCommand: `bun -e "require('fs').writeFileSync('post.txt', '')"`,
        });
    
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);
        const parsed = parseLLMResponse(response)!;
    
        await processPatch(config, parsed, { cwd: testDir.path });
    
        const preExists = await fs.access(preCommandFile).then(() => true).catch(() => false);
        expect(preExists).toBe(true);
    
        const postExists = await fs.access(postCommandFile).then(() => true).catch(() => false);
        expect(postExists).toBe(true);
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("new content");
    });

    it('should create a pending file during transaction and remove it on rollback', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const newContent = 'I will be rolled back';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
    
        const parsedResponse = parseLLMResponse(response)!;
    
        const stateDir = path.join(testDir.path, STATE_DIRECTORY_NAME);
        const pendingPath = path.join(stateDir, `${uuid}.pending.yml`);
        const committedPath = path.join(stateDir, `${uuid}.yml`);
    
        let pendingFileExistedDuringRun = false;
    
        const prompter = async (): Promise<boolean> => {
            // At this point, the pending file should exist before we answer the prompt
            pendingFileExistedDuringRun = await fs.access(pendingPath).then(() => true).catch(() => false);
            return false; // Disapprove to trigger rollback
        };
    
        await processPatch(config, parsedResponse, { prompter, cwd: testDir.path });
    
        expect(pendingFileExistedDuringRun).toBe(true);
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    
        const pendingFileExistsAfter = await fs.access(pendingPath).then(() => true).catch(() => false);
        expect(pendingFileExistsAfter).toBe(false);
    
        const committedFileExists = await fs.access(committedPath).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(false);
    });

    it('should fail transaction gracefully if a file is not writable and rollback all changes', async () => {
        const config = await createTestConfig(testDir.path);
        const unwritableFile = 'src/unwritable.ts';
        const writableFile = 'src/writable.ts';
        const originalUnwritableContent = 'original unwritable';
        const originalWritableContent = 'original writable';
    
        await createTestFile(testDir.path, unwritableFile, originalUnwritableContent);
        await createTestFile(testDir.path, writableFile, originalWritableContent);
        
        const unwritableFilePath = path.join(testDir.path, unwritableFile);

        try {
            await fs.chmod(unwritableFilePath, 0o444); // Make read-only

            const uuid = uuidv4();
            const response = LLM_RESPONSE_START +
                createFileBlock(writableFile, "new writable content") +
                createFileBlock(unwritableFile, "new unwritable content") +
                LLM_RESPONSE_END(uuid, [{ edit: writableFile }, { edit: unwritableFile }]);
            
            const parsedResponse = parseLLMResponse(response)!;
            await processPatch(config, parsedResponse, { cwd: testDir.path });
        
            // Check file states: both should be rolled back to original content.
            const finalWritable = await fs.readFile(path.join(testDir.path, writableFile), 'utf-8');
            expect(finalWritable).toBe(originalWritableContent); 

            const finalUnwritable = await fs.readFile(unwritableFilePath, 'utf-8');
            expect(finalUnwritable).toBe(originalUnwritableContent);
        
            // Check that pending and final state files were cleaned up/not created.
            const pendingStatePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
            const pendingFileExists = await fs.access(pendingStatePath).then(() => true).catch(() => false);
            expect(pendingFileExists).toBe(false);

            const finalStatePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
            const finalStateExists = await fs.access(finalStatePath).then(() => true).catch(() => false);
            expect(finalStateExists).toBe(false);
        } finally {
            // Ensure file is writable again so afterEach hook can clean up
            await fs.chmod(unwritableFilePath, 0o666);
        }
    });

    it('should rollback gracefully if creating a file in a non-writable directory fails', async () => {
        const config = await createTestConfig(testDir.path);
        const readonlyDir = 'src/readonly-dir';
        const newFilePath = path.join(readonlyDir, 'new-file.ts');
        const readonlyDirPath = path.join(testDir.path, readonlyDir);
    
        await fs.mkdir(readonlyDirPath, { recursive: true });
        await fs.chmod(readonlyDirPath, 0o555); // Read and execute only
    
        try {
            const uuid = uuidv4();
            const response = LLM_RESPONSE_START +
                createFileBlock(newFilePath, 'this should not be written') +
                LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);
            
            const parsedResponse = parseLLMResponse(response)!;
            await processPatch(config, parsedResponse, { cwd: testDir.path });
    
            // Check that the new file was not created
            const newFileExists = await fs.access(path.join(testDir.path, newFilePath)).then(() => true).catch(() => false);
            expect(newFileExists).toBe(false);
    
            // Check that the transaction was rolled back (no final .yml file)
            const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
            const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
            
            // Check that pending state file was cleaned up
            const pendingStatePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
            const pendingFileExists = await fs.access(pendingStatePath).then(() => true).catch(() => false);
            expect(pendingFileExists).toBe(false);
    
        } finally {
            await fs.chmod(readonlyDirPath, 0o777); // Make writable again for cleanup
        }
    });
});
```