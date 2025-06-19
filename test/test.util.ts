import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Config } from '../src/types';
import { CONFIG_FILE_NAME } from '../src/utils/constants';

export interface TestDir {
    path: string;
    cleanup: () => Promise<void>;
}

export const setupTestDirectory = async (): Promise<TestDir> => {
    const testDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'relaycode-test-'));

    const originalCwd = process.cwd();
    process.chdir(testDirPath);

    const cleanup = async () => {
        process.chdir(originalCwd);
        await fs.rm(testDirPath, { recursive: true, force: true });
    };

    // Automatically cleanup on process exit/signals to avoid leftover files
    const cleanupAndExit = async () => {
        await cleanup();
        process.exit();
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanupAndExit);
    process.on('SIGTERM', cleanupAndExit);
    process.on('uncaughtException', cleanupAndExit);

    return { path: testDirPath, cleanup };
};

export const createTestConfig = async (overrides: Partial<Config> = {}): Promise<Config> => {
    const defaultConfig: Config = {
        projectId: 'test-project',
        clipboardPollInterval: 100,
        approval: 'yes',
        approvalOnErrorCount: 0,
        linter: 'true', // A command that always succeeds
        preCommand: '',
        postCommand: '',
    };
    const config = { ...defaultConfig, ...overrides };
    await fs.writeFile(CONFIG_FILE_NAME, JSON.stringify(config, null, 2));
    return config;
};

export const createTestFile = async (filePath: string, content: string): Promise<void> => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content);
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

export const createFileBlock = (filePath: string, content: string): string => {
    return `
\`\`\`typescript // {${filePath}}
// START

${content}

// END
\`\`\`
`;
};

export const createDeleteFileBlock = (filePath: string): string => {
    return `
\`\`\`typescript // {${filePath}}
//TODO: delete this file
\`\`\`
`;
};