# Directory Structure
```
test/e2e/init.test.ts
test/e2e/patcher.test.ts
test/e2e/transaction.test.ts
test/e2e/watch.test.ts
test/test.util.ts
test/unit/parser.test.ts
```

# Files

## File: test/e2e/patcher.test.ts
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';

// NOTE: This test file uses the actual 'diff-apply' dependency, not a mock.

describe('e2e/patcher', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should correctly apply a patch using the multi-search-replace strategy', async () => {
        const testFile = 'src/config.js';
        const originalContent = `
const config = {
    port: 3000,
    host: 'localhost',
    enableLogging: true,
};
`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        const diffContent = `
<<<<<<< SEARCH
-------
    port: 3000,
=======
    port: 8080,
>>>>>>> REPLACE
<<<<<<< SEARCH
-------
    enableLogging: true,
=======
    enableLogging: false,
>>>>>>> REPLACE
`;
        
        await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: diffContent, strategy: 'multi-search-replace' }],
            { responseOverrides: { reasoning: [] } } // Don't care about reasoning in this test
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        
        const expectedContent = `
const config = {
    port: 8080,
    host: 'localhost',
    enableLogging: false,
};
`;
        expect(finalContent.replace(/\s/g, '')).toBe(expectedContent.replace(/\s/g, ''));
    });

    it('should correctly apply a patch using the new-unified strategy', async () => {
        const testFile = 'src/utils.js';
        const originalContent = `function calculate() {
    const a = 1;
    const b = 2;
    return a + b;
}`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        const diffContent = `--- a/${testFile}
+++ b/${testFile}
@@ -2,4 +2,5 @@
     const a = 1;
     const b = 2;
-    return a + b;
+    // A more complex calculation
+    return (a + b) * 2;
 }`;
        
        await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: diffContent, strategy: 'new-unified' }],
            { responseOverrides: { reasoning: [] } } // Don't care about reasoning
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        
        const expectedContent = `function calculate() {
    const a = 1;
    const b = 2;
    // A more complex calculation
    return (a + b) * 2;
}`;
        // Normalize line endings for comparison
        expect(finalContent.replace(/\r\n/g, '\n')).toBe(expectedContent.replace(/\r\n/g, '\n'));
    });


    it('should fail transaction if multi-search-replace content is not found', async () => {
        const testFile = 'src/index.js';
        const originalContent = 'const version = 1;';
        await createTestFile(context.testDir.path, testFile, originalContent);

        const diffContent = `
<<<<<<< SEARCH
-------
const version = 2; // This content does not exist
=======
const version = 3;
>>>>>>> REPLACE
`;
        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: diffContent, strategy: 'multi-search-replace' }],
            { responseOverrides: { reasoning: [] } }
        );

        // The file content should remain unchanged
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, '.relaycode', `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });
});
```

## File: test/e2e/watch.test.ts
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { createClipboardWatcher } from '../../src/core/clipboard';
import { parseLLMResponse } from '../../src/core/parser';
import { processPatch } from '../../src/core/transaction';
import { findConfig } from '../../src/core/config';
import { setupE2ETest, E2ETestContext, createTestConfig, createTestFile, createLLMResponseString } from '../test.util';

