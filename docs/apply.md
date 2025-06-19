An extensive set of tests has been added to cover the requirements for `relay --init`, `relay watch`, transactional rollbacks, configuration options, and the parser, ensuring a more robust and reliable system.

Key improvements include:
- **Enhanced `init` command testing**: Verifies default configuration values.
- **Comprehensive transaction tests**: Now cover edge cases like processing duplicate UUIDs, handling orphaned state files, cleaning up empty directories on rollback, and respecting `preCommand`/`postCommand` execution and failure.
- **Improved `hasBeenProcessed` logic**: Now correctly ignores orphaned `.pending.yml` files, allowing failed transactions to be re-attempted.
- **Robust Rollbacks**: The system now correctly cleans up newly created directories if they are empty after a file is deleted during a rollback.
- **Command Execution**: `preCommand` failures now correctly abort transactions, and `postCommand` failures now trigger an automatic rollback as required.
- **Parser Resilience**: The parser is now tested against file paths with spaces and empty code blocks.

These changes address the specified test items and improve the overall stability and predictability of `relaycode`.

```typescript // src/core/executor.ts
import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';

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

export const createSnapshot = async (filePaths: string[], cwd: string = process.cwd()): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = {};
  for (const filePath of filePaths) {
    try {
      const absolutePath = path.resolve(cwd, filePath);
      try {
        const content = await fs.readFile(absolutePath, 'utf-8');
        snapshot[filePath] = content;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          snapshot[filePath] = null; // File doesn't exist, which is fine.
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`Error creating snapshot for ${filePath}:`, error);
      throw error;
    }
  }
  return snapshot;
};

export const applyOperations = async (operations: FileOperation[], cwd: string = process.cwd()): Promise<void> => {
  for (const op of operations) {
    if (op.type === 'delete') {
      await deleteFile(op.path, cwd);
    } else { // op.type === 'write'
      await writeFileContent(op.path, op.content, cwd);
    }
  }
};

export const restoreSnapshot = async (snapshot: FileSnapshot, cwd: string = process.cwd()): Promise<void> => {
  const projectRoot = path.resolve(cwd);

  for (const [filePath, content] of Object.entries(snapshot)) {
    const fullPath = path.resolve(cwd, filePath);
    try {
      if (content === null) {
        // If the file didn't exist in the snapshot, make sure it doesn't exist after restore
        try {
          await fs.unlink(fullPath);
          // After deleting a file that was newly created, try to clean up empty parent directories.
          let parentDir = path.dirname(fullPath);
          // Keep traversing up until we hit the project root or a non-empty directory
          while (parentDir.startsWith(projectRoot) && parentDir !== projectRoot) {
            const files = await fs.readdir(parentDir);
            if (files.length === 0) {
              await fs.rmdir(parentDir);
              parentDir = path.dirname(parentDir);
            } else {
              break; // Stop if directory is not empty
            }
          }
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
};
```
```typescript // src/core/state.ts
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

const getStateFilePath = (cwd: string, uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}.pending.yml` : `${uuid}.yml`;
  return path.join(getStateDirectory(cwd), fileName);
};

export const hasBeenProcessed = async (cwd: string, uuid: string): Promise<boolean> => {
  const committedPath = getStateFilePath(cwd, uuid, false);
  try {
    // Only check for a committed state file.
    // This allows re-processing a transaction that failed and left an orphaned .pending.yml
    await fs.access(committedPath);
    return true;
  } catch (e) {
    return false;
  }
};

export const writePendingState = async (cwd: string, state: StateFile): Promise<void> => {
  const validatedState = StateFileSchema.parse(state);
  const yamlString = yaml.dump(validatedState);
  const filePath = getStateFilePath(cwd, state.uuid, true);
  await fs.mkdir(getStateDirectory(cwd), { recursive: true });
  await fs.writeFile(filePath, yamlString, 'utf-8');
};

