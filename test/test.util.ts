import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Config, PatchStrategy } from '../src/types';
import { CONFIG_FILE_NAME } from '../src/utils/constants';
import { logger } from '../src/utils/logger';

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

export const LLM_RESPONSE_END = (uuid: string, changeSummary: { [key: string]: string }[]) => `
\`\`\`yaml
projectId: test-project
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