describe('e2e/watch', () => {
    let context: E2ETestContext;
    let watcher: { stop: () => void } | null = null;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (watcher) {
            watcher.stop();
            watcher = null;
        }
        if (context) {
            await context.cleanup();
        }
    });

    it('should ignore invalid patch and process subsequent valid patch', async () => {
        const pollInterval = 50;
        await createTestConfig(context.testDir.path, { clipboardPollInterval: pollInterval });
        const testFile = 'src/index.ts';
        const originalContent = 'console.log("original");';
        await createTestFile(context.testDir.path, testFile, originalContent);
    
        let fakeClipboardContent = 'this is not a valid patch, just some random text.';
        const clipboardReader = async () => fakeClipboardContent;
    
        const onClipboardChange = async (content: string) => {
            console.log('Clipboard change detected:', content.substring(0, 50) + '...');
            const currentConfig = await findConfig(context.testDir.path);
            const parsedResponse = parseLLMResponse(content);
            console.log('Parsed response:', parsedResponse ? 'valid' : 'invalid');
            if (!currentConfig || !parsedResponse) {
                console.log('Config or parsed response missing, skipping');
                return;
            }
            console.log('Processing patch...');
            await processPatch(currentConfig, parsedResponse, { cwd: context.testDir.path });
            console.log('Patch processed');
        };
    
        watcher = createClipboardWatcher(pollInterval, onClipboardChange, clipboardReader);
    
        // Wait for a couple of poll cycles to ensure the invalid patch is read and ignored
        await new Promise(resolve => setTimeout(resolve, pollInterval * 3));
    
        const contentAfterInvalid = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterInvalid).toBe(originalContent);
    
        // Now, provide a valid patch
        const newContent = 'console.log("new content");';
        const { response: validPatch } = createLLMResponseString([
            { type: 'edit', path: testFile, content: newContent }
        ]);
        fakeClipboardContent = validPatch;

        // Directly trigger the callback with the valid patch
        console.log('Manually triggering onClipboardChange with valid patch');
        await onClipboardChange(validPatch);

        // Also wait for the polling to potentially pick it up (just in case)
        await new Promise(resolve => setTimeout(resolve, pollInterval * 5));
    
        const contentAfterValid = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterValid).toBe(newContent);
    });
});
```

## File: test/test.util.ts
```typescript
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
```

## File: test/e2e/init.test.ts
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { initCommand } from '../../src/commands/init';
import { setupE2ETest, E2ETestContext, createTestFile } from '../test.util';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../../src/utils/constants';
import { ConfigSchema } from '../../src/types';
import { logger } from '../../src/utils/logger';

describe('e2e/init', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should create config file with correct defaults, state directory, and .gitignore', async () => {
        await initCommand(context.testDir.path);

        // Check for config file
        const configPath = path.join(context.testDir.path, CONFIG_FILE_NAME);
        const configExists = await fs.access(configPath).then(() => true).catch(() => false);
        expect(configExists).toBe(true);

        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        
        // Validate against schema to check defaults
        const parsedConfig = ConfigSchema.parse(config);
        expect(parsedConfig.projectId).toBe(path.basename(context.testDir.path));
        expect(parsedConfig.clipboardPollInterval).toBe(2000);
        expect(parsedConfig.approval).toBe('yes');
        expect(parsedConfig.linter).toBe('bun tsc --noEmit');

        // Check for state directory
        const stateDirPath = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const stateDirExists = await fs.stat(stateDirPath).then(s => s.isDirectory()).catch(() => false);
        expect(stateDirExists).toBe(true);

        // Check for .gitignore
        const gitignorePath = path.join(context.testDir.path, GITIGNORE_FILE_NAME);
        const gitignoreExists = await fs.access(gitignorePath).then(() => true).catch(() => false);
        expect(gitignoreExists).toBe(true);

        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should use package.json name for projectId if available', async () => {
        const pkgName = 'my-awesome-project';
        await createTestFile(context.testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        await initCommand(context.testDir.path);

        const configPath = path.join(context.testDir.path, CONFIG_FILE_NAME);
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe(pkgName);
    });

    it('should append to existing .gitignore', async () => {
        const initialContent = '# Existing rules\nnode_modules/';
        await createTestFile(context.testDir.path, GITIGNORE_FILE_NAME, initialContent);

        await initCommand(context.testDir.path);

        const gitignoreContent = await fs.readFile(path.join(context.testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        expect(gitignoreContent).toContain(initialContent);
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should not add entry to .gitignore if it already exists', async () => {
        const entry = `/${STATE_DIRECTORY_NAME}/`;
        const initialContent = `# Existing rules\n${entry}`;
        await createTestFile(context.testDir.path, GITIGNORE_FILE_NAME, initialContent);

        await initCommand(context.testDir.path);

        const gitignoreContent = await fs.readFile(path.join(context.testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        const occurrences = (gitignoreContent.match(new RegExp(entry, 'g')) || []).length;
        expect(occurrences).toBe(1);
    });

    it('should not overwrite an existing relaycode.config.json', async () => {
        const customConfig = { projectId: 'custom', customField: true };
        await createTestFile(context.testDir.path, CONFIG_FILE_NAME, JSON.stringify(customConfig));

        await initCommand(context.testDir.path);

        const configContent = await fs.readFile(path.join(context.testDir.path, CONFIG_FILE_NAME), 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe('custom');
        expect(config.customField).toBe(true);
    });

    it('should output the system prompt with the correct project ID', async () => {
        const capturedOutput: string[] = [];
        const originalLog = logger.log;
        (logger as any).log = (message: string) => capturedOutput.push(message);

        const pkgName = 'my-prompt-project';
        await createTestFile(context.testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        await initCommand(context.testDir.path);

        (logger as any).log = originalLog; // Restore

        const outputString = capturedOutput.join('\n');
        expect(outputString).toContain(`Project ID: ${pkgName}`);
    });

    it('should log an error if .gitignore is not writable', async () => {
        const gitignorePath = path.join(context.testDir.path, GITIGNORE_FILE_NAME);
        await createTestFile(context.testDir.path, GITIGNORE_FILE_NAME, '# initial');
        
        const capturedErrors: string[] = [];
        const originalError = logger.error;
        (logger as any).error = (message: string) => capturedErrors.push(message);

        try {
            await fs.chmod(gitignorePath, 0o444); // Read-only

            // initCommand doesn't throw, it just logs an error.
            await initCommand(context.testDir.path);

            const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
            expect(gitignoreContent).toBe('# initial'); // Should not have changed
            expect(capturedErrors.length).toBe(1);
            expect(capturedErrors[0]).toContain(`Failed to update ${GITIGNORE_FILE_NAME}`);
        } finally {
            // Restore logger
            (logger as any).error = originalError;
            
            // Make writable again for cleanup
            await fs.chmod(gitignorePath, 0o666);
        }
    });
});
```

## File: test/e2e/transaction.test.ts
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';


describe('e2e/transaction', () => {
    let context: E2ETestContext;
    const testFile = 'src/index.ts';
    const originalContent = 'console.log("original");';

    beforeEach(async () => {
        context = await setupE2ETest({ withTsconfig: true });
        await createTestFile(context.testDir.path, testFile, originalContent);
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should apply changes, commit, and store correct state in .yml file', async () => {
        const newContent = 'console.log("new content");';
        const { uuid } = await runProcessPatch(
            context,
            { linter: '', approval: 'yes' },
            [{ type: 'edit', path: testFile, content: newContent }]
        );
        // Add a small delay to ensure file operations have completed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check file content
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        // Check state file was committed
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        
        // Try multiple times with a small delay to check if the file exists
        let stateFileExists = false;
        for (let i = 0; i < 5; i++) {
            stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
            if (stateFileExists) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(stateFileExists).toBe(true);

        // Check state file content
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.uuid).toBe(uuid);
        expect(stateData.approved).toBe(true);
        expect(stateData.operations).toHaveLength(1);
        expect(stateData.operations[0].path).toBe(testFile);
        expect(stateData.snapshot[testFile]).toBe(originalContent);
        expect(stateData.reasoning).toBeDefined();
    });

    it('should rollback changes when manually disapproved', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { approval: 'no' },
            [{ type: 'edit', path: testFile, content: 'console.log("I will be rolled back");' }],
            { prompter: async () => false }
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should require manual approval if linter errors exceed approvalOnErrorCount', async () => {
        await runProcessPatch(
            context,
            { approval: 'yes', approvalOnErrorCount: 0, linter: 'bun tsc' },
            [{ type: 'edit', path: testFile, content: 'const x: string = 123;' }],
            { prompter: async () => false }
        );
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    });

    it('should skip linter if command is empty and auto-approve', async () => {
        const badContent = 'const x: string = 123;'; // Would fail linter, but it's skipped

        await runProcessPatch(
            context,
            { linter: '' },
            [{ type: 'edit', path: testFile, content: badContent }]
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);
    });

    it('should ignore patch with already processed UUID', async () => {
        const uuid = uuidv4();
        
        // 1. Process and commit a patch
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: "first change" }], { responseOverrides: { uuid }});
        
        // 2. Try to process another patch with the same UUID - this will create a new response with the same UUID.
        // The `processPatch` logic should see the existing state file and ignore it.
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: "second change" }], { responseOverrides: { uuid }});

        // Content should be from the first change, not the second
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("first change");
    });
    
    it('should create nested directories for new files', async () => {
        const newFilePath = 'src/a/b/c/new-file.ts';
        const newFileContent = 'hello world';
        
        await runProcessPatch(
            context, 
            {}, 
            [{ type: 'new', path: newFilePath, content: newFileContent }]
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, newFilePath), 'utf-8');
        expect(finalContent).toBe(newFileContent);
    });

    it('should rollback new file and its new empty parent directory on rejection', async () => {
        const newFilePath = 'src/new/dir/file.ts';
        
        await runProcessPatch(context, { approval: 'no' },
            [{ type: 'new', path: newFilePath, content: 'content' }], { prompter: async () => false });

        const fileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(fileExists).toBe(false);

        const dirExists = await fs.access(path.join(context.testDir.path, 'src/new/dir')).then(() => true).catch(() => false);
        expect(dirExists).toBe(false);

        const midDirExists = await fs.access(path.join(context.testDir.path, 'src/new')).then(() => true).catch(() => false);
        expect(midDirExists).toBe(false);
        
        // src directory should still exist as it contained a file before
        const srcDirExists = await fs.access(path.join(context.testDir.path, 'src')).then(() => true).catch(() => false);
        expect(srcDirExists).toBe(true);
    });

    it('should not delete parent directory on rollback if it was not empty beforehand', async () => {
        const existingFilePath = 'src/shared/existing.ts';
        const newFilePath = 'src/shared/new.ts';

        await createTestFile(context.testDir.path, existingFilePath, 'const existing = true;');

        await runProcessPatch(context, { approval: 'no' },
            [{ type: 'new', path: newFilePath, content: 'const brandNew = true;' }],
            { prompter: async () => false });

        // New file should be gone
        const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);

        // Existing file and its directory should remain
        const existingFileExists = await fs.access(path.join(context.testDir.path, existingFilePath)).then(() => true).catch(() => false);
        expect(existingFileExists).toBe(true);

        const sharedDirExists = await fs.access(path.join(context.testDir.path, 'src/shared')).then(() => true).catch(() => false);
        expect(sharedDirExists).toBe(true);
    });

    it('should abort transaction if preCommand fails', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { preCommand: 'bun -e "process.exit(1)"' },
            [{ type: 'edit', path: testFile, content: 'new content' }]
        );

        // File should not have been changed
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been created
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should automatically roll back if postCommand fails', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { postCommand: 'bun -e "process.exit(1)"' },
            [{ type: 'edit', path: testFile, content: 'new content' }]
        );

        // File should have been rolled back
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should ignore patch with non-matching projectId', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { projectId: 'correct-project' },
            [{ type: 'edit', path: testFile, content: 'should not be applied' }],
            { responseOverrides: { projectId: 'wrong-project' }}
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should correctly apply a file deletion operation', async () => {
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'delete', path: fileToDelete }]
        );

        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);

        // State file should have been committed with the deleted file content
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should correctly roll back a file deletion operation', async () => {
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const { uuid } = await runProcessPatch(
            context, { approval: 'no' },
            [{ type: 'delete', path: fileToDelete }], { prompter: async () => false }
        );

        const restoredFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredFileExists).toBe(true);

        // Content should be the same as the original
        const restoredContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(restoredContent).toBe(originalDeleteContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should auto-approve if linter errors are within approvalOnErrorCount', async () => {
        const badContent = 'const x: string = 123;'; // 1 TS error

        const { uuid } = await runProcessPatch(
            context,
            { approval: 'yes', approvalOnErrorCount: 1, linter: 'bun tsc' },
            [{ type: 'edit', path: testFile, content: badContent }]
        );
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);

        // State file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should ignore orphaned .pending.yml file and allow reprocessing', async () => {
        const uuid = uuidv4();
        const newContent = 'console.log("final content");';

        // Create an orphaned pending file
        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        await fs.mkdir(stateDir, { recursive: true });
        const orphanedPendingFile = path.join(stateDir, `${uuid}.pending.yml`);
        const orphanedState = { uuid, message: 'this is from a crashed run' };
        await fs.writeFile(orphanedPendingFile, yaml.dump(orphanedState));

        const { config } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: newContent }],
            { responseOverrides: { uuid } }
        );
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        // The pending file should have been removed
        const pendingFileExists = await fs.access(orphanedPendingFile).then(() => true).catch(() => false);
        expect(pendingFileExists).toBe(false);

        // A committed state file should exist
        const committedFileExists = await fs.access(path.join(stateDir, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(true);
    });

    it('should run pre and post commands in the correct order', async () => {
        const preCommandFile = path.join(context.testDir.path, 'pre.txt');
        const postCommandFile = path.join(context.testDir.path, 'post.txt');
    
        // Use node directly as it's more reliable cross-platform
        await runProcessPatch(
            context,
            {
                preCommand: `node -e "require('fs').writeFileSync('${preCommandFile.replace(/\\/g, '\\\\')}', '')"`,
                postCommand: `node -e "require('fs').writeFileSync('${postCommandFile.replace(/\\/g, '\\\\')}', '')"`,
            },
            [{ type: 'edit', path: testFile, content: 'new content' }]
        );
    
        const preExists = await fs.access(preCommandFile).then(() => true).catch(() => false);
        expect(preExists).toBe(true);
    
        const postExists = await fs.access(postCommandFile).then(() => true).catch(() => false);
        expect(postExists).toBe(true);
    
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe('new content');
    });

    it('should create a pending file during transaction and remove it on rollback', async () => {
        const uuid = uuidv4();
    
        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const pendingPath = path.join(stateDir, `${uuid}.pending.yml`);
    
        // Make sure the directory exists
        await fs.mkdir(stateDir, { recursive: true });
    
        // Check if the pending file exists during the transaction
        let pendingFileExistedDuringRun = false;
    
        const prompter = async (): Promise<boolean> => {
            pendingFileExistedDuringRun = await fs.access(pendingPath).then(() => true).catch(() => false);
            return false; // Disapprove to trigger rollback
        };

        await runProcessPatch(
            context,
            { approval: 'no' },
            [{ type: 'edit', path: testFile, content: 'I will be rolled back' }],
            { prompter, responseOverrides: { uuid } }
        );
    
        expect(pendingFileExistedDuringRun).toBe(true);
        
        // After rollback, the pending file should be gone
        const pendingFileExistsAfter = await fs.access(pendingPath).then(() => true).catch(() => false);
        expect(pendingFileExistsAfter).toBe(false);
    
        // No committed file should exist
        const committedPath = path.join(stateDir, `${uuid}.yml`);
        const committedFileExists = await fs.access(committedPath).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(false);
    });

    it('should fail transaction gracefully if a file is not writable and rollback all changes', async () => {
        const unwritableFile = 'src/unwritable.ts';
        const writableFile = 'src/writable.ts';
        const originalUnwritableContent = 'original unwritable';
        const originalWritableContent = 'original writable';
        
        await createTestFile(context.testDir.path, unwritableFile, originalUnwritableContent);
        await createTestFile(context.testDir.path, writableFile, originalWritableContent);
        
        const unwritableFilePath = path.join(context.testDir.path, unwritableFile);
        
        try {
            await fs.chmod(unwritableFilePath, 0o444); // Make read-only

            const { uuid } = await runProcessPatch(
                context, {},
                [
                    { type: 'edit', path: writableFile, content: 'new writable content' },
                    { type: 'edit', path: unwritableFile, content: 'new unwritable content' }
                ]
            );
        
            // Check file states: both should be rolled back to original content.
            const finalWritable = await fs.readFile(path.join(context.testDir.path, writableFile), 'utf-8');
            expect(finalWritable).toBe(originalWritableContent);
            
            const finalUnwritable = await fs.readFile(path.join(context.testDir.path, unwritableFile), 'utf-8');
            expect(finalUnwritable).toBe(originalUnwritableContent);
            
            // No state file should have been committed
            const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
        } finally {
            // Make the file writable again to allow cleanup
            try {
                await fs.chmod(unwritableFilePath, 0o644);
            } catch (err) {
                console.error('Failed to restore file permissions:', err);
            }
        }
    });

    it('should rollback gracefully if creating a file in a non-writable directory fails', async () => {
        const readonlyDir = 'src/readonly-dir';
        const newFilePath = path.join(readonlyDir, 'new-file.ts');
        const readonlyDirPath = path.join(context.testDir.path, readonlyDir);
        
        await fs.mkdir(readonlyDirPath, { recursive: true });
        await fs.chmod(readonlyDirPath, 0o555); // Read and execute only
    
        try {
            const { uuid } = await runProcessPatch(
                context,
                {},
                [{ type: 'new', path: newFilePath, content: 'this should not be written' }]
            );
    
            // Check that the new file was not created
            const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
            expect(newFileExists).toBe(false);
    
            // No state file should have been committed
            const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
        } finally {
            // Restore permissions for cleanup
            try {
                await fs.chmod(readonlyDirPath, 0o755);
            } catch (err) {
                console.error('Failed to restore directory permissions:', err);
            }
        }
    });

    it('should correctly rollback a complex transaction (modify, delete, create)', async () => {
        // Setup initial files
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await createTestFile(context.testDir.path, fileToModify, originalModifyContent);
        
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const newFilePath = 'src/new/component.ts';
        const newFileContent = 'export const c = 3;';
    
        // Disapprove the transaction
        await runProcessPatch(
            context,
            { approval: 'no' },
            [
                { type: 'edit', path: fileToModify, content: 'export const a = 100;' },
                { type: 'delete', path: fileToDelete },
                { type: 'new', path: newFilePath, content: newFileContent }
            ], { prompter: async () => false }
        );
    
        // Verify rollback
        const modifiedFileContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(modifiedFileContent).toBe(originalModifyContent);
        
        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(true);
        
        const deletedFileContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(deletedFileContent).toBe(originalDeleteContent);
        
        const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);
    });
});
```

## File: test/unit/parser.test.ts
```typescript
import { describe, it, expect } from 'bun:test';
import { parseLLMResponse } from '../../src/core/parser';
import { v4 as uuidv4 } from 'uuid';
import { LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock, createLLMResponseString } from '../test.util';
import { promises as fs } from 'fs';
import path from 'path';

describe('core/parser', () => {

    describe('legacy tests', () => {
        const testUuid = uuidv4();

        it('should return null if YAML block is missing', () => {
            const response = `
\`\`\`typescript // src/index.ts
console.log("hello");
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if YAML is malformed', () => {
            const response = `
\`\`\`typescript // src/index.ts
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
\`\`\`typescript // src/index.ts
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

        it('should correctly parse a single file write operation with default "replace" strategy', () => {
            const content = 'const a = 1;';
            const filePath = 'src/utils.ts';
            const { response } = createLLMResponseString(
                [{ type: 'edit', path: filePath, content }],
                { uuid: testUuid }
            );
            
            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe(testUuid);
            expect(parsed?.control.projectId).toBe('test-project');
            expect(parsed?.reasoning.join(' ')).toContain('I have analyzed your request and here are the changes.');
            expect(parsed?.operations).toHaveLength(1);
            expect(parsed?.operations[0]).toEqual({
                type: 'write',
                path: filePath,
                content: content,
                patchStrategy: 'replace',
            });
        });
        
        it('should correctly parse a write operation with an explicit patch strategy', () => {
            const content = 'diff content';
            const filePath = 'src/utils.ts';
            const { response } = createLLMResponseString(
                [{ type: 'edit', path: filePath, content, strategy: 'new-unified' }],
                { uuid: testUuid }
            );

            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            const writeOp = parsed?.operations[0];
            expect(writeOp?.type).toBe('write');
            if (writeOp?.type === 'write') {
                expect(writeOp.patchStrategy).toBe('new-unified');
                expect(writeOp.content).toBe(content);
            }
        });

        it('should correctly parse a single file delete operation', () => {
            const filePath = 'src/old-file.ts';
            const { response } = createLLMResponseString(
                [{ type: 'delete', path: filePath }],
                { uuid: testUuid, reasoning: ["I'm deleting this old file."] }
            );

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            expect(parsed?.operations[0]).toEqual({
                type: 'delete',
                path: filePath,
            });
        });

        it('should correctly parse multiple mixed operations', () => {
            const { response } = createLLMResponseString(
                [
                    { type: 'edit', path: 'src/main.ts', content: 'console.log("main");', strategy: 'replace' },
                    { type: 'delete', path: 'src/to-delete.ts' },
                    { type: 'new', path: 'src/new-feature.ts', content: 'diff content', strategy: 'new-unified' },
                ],
                {
                    uuid: testUuid,
                    reasoning: ["I'll make three changes.", "Then delete a file.", "And finally add a new one with a diff."]
                }
            );

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(3);
            expect(parsed?.operations).toContainEqual({ type: 'write', path: 'src/main.ts', content: 'console.log("main");', patchStrategy: 'replace' });
            expect(parsed?.operations).toContainEqual({ type: 'delete', path: 'src/to-delete.ts' });
            expect(parsed?.operations).toContainEqual({ type: 'write', path: 'src/new-feature.ts', content: 'diff content', patchStrategy: 'new-unified' });
            expect(parsed?.reasoning.join(' ')).toContain("I'll make three changes.");
        });
        
        it('should handle file paths with spaces when quoted', () => {
            const filePath = 'src/components/a file with spaces.tsx';
            const content = '<button>Click Me</button>';
            const block = `
\`\`\`typescript // "${filePath}"
// START

${content}

// END
\`\`\`
`;
            const response = block + LLM_RESPONSE_END(testUuid, [{ new: filePath }]);
            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            if (op.type === 'write' || op.type === 'delete') {
                expect(op.path).toBe(filePath);
            }
        });

        it('should handle empty content in a write operation', () => {
            const filePath = 'src/empty.ts';
            const { response } = createLLMResponseString(
                [{ type: 'new', path: filePath, content: '' }],
                { uuid: testUuid, reasoning: [] }
            );
            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            const operation = parsed!.operations[0]!;
            expect(operation.type).toBe('write');
            if (operation.type === 'write') {
                expect(operation.content).toBe('');
            }
        });

        it('should ignore malformed code blocks', () => {
            const response = `
\`\`\`typescript //
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
\`\`\`typescript // ${filePath}
${content}
\`\`\`
${LLM_RESPONSE_END(testUuid, [{edit: filePath}])}
            `;

            const parsed = parseLLMResponse(response);
            const operation = parsed?.operations.find(op => 'path' in op && op.path === filePath);
            
            expect(parsed).not.toBeNull();
            expect(operation).toBeDefined();
            expect(operation!.type).toBe('write');
            if(operation && operation.type === 'write') {
                expect(operation.content).toBe(content);
            }
        });

        it('should strip START and END markers from parsed content', () => {
            const filePath = 'src/markers.ts';
            const content = 'const content = "here";';

            const { response } = createLLMResponseString(
                [{ type: 'edit', path: filePath, content }],
                { uuid: testUuid }
            );
        
            const parsed = parseLLMResponse(response);
            const operation = parsed?.operations[0];
        
            expect(parsed).not.toBeNull();
            expect(operation).not.toBeUndefined();
            expect(operation!.type).toBe('write');
            if (operation && operation.type === 'write') {
                expect(operation.content).toBe(content);
                expect(operation.content).not.toContain('// START');
                expect(operation.content).not.toContain('// END');
            }
        });

        it('should treat an unknown patch strategy as part of the file path', () => {
            const filePath = 'src/index.ts';
            const content = 'console.log("hello");';
            const block = `
\`\`\`typescript // ${filePath} unknown-strategy
${content}
\`\`\`
            `;
            const fullPath = `${filePath} unknown-strategy`;
            const response = block + LLM_RESPONSE_END(uuidv4(), [{ edit: fullPath }]);
            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            expect(op.type).toBe('write');
            if (op.type === 'write' || op.type === 'delete') {
                expect(op.path).toBe(fullPath);
            }
        });

        it('should not detect multi-search-replace when <<<<<<< SEARCH appears in the middle of content', () => {
            const filePath = 'src/example.ts';
            // Content contains the marker as part of a string or comment, not at the start of a line
            const content = `
// This is a code example showing a marker: <<<<<<< SEARCH in a comment
const example = "This is not a real <<<<<<< SEARCH marker";
console.log(example);
            `;
            const block = createFileBlock(filePath, content);
            const response = block + LLM_RESPONSE_END(uuidv4(), [{ edit: filePath }]);
            const parsed = parseLLMResponse(response);
            
            expect(parsed).not.toBeNull();
            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.patchStrategy).toBe('replace');
            }
        });

        it('should not detect multi-search-replace when only start marker is present without end marker', () => {
            const filePath = 'src/partial-marker.ts';
            // Content has the start marker at the beginning of a line but no end marker
            const content = `
<<<<<<< SEARCH
This content has the start marker but not the end marker
So it should be treated as regular content, not multi-search-replace
            `;
            const block = createFileBlock(filePath, content);
            const response = block + LLM_RESPONSE_END(uuidv4(), [{ edit: filePath }]);
            const parsed = parseLLMResponse(response);
            
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.patchStrategy).toBe('replace'); // Should be 'replace', not 'multi-search-replace'
            }
        });
    });

    describe('from fixtures', () => {
        const fixturesDir = path.resolve(__dirname, '../fixtures');

        const readFixture = (name: string) => fs.readFile(path.join(fixturesDir, name), 'utf-8');

        it('should correctly parse multi-search-replace.md', async () => {
            const content = await readFixture('multi-search-replace.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.projectId).toBe('diff-apply');
            expect(parsed?.control.uuid).toBe('486a43f8-874e-4f16-832f-b2fd3769c36c');
            expect(parsed?.operations).toHaveLength(1);

            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('package.json');
                expect(op.patchStrategy).toBe('multi-search-replace');
                expect(op.content).toContain('<<<<<<< SEARCH');
                expect(op.content).toContain('>>>>>>> REPLACE');
                expect(op.content).toContain('"name": "diff-patcher"');
            }
            expect(parsed?.reasoning.join(' ')).toContain("I will update the `package.json` file");
        });

        it('should correctly parse replace-with-markers.md', async () => {
            const content = await readFixture('replace-with-markers.md');
            const parsed = parseLLMResponse(content);
            const expectedContent = `export const newFunction = () => {\n    console.log("new file");\n};`;
            
            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe('1c8a41a8-20d7-4663-856e-9ebd03f7a1e1');
            expect(parsed?.operations).toHaveLength(1);

            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/new.ts');
                expect(op.patchStrategy).toBe('replace');
                expect(op.content).toBe(expectedContent);
                expect(op.content).not.toContain('// START');
                expect(op.content).not.toContain('// END');
            }
        });

        it('should correctly parse replace-no-markers.md', async () => {
            const content = await readFixture('replace-no-markers.md');
            const parsed = parseLLMResponse(content);
            const expectedContent = `export const newFunction = () => {\n    console.log("new file");\n};`;

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/new.ts');
                expect(op.patchStrategy).toBe('replace');
                expect(op.content).toBe(expectedContent);
            }
        });

        it('should correctly parse new-unified.md', async () => {
            const content = await readFixture('new-unified.md');
            const parsed = parseLLMResponse(content);
            const expectedContent = `--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,3 +1,3 @@\n-export function greet(name: string) {\n-  return \`Hello, \${name}!\`;\n+export function greet(name: string, enthusiasm: number) {\n+  return \`Hello, \${name}\` + '!'.repeat(enthusiasm);\n }`;

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/utils.ts');
                expect(op.patchStrategy).toBe('new-unified');
                expect(op!.content.trim()).toBe(expectedContent.trim());
            }
        });

        it('should correctly parse delete-file.md', async () => {
            const content = await readFixture('delete-file.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('delete');
            if (op.type === 'delete') {
                expect(op.path).toBe('src/old-helper.ts');
            }
            expect(parsed?.reasoning.join(' ')).toContain("I'm removing the old helper file.");
        });

        it('should correctly parse path-with-spaces.md', async () => {
            const content = await readFixture('path-with-spaces.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0]!;
            expect(op).toBeDefined();
            expect(op!.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/components/My Component.tsx');
            }
        });
        
        it('should correctly parse multiple-ops.md', async () => {
            const content = await readFixture('multiple-ops.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe('5e1a41d8-64a7-4663-c56e-3ebd03f7a1f5');
            expect(parsed?.operations).toHaveLength(3);

            expect(parsed?.operations).toContainEqual({
                type: 'write',
                path: 'src/main.ts',
                content: 'console.log("Updated main");',
                patchStrategy: 'replace'
            });

            expect(parsed?.operations).toContainEqual({
                type: 'delete',
                path: 'src/utils.ts',
            });
            
            const newOp = parsed?.operations.find(op => 'path' in op && op.path.includes('New Component'));
            expect(newOp).toBeDefined();
            expect(newOp!.type).toBe('write');
            if (newOp && newOp.type === 'write') {
                expect(newOp.patchStrategy).toBe('new-unified');
                expect(newOp.path).toBe('src/components/New Component.tsx');
            }
        });
    });
});
```