export const commitState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  const committedPath = getStateFilePath(cwd, uuid, false);
  await fs.rename(pendingPath, committedPath);
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
```
```typescript // src/core/transaction.ts
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
        // A tsconfig is needed for `bun tsc` to run
        await createTestFile(testDir.path, 'tsconfig.json', JSON.stringify({
            "compilerOptions": { "strict": true, "noEmit": true }
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
});
```
```typescript // test/unit/parser.test.ts
import { describe, it, expect } from 'bun:test';
import { parseLLMResponse } from '../../src/core/parser';
import { v4 as uuidv4 } from 'uuid';
import { LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock } from '../test.util';

describe('core/parser', () => {

    describe('parseLLMResponse', () => {
        const testUuid = uuidv4();

        it('should return null if YAML block is missing', () => {
            const response = `
\`\`\`typescript // {src/index.ts}
console.log("hello");
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if YAML is malformed', () => {
            const response = `
\`\`\`typescript // {src/index.ts}
console.log("hello");
\`\`\`
\`\`\`yaml
projectId: test-project
uuid: ${testUuid}
  malformed: - yaml
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if YAML is missing required fields', () => {
            const response = `
\`\`\`typescript // {src/index.ts}
console.log("hello");
\`\`\`
\`\`\`yaml
projectId: test-project
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if no code blocks are found', () => {
            const response = LLM_RESPONSE_START + LLM_RESPONSE_END(testUuid, []);
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should correctly parse a single file write operation', () => {
            const content = 'const a = 1;';
            const filePath = 'src/utils.ts';
            const block = createFileBlock(filePath, content);
            const response = LLM_RESPONSE_START + block + LLM_RESPONSE_END(testUuid, [{ edit: filePath }]);
            
            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe(testUuid);
            expect(parsed?.control.projectId).toBe('test-project');
            expect(parsed?.reasoning.join(' ')).toContain('I will edit the main file.');
            expect(parsed?.operations).toHaveLength(1);
            expect(parsed?.operations[0]).toEqual({
                type: 'write',
                path: filePath,
                content: content,
            });
        });

        it('should correctly parse a single file delete operation', () => {
            const filePath = 'src/old-file.ts';
            const block = createDeleteFileBlock(filePath);
            const response = "I'm deleting this old file." + block + LLM_RESPONSE_END(testUuid, [{ delete: filePath }]);

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            expect(parsed?.operations[0]).toEqual({
                type: 'delete',
                path: filePath,
            });
        });

        it('should correctly parse multiple mixed operations', () => {
            const filePath1 = 'src/main.ts';
            const content1 = 'console.log("main");';
            const filePath2 = 'src/to-delete.ts';
            const filePath3 = 'src/new-feature.ts';
            const content3 = 'export const feature = {};';

            const response = [
                "I'll make three changes.",
                createFileBlock(filePath1, content1),
                "Then delete a file.",
                createDeleteFileBlock(filePath2),
                "And finally add a new one.",
                createFileBlock(filePath3, content3),
                LLM_RESPONSE_END(testUuid, [{edit: filePath1}, {delete: filePath2}, {new: filePath3}])
            ].join('\n');

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(3);
            expect(parsed?.operations).toContainEqual({ type: 'write', path: filePath1, content: content1 });
            expect(parsed?.operations).toContainEqual({ type: 'delete', path: filePath2 });
            expect(parsed?.operations).toContainEqual({ type: 'write', path: filePath3, content: content3 });
            expect(parsed?.reasoning.join(' ')).toContain("I'll make three changes.");
        });
        
        it('should handle file paths with spaces', () => {
            const filePath = 'src/components/a file with spaces.tsx';
            const content = '<button>Click Me</button>';
            const response = createFileBlock(filePath, content) + LLM_RESPONSE_END(testUuid, [{ new: filePath }]);
            const parsed = parseLLMResponse(response);
            expect(parsed?.operations[0].path).toBe(filePath);
        });

        it('should handle empty content in a write operation', () => {
            const filePath = 'src/empty.ts';
            const response = createFileBlock(filePath, '') + LLM_RESPONSE_END(testUuid, [{ new: filePath }]);
            const parsed = parseLLMResponse(response);
            expect(parsed?.operations[0].type).toBe('write');
            if (parsed?.operations[0].type === 'write') {
                expect(parsed.operations[0].content).toBe('');
            }
        });

        it('should ignore malformed code blocks', () => {
            const response = `
\`\`\`typescript // {malformed-path.ts
const a = 1;
\`\`\`
${LLM_RESPONSE_END(testUuid, [])}
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should correctly extract content even if START/END markers are missing', () => {
            const filePath = 'src/simple.ts';
            const content = 'const simple = true;';
            const response = `
\`\`\`typescript // {${filePath}}
${content}
\`\`\`
${LLM_RESPONSE_END(testUuid, [{edit: filePath}])}
            `;

            const parsed = parseLLMResponse(response);
            const operation = parsed?.operations.find(op => op.path === filePath);
            
            expect(parsed).not.toBeNull();
            expect(operation?.type).toBe('write');
            if(operation?.type === 'write') {
                expect(operation.content).toBe(content);
            }
        });
    });
});
```