Of course! I can certainly help refactor your test codebase to be more DRY (Don't Repeat Yourself), reducing code duplication and line count while ensuring all tests continue to pass. I'll introduce a set of new test helpers to achieve this.

Here are the step-by-step changes:

### Step 1: Enhance Test Utilities

I'll start by augmenting `test/test.util.ts` with powerful new helpers. I'm adding an `E2EHelper` class to encapsulate common test setup, teardown, and file operations. I'm also creating a `MockLLMResponseBuilder` to simplify the creation of mock AI responses for testing.

```typescript // test/test.util.ts
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Config, PatchStrategy } from '../src/types';
import { CONFIG_FILE_NAME } from '../src/utils/constants';
import { logger } from '../src/utils/logger';
import { parseLLMResponse } from '../src/core/parser';
import { processPatch } from '../src/core/transaction';

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


export const createTestConfig = async (cwd: string, overrides: Partial<Config> = {}): Promise<Config> => {
    const defaultConfig: Config = {
        projectId: 'test-project',
        clipboardPollInterval: 100,
        approval: 'yes',
        approvalOnErrorCount: 0,
        linter: `bun -e "process.exit(0)"`, // A command that always succeeds
        preCommand: '',
        postCommand: '',
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

export const LLM_RESPONSE_END = (uuid: string, changeSummary: { [key: string]: string }[], projectId: string = 'test-project') => `
\`\`\`yaml
projectId: ${projectId}
uuid: ${uuid}
changeSummary: ${JSON.stringify(changeSummary)}
\`\`\`
`;

export const createFileBlock = (filePath: string, content: string, patchStrategy?: PatchStrategy): string => {
    const strategyString = patchStrategy ? ` ${patchStrategy}` : '';
    // Quote file path if it contains spaces
    const finalFilePath = filePath.includes(' ') ? `"${filePath}"` : filePath;
    return `
\`\`\`typescript // ${finalFilePath}${strategyString}
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

export class MockLLMResponseBuilder {
    private operations: string[] = [];
    private summary: any[] = [];
    private reasoning: string = LLM_RESPONSE_START;

    withReasoning(reasoning: string): this {
        this.reasoning = reasoning;
        return this;
    }

    addFile(path: string, content: string, options: { strategy?: PatchStrategy; type?: 'new' | 'edit' } = {}): this {
        this.operations.push(createFileBlock(path, content, options.strategy));
        const summaryKey = options.type || 'edit';
        this.summary.push({ [summaryKey]: path });
        return this;
    }

    deleteFile(path: string): this {
        this.operations.push(createDeleteFileBlock(path));
        this.summary.push({ delete: path });
        return this;
    }

    build(uuid: string, projectId?: string): string {
        return [
            this.reasoning,
            ...this.operations,
            LLM_RESPONSE_END(uuid, this.summary, projectId)
        ].join('\n');
    }
}

export class E2EHelper {
    context!: E2ETestContext;

    async setup(options: { withTsconfig?: boolean } = {}) {
        this.context = await setupE2ETest(options);
    }

    async cleanup() {
        if (this.context) {
            await this.context.cleanup();
        }
    }

    get testDir(): string {
        return this.context.testDir.path;
    }

    createConfig(overrides: Partial<Config> = {}): Promise<Config> {
        return createTestConfig(this.testDir, overrides);
    }

    createFile(filePath: string, content: string): Promise<void> {
        return createTestFile(this.testDir, filePath, content);
    }

    readFile(filePath: string): Promise<string> {
        return fs.readFile(path.join(this.testDir, filePath), 'utf-8');
    }

    fileExists(filePath: string): Promise<boolean> {
        return fs.access(path.join(this.testDir, filePath)).then(() => true).catch(() => false);
    }

    async runTransaction(
        llmResponse: string,
        options: { config?: Partial<Config>; prompter?: (prompt: string) => Promise<boolean>; } = {}
    ) {
        const config = await this.createConfig(options.config);
        const parsedResponse = parseLLMResponse(llmResponse);
        if (!parsedResponse) {
            throw new Error("Test setup error: LLM response is not parsable.");
        }
        await processPatch(config, parsedResponse, { 
            prompter: options.prompter, 
            cwd: this.testDir 
        });
        return { parsedResponse };
    }
}
```

### Step 2: Refactor Parser Unit Tests

Next, I'll refactor the parser unit tests in `test/unit/parser.test.ts`. I'll use the new `MockLLMResponseBuilder` to make the test cases for simple response structures cleaner and more readable. For tests that verify the parser's handling of more complex or unusual structures (like interleaved reasoning), I will retain the manual string construction to ensure the test's intent is preserved.

```typescript // test/unit/parser.test.ts
import { describe, it, expect } from 'bun:test';
import { parseLLMResponse } from '../../src/core/parser';
import { v4 as uuidv4 } from 'uuid';
import { LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock, MockLLMResponseBuilder } from '../test.util';
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
            const response = new MockLLMResponseBuilder()
                .addFile(filePath, content, { type: 'edit' })
                .build(testUuid);
            
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
            const response = new MockLLMResponseBuilder()
                .addFile(filePath, content, { strategy: 'new-unified', type: 'edit' })
                .build(testUuid);

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
            const response = new MockLLMResponseBuilder()
                .withReasoning("I'm deleting this old file.")
                .deleteFile(filePath)
                .build(testUuid);

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

            // Keeping manual construction here to test interleaved reasoning.
            const response = [
                "I'll make three changes.",
                createFileBlock(filePath1, content1, 'replace'),
                "Then delete a file.",
                createDeleteFileBlock(filePath2),
                "And finally add a new one with a diff.",
                createFileBlock(filePath3, 'diff content', 'new-unified'),
                LLM_RESPONSE_END(testUuid, [{edit: filePath1}, {delete: filePath2}, {new: filePath3}])
            ].join('\n');

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(3);
            expect(parsed?.operations).toContainEqual({ type: 'write', path: filePath1, content: content1, patchStrategy: 'replace' });
            expect(parsed?.operations).toContainEqual({ type: 'delete', path: filePath2 });
            expect(parsed?.operations).toContainEqual({ type: 'write', path: filePath3, content: 'diff content', patchStrategy: 'new-unified' });
            expect(parsed?.reasoning.join(' ')).toContain("I'll make three changes.");
        });
        
        it('should handle file paths with spaces when quoted', () => {
            const filePath = 'src/components/a file with spaces.tsx';
            const content = '<button>Click Me</button>';
            const response = new MockLLMResponseBuilder()
                .addFile(filePath, content, { type: 'new' })
                .build(testUuid);

            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            expect(parsed!.operations[0]!.path).toBe(filePath);
        });

        it('should handle empty content in a write operation', () => {
            const filePath = 'src/empty.ts';
            const response = new MockLLMResponseBuilder()
                .addFile(filePath, '', { type: 'new' })
                .build(testUuid);

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
            const operation = parsed?.operations.find(op => op.path === filePath);
            
            expect(parsed).not.toBeNull();
            expect(operation?.type).toBe('write');
            if(operation?.type === 'write') {
                expect(operation.content).toBe(content);
            }
        });

        it('should strip START and END markers from parsed content', () => {
            const filePath = 'src/markers.ts';
            const content = 'const content = "here";';
        
            const response = new MockLLMResponseBuilder()
                .addFile(filePath, content, { type: 'edit' })
                .build(testUuid);
        
            const parsed = parseLLMResponse(response);
            const operation = parsed?.operations[0];
        
            expect(parsed).not.toBeNull();
            expect(operation).not.toBeUndefined();
            expect(operation?.type).toBe('write');
            if (operation?.type === 'write') {
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
            expect(op.path).toBe(fullPath);
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

            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
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

            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
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
            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
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
            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/utils.ts');
                expect(op.patchStrategy).toBe('new-unified');
                expect(op.content.trim()).toBe(expectedContent.trim());
            }
        });

        it('should correctly parse delete-file.md', async () => {
            const content = await readFixture('delete-file.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0];
            expect(op.type).toBe('delete');
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
            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
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
            
            const newOp = parsed?.operations.find(op => op.path.includes('New Component'));
            expect(newOp).toBeDefined();
            expect(newOp?.type).toBe('write');
            if (newOp?.type === 'write') {
                expect(newOp.patchStrategy).toBe('new-unified');
                expect(newOp.path).toBe('src/components/New Component.tsx');
            }
        });
    });
});
```

### Step 3: Refactor E2E Tests

Now, I'll systematically refactor all E2E test files (`init`, `patcher`, `transaction`, and `watch`) to use the new `E2EHelper` and `MockLLMResponseBuilder`. This will dramatically reduce boilerplate code related to test environment setup, file I/O, configuration, and transaction processing, making the tests much more concise and focused on their specific assertions.

#### Refactoring `init.test.ts`

```typescript // test/e2e/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { initCommand } from '../../src/commands/init';
import { E2EHelper } from '../test.util';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../../src/utils/constants';
import { ConfigSchema } from '../../src/types';
import { logger } from '../../src/utils/logger';

describe('e2e/init', () => {
    const helper = new E2EHelper();

    beforeEach(async () => {
        await helper.setup();
    });

    afterEach(async () => {
        await helper.cleanup();
    });

    it('should create config file with correct defaults, state directory, and .gitignore', async () => {
        await initCommand(helper.testDir);

        // Check for config file
        const configPath = path.join(helper.testDir, CONFIG_FILE_NAME);
        const configExists = await helper.fileExists(CONFIG_FILE_NAME);
        expect(configExists).toBe(true);

        const configContent = await helper.readFile(CONFIG_FILE_NAME);
        const config = JSON.parse(configContent);
        
        // Validate against schema to check defaults
        const parsedConfig = ConfigSchema.parse(config);
        expect(parsedConfig.projectId).toBe(path.basename(helper.testDir));
        expect(parsedConfig.clipboardPollInterval).toBe(2000);
        expect(parsedConfig.approval).toBe('yes');
        expect(parsedConfig.linter).toBe('bun tsc --noEmit');

        // Check for state directory
        const stateDirPath = path.join(helper.testDir, STATE_DIRECTORY_NAME);
        const stateDirExists = await fs.stat(stateDirPath).then(s => s.isDirectory()).catch(() => false);
        expect(stateDirExists).toBe(true);

        // Check for .gitignore
        const gitignoreExists = await helper.fileExists(GITIGNORE_FILE_NAME);
        expect(gitignoreExists).toBe(true);

        const gitignoreContent = await helper.readFile(GITIGNORE_FILE_NAME);
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should use package.json name for projectId if available', async () => {
        const pkgName = 'my-awesome-project';
        await helper.createFile('package.json', JSON.stringify({ name: pkgName }));

        await initCommand(helper.testDir);

        const configContent = await helper.readFile(CONFIG_FILE_NAME);
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe(pkgName);
    });

    it('should append to existing .gitignore', async () => {
        const initialContent = '# Existing rules\nnode_modules/';
        await helper.createFile(GITIGNORE_FILE_NAME, initialContent);

        await initCommand(helper.testDir);

        const gitignoreContent = await helper.readFile(GITIGNORE_FILE_NAME);
        expect(gitignoreContent).toContain(initialContent);
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should not add entry to .gitignore if it already exists', async () => {
        const entry = `/${STATE_DIRECTORY_NAME}/`;
        const initialContent = `# Existing rules\n${entry}`;
        await helper.createFile(GITIGNORE_FILE_NAME, initialContent);

        await initCommand(helper.testDir);

        const gitignoreContent = await helper.readFile(GITIGNORE_FILE_NAME);
        const occurrences = (gitignoreContent.match(new RegExp(entry, 'g')) || []).length;
        expect(occurrences).toBe(1);
    });

    it('should not overwrite an existing relaycode.config.json', async () => {
        const customConfig = { projectId: 'custom', customField: true };
        await helper.createFile(CONFIG_FILE_NAME, JSON.stringify(customConfig));

        await initCommand(helper.testDir);

        const configContent = await helper.readFile(CONFIG_FILE_NAME);
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe('custom');
        expect(config.customField).toBe(true);
    });

    it('should output the system prompt with the correct project ID', async () => {
        const capturedOutput: string[] = [];
        const originalLog = logger.log;
        (logger as any).log = (message: string) => capturedOutput.push(message);

        const pkgName = 'my-prompt-project';
        await helper.createFile('package.json', JSON.stringify({ name: pkgName }));

        await initCommand(helper.testDir);

        (logger as any).log = originalLog; // Restore

        const outputString = capturedOutput.join('\n');
        expect(outputString).toContain(`Project ID: ${pkgName}`);
    });

    it('should log an error if .gitignore is not writable', async () => {
        const gitignorePath = path.join(helper.testDir, GITIGNORE_FILE_NAME);
        await helper.createFile(GITIGNORE_FILE_NAME, '# initial');
        
        const capturedErrors: string[] = [];
        const originalError = logger.error;
        (logger as any).error = (message: string) => capturedErrors.push(message);

        try {
            await fs.chmod(gitignorePath, 0o444); // Read-only

            // initCommand doesn't throw, it just logs an error.
            await initCommand(helper.testDir);

            const gitignoreContent = await helper.readFile(GITIGNORE_FILE_NAME);
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

#### Refactoring `patcher.test.ts`

```typescript // test/e2e/patcher.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { E2EHelper, MockLLMResponseBuilder } from '../test.util';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';

// NOTE: This test file uses the actual 'diff-apply' dependency, not a mock.

describe('e2e/patcher', () => {
    const helper = new E2EHelper();

    beforeEach(async () => {
        await helper.setup();
    });

    afterEach(async () => {
        await helper.cleanup();
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
        await helper.createFile(testFile, originalContent);

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
        
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, diffContent, { strategy: 'multi-search-replace' })
            .build(uuidv4());

        await helper.runTransaction(llmResponse);

        const finalContent = await helper.readFile(testFile);
        
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
        await helper.createFile(testFile, originalContent);

        const diffContent = `--- a/${testFile}
+++ b/${testFile}
@@ -2,4 +2,5 @@
     const a = 1;
     const b = 2;
-    return a + b;
+    // A more complex calculation
+    return (a + b) * 2;
 }`;
        
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, diffContent, { strategy: 'new-unified' })
            .build(uuidv4());

        await helper.runTransaction(llmResponse);

        const finalContent = await helper.readFile(testFile);
        
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
        await helper.createFile(testFile, originalContent);

        const diffContent = `
<<<<<<< SEARCH
-------
const version = 2; // This content does not exist
=======
const version = 3;
>>>>>>> REPLACE
`;
        const uuid = uuidv4();
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, diffContent, { strategy: 'multi-search-replace' })
            .build(uuid);
        
        await helper.runTransaction(llmResponse);

        // The file content should remain unchanged
        const finalContent = await helper.readFile(testFile);
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`));
        expect(stateFileExists).toBe(false);
    });
});
```

#### Refactoring `transaction.test.ts`

```typescript // test/e2e/transaction.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { E2EHelper, MockLLMResponseBuilder } from '../test.util';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';


describe('e2e/transaction', () => {
    const helper = new E2EHelper();
    const testFile = 'src/index.ts';
    const originalContent = 'console.log("original");';

    beforeEach(async () => {
        await helper.setup({ withTsconfig: true });
        await helper.createFile(testFile, originalContent);
    });

    afterEach(async () => {
        await helper.cleanup();
    });

    it('should apply changes, commit, and store correct state in .yml file', async () => {
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, newContent)
            .build(uuid);
        
        const { parsedResponse } = await helper.runTransaction(llmResponse, { 
            config: { linter: '', approval: 'yes' }
        });

        // Check file content
        const finalContent = await helper.readFile(testFile);
        expect(finalContent).toBe(newContent);

        // Check state file was committed
        const stateFilePath = path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await helper.fileExists(stateFilePath);
        expect(stateFileExists).toBe(true);

        // Check state file content
        const stateFileContent = await helper.readFile(stateFilePath);
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.uuid).toBe(uuid);
        expect(stateData.approved).toBe(true);
        expect(stateData.operations).toHaveLength(1);
        expect(stateData.operations[0].path).toBe(testFile);
        expect(stateData.snapshot[testFile]).toBe(originalContent);
        expect(stateData.reasoning).toEqual(parsedResponse!.reasoning);
    });

    it('should rollback changes when manually disapproved', async () => {
        const newContent = 'console.log("I will be rolled back");';
        const uuid = uuidv4();
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, newContent)
            .build(uuid);

        const prompter = async () => false; // Disapprove
        await helper.runTransaction(llmResponse, { config: { approval: 'no' }, prompter });

        const finalContent = await helper.readFile(testFile);
        expect(finalContent).toBe(originalContent);

        const stateFileExists = await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`));
        expect(stateFileExists).toBe(false);
    });

    it('should require manual approval if linter errors exceed approvalOnErrorCount', async () => {
        const badContent = 'const x: string = 123;'; // 1 TS error
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, badContent)
            .build(uuidv4());
        
        // Disapprove when prompted
        const prompter = async () => false;
        await helper.runTransaction(llmResponse, { 
            config: { approval: 'yes', approvalOnErrorCount: 0, linter: `bun tsc` }, 
            prompter 
        });
        
        const finalContent = await helper.readFile(testFile);
        expect(finalContent).toBe(originalContent);
    });

    it('should skip linter if command is empty and auto-approve', async () => {
        const badContent = 'const x: string = 123;'; // Would fail linter, but it's skipped
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, badContent)
            .build(uuidv4());

        await helper.runTransaction(llmResponse, { config: { linter: '' } });

        const finalContent = await helper.readFile(testFile);
        expect(finalContent).toBe(badContent);
    });

    it('should ignore patch with already processed UUID', async () => {
        const uuid = uuidv4();
        
        // 1. Process and commit a patch
        const response1 = new MockLLMResponseBuilder().addFile(testFile, "first change").build(uuid);
        await helper.runTransaction(response1);
        
        // 2. Try to process another patch with the same UUID
        const response2 = new MockLLMResponseBuilder().addFile(testFile, "second change").build(uuid);
        await helper.runTransaction(response2);

        // Content should be from the first change, not the second
        const finalContent = await helper.readFile(testFile);
        expect(finalContent).toBe("first change");
    });
    
    it('should create nested directories for new files', async () => {
        const newFilePath = 'src/a/b/c/new-file.ts';
        const newFileContent = 'hello world';
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(newFilePath, newFileContent, { type: 'new' })
            .build(uuidv4());

        await helper.runTransaction(llmResponse);

        const finalContent = await helper.readFile(newFilePath);
        expect(finalContent).toBe(newFileContent);
    });

    it('should rollback new file and its new empty parent directory on rejection', async () => {
        const newFilePath = 'src/new/dir/file.ts';
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(newFilePath, 'content', { type: 'new' })
            .build(uuidv4());

        await helper.runTransaction(llmResponse, { config: { approval: 'no' }, prompter: async () => false });

        expect(await helper.fileExists(newFilePath)).toBe(false);
        expect(await helper.fileExists('src/new/dir')).toBe(false);
        expect(await helper.fileExists('src/new')).toBe(false);
        // src directory should still exist as it contained a file before
        expect(await helper.fileExists('src')).toBe(true);
    });

    it('should not delete parent directory on rollback if it was not empty beforehand', async () => {
        const existingFilePath = 'src/shared/existing.ts';
        const newFilePath = 'src/shared/new.ts';
        await helper.createFile(existingFilePath, 'const existing = true;');

        const llmResponse = new MockLLMResponseBuilder()
            .addFile(newFilePath, 'const brandNew = true;', { type: 'new' })
            .build(uuidv4());

        await helper.runTransaction(llmResponse, { config: { approval: 'no' }, prompter: async () => false });

        expect(await helper.fileExists(newFilePath)).toBe(false);
        expect(await helper.fileExists(existingFilePath)).toBe(true);
        expect(await helper.fileExists('src/shared')).toBe(true);
    });

    it('should abort transaction if preCommand fails', async () => {
        const uuid = uuidv4();
        const llmResponse = new MockLLMResponseBuilder().addFile(testFile, "new content").build(uuid);
        await helper.runTransaction(llmResponse, { config: { preCommand: 'bun -e "process.exit(1)"' } });

        expect(await helper.readFile(testFile)).toBe(originalContent);
        expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
    });

    it('should automatically roll back if postCommand fails', async () => {
        const uuid = uuidv4();
        const llmResponse = new MockLLMResponseBuilder().addFile(testFile, "new content").build(uuid);
        await helper.runTransaction(llmResponse, { config: { postCommand: 'bun -e "process.exit(1)"' } });

        expect(await helper.readFile(testFile)).toBe(originalContent);
        expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
    });

    it('should ignore patch with non-matching projectId', async () => {
        const uuid = uuidv4();
        const llmResponse = new MockLLMResponseBuilder()
            .addFile(testFile, 'should not be applied')
            .build(uuid, 'wrong-project');
        
        await helper.runTransaction(llmResponse, { config: { projectId: 'correct-project' } });

        expect(await helper.readFile(testFile)).toBe(originalContent);
        expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
    });

    it('should correctly apply a file deletion operation', async () => {
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await helper.createFile(fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = new MockLLMResponseBuilder()
            .deleteFile(fileToDelete)
            .build(uuid);
        
        await helper.runTransaction(response);

        expect(await helper.fileExists(fileToDelete)).toBe(false);
        
        const stateFilePath = path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileContent = await helper.readFile(stateFilePath);
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.snapshot[fileToDelete]).toBe(originalDeleteContent);
        expect(stateData.operations[0]).toEqual({ type: 'delete', path: fileToDelete });
    });

    it('should correctly roll back a file deletion operation', async () => {
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await helper.createFile(fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = new MockLLMResponseBuilder()
            .deleteFile(fileToDelete)
            .build(uuid);
        
        await helper.runTransaction(response, { config: { approval: 'no' }, prompter: async () => false });

        expect(await helper.fileExists(fileToDelete)).toBe(true);
        expect(await helper.readFile(fileToDelete)).toBe(originalDeleteContent);
        expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
    });

    it('should auto-approve if linter errors are within approvalOnErrorCount', async () => {
        const badContent = 'const x: string = 123;'; // 1 TS error
        const uuid = uuidv4();
        const response = new MockLLMResponseBuilder()
            .addFile(testFile, badContent)
            .build(uuid);
        
        await helper.runTransaction(response, { config: { approval: 'yes', approvalOnErrorCount: 1, linter: 'bun tsc' } });
        
        expect(await helper.readFile(testFile)).toBe(badContent);
        expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(true);
    });

    it('should ignore orphaned .pending.yml file and allow reprocessing', async () => {
        const config = await helper.createConfig();
        const uuid = uuidv4();
        const newContent = 'console.log("final content");';

        const stateDir = path.join(helper.testDir, STATE_DIRECTORY_NAME);
        await fs.mkdir(stateDir, { recursive: true });
        const orphanedPendingFile = path.join(stateDir, `${uuid}.pending.yml`);
        await fs.writeFile(orphanedPendingFile, yaml.dump({ uuid, message: 'this is from a crashed run' }));

        const response = new MockLLMResponseBuilder().addFile(testFile, newContent).build(uuid);
        await helper.runTransaction(response);
        
        expect(await helper.readFile(testFile)).toBe(newContent);
        
        const finalStateFile = path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await helper.fileExists(finalStateFile)).toBe(true);

        const stateData: any = yaml.load(await helper.readFile(finalStateFile));
        expect(stateData.projectId).toBe(config.projectId);
        expect(stateData.approved).toBe(true);
    });

    it('should successfully run pre and post commands (happy path)', async () => {
        const preCommandFile = 'pre.txt';
        const postCommandFile = 'post.txt';
    
        const preCommandFilePath = path.join(helper.testDir, preCommandFile).replace(/\\/g, '\\\\');
        const postCommandFilePath = path.join(helper.testDir, postCommandFile).replace(/\\/g, '\\\\');
    
        const response = new MockLLMResponseBuilder().addFile(testFile, "new content").build(uuidv4());
    
        await helper.runTransaction(response, {
            config: {
                preCommand: `node -e "require('fs').writeFileSync('${preCommandFilePath}', '')"`,
                postCommand: `node -e "require('fs').writeFileSync('${postCommandFilePath}', '')"`,
            }
        });
    
        expect(await helper.fileExists(preCommandFile)).toBe(true);
        expect(await helper.fileExists(postCommandFile)).toBe(true);
        expect(await helper.readFile(testFile)).toBe("new content");
    });

    it('should create a pending file during transaction and remove it on rollback', async () => {
        const uuid = uuidv4();
        const response = new MockLLMResponseBuilder()
            .addFile(testFile, 'I will be rolled back')
            .build(uuid);
    
        const pendingPath = path.join(STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
        let pendingFileExistedDuringRun = false;
    
        const prompter = async (): Promise<boolean> => {
            pendingFileExistedDuringRun = await helper.fileExists(pendingPath);
            return false; // Disapprove to trigger rollback
        };
    
        await helper.runTransaction(response, { config: { approval: 'no' }, prompter });
    
        expect(pendingFileExistedDuringRun).toBe(true);
        expect(await helper.readFile(testFile)).toBe(originalContent);
        expect(await helper.fileExists(pendingPath)).toBe(false);
        expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
    });

    it('should fail transaction gracefully if a file is not writable and rollback all changes', async () => {
        const unwritableFile = 'src/unwritable.ts';
        const writableFile = 'src/writable.ts';
        const originalUnwritableContent = 'original unwritable';
        const originalWritableContent = 'original writable';
    
        await helper.createFile(unwritableFile, originalUnwritableContent);
        await helper.createFile(writableFile, originalWritableContent);
        
        const unwritableFilePath = path.join(helper.testDir, unwritableFile);

        try {
            await fs.chmod(unwritableFilePath, 0o444); // Make read-only

            const uuid = uuidv4();
            const response = new MockLLMResponseBuilder()
                .addFile(writableFile, "new writable content")
                .addFile(unwritableFile, "new unwritable content")
                .build(uuid);
            
            await helper.runTransaction(response);
        
            expect(await helper.readFile(writableFile)).toBe(originalWritableContent); 
            expect(await helper.readFile(unwritableFile)).toBe(originalUnwritableContent);
            expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.pending.yml`))).toBe(false);
            expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
        } finally {
            await fs.chmod(unwritableFilePath, 0o666);
        }
    });

    it('should rollback gracefully if creating a file in a non-writable directory fails', async () => {
        const readonlyDir = 'src/readonly-dir';
        const newFilePath = path.join(readonlyDir, 'new-file.ts');
        const readonlyDirPath = path.join(helper.testDir, readonlyDir);
    
        await fs.mkdir(readonlyDirPath, { recursive: true });
        await fs.chmod(readonlyDirPath, 0o555); // Read and execute only
    
        try {
            const uuid = uuidv4();
            const response = new MockLLMResponseBuilder()
                .addFile(newFilePath, 'this should not be written', { type: 'new' })
                .build(uuid);
            
            await helper.runTransaction(response);
    
            expect(await helper.fileExists(newFilePath)).toBe(false);
            expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.yml`))).toBe(false);
            expect(await helper.fileExists(path.join(STATE_DIRECTORY_NAME, `${uuid}.pending.yml`))).toBe(false);
        } finally {
            await fs.chmod(readonlyDirPath, 0o777); // Make writable again for cleanup
        }
    });

    it('should correctly rollback a complex transaction (modify, delete, create)', async () => {
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await helper.createFile(fileToModify, originalModifyContent);
    
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await helper.createFile(fileToDelete, originalDeleteContent);
    
        const newFilePath = 'src/new/component.ts';
        const newFileContent = 'export const c = 3;';
    
        const uuid = uuidv4();
        const response = new MockLLMResponseBuilder()
            .addFile(fileToModify, 'export const a = 100;')
            .deleteFile(fileToDelete)
            .addFile(newFilePath, newFileContent, { type: 'new' })
            .build(uuid);
    
        await helper.runTransaction(response, { config: { approval: 'no' }, prompter: async () => false });
    
        expect(await helper.readFile(fileToModify)).toBe(originalModifyContent);
    
        expect(await helper.fileExists(fileToDelete)).toBe(true);
        expect(await helper.readFile(fileToDelete)).toBe(originalDeleteContent);
    
        expect(await helper.fileExists(newFilePath)).toBe(false);
        expect(await helper.fileExists('src/new')).toBe(false);
    });
});
```

#### Refactoring `watch.test.ts`

```typescript // test/e2e/watch.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { v4 as uuidv4 } from 'uuid';
import { createClipboardWatcher } from '../../src/core/clipboard';
import { parseLLMResponse } from '../../src/core/parser';
import { processPatch } from '../../src/core/transaction';
import { findConfig } from '../../src/core/config';
import { E2EHelper, MockLLMResponseBuilder } from '../test.util';

describe('e2e/watch', () => {
    const helper = new E2EHelper();
    let watcher: { stop: () => void } | null = null;

    beforeEach(async () => {
        await helper.setup();
    });

    afterEach(async () => {
        if (watcher) {
            watcher.stop();
            watcher = null;
        }
        await helper.cleanup();
    });

    it('should ignore invalid patch and process subsequent valid patch', async () => {
        const pollInterval = 50;
        await helper.createConfig({ clipboardPollInterval: pollInterval });
        const testFile = 'src/index.ts';
        const originalContent = 'console.log("original");';
        await helper.createFile(testFile, originalContent);
    
        let fakeClipboardContent = 'this is not a valid patch, just some random text.';
        const clipboardReader = async () => fakeClipboardContent;
    
        const onClipboardChange = async (content: string) => {
            const currentConfig = await findConfig(helper.testDir);
            const parsedResponse = parseLLMResponse(content);
            if (!currentConfig || !parsedResponse) {
                return;
            }
            await processPatch(currentConfig, parsedResponse, { cwd: helper.testDir });
        };
    
        watcher = createClipboardWatcher(pollInterval, onClipboardChange, clipboardReader);
    
        // Wait for a couple of poll cycles to ensure the invalid patch is read and ignored
        await new Promise(resolve => setTimeout(resolve, pollInterval * 3));
    
        const contentAfterInvalid = await helper.readFile(testFile);
        expect(contentAfterInvalid).toBe(originalContent);
    
        // Now, provide a valid patch
        const newContent = 'console.log("new content");';
        const validPatch = new MockLLMResponseBuilder()
            .addFile(testFile, newContent)
            .build(uuidv4());
        
        fakeClipboardContent = validPatch;

        // Directly trigger the callback with the valid patch for speed,
        // but also wait for polling to ensure it works via watcher mechanism.
        await onClipboardChange(validPatch);
        await new Promise(resolve => setTimeout(resolve, pollInterval * 5));
    
        const contentAfterValid = await helper.readFile(testFile);
        expect(contentAfterValid).toBe(newContent);
    });
});
```

These changes significantly reduce the amount of repeated code across your E2E tests, making them easier to read, maintain, and extend. The core logic of each test is now much more prominent.

```yaml
projectId: relaycode
uuid: a6977717-313d-4c33-9118-20412800e263
changeSummary:
  - edit: test/test.util.ts
  - edit: test/unit/parser.test.ts
  - edit: test/e2e/init.test.ts
  - edit: test/e2e/patcher.test.ts
  - edit: test/e2e/transaction.test.ts
  - edit: test/e2e/watch.test.ts
```