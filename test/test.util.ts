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

    const cleanup = async () => {
        await fs.rm(testDirPath, { recursive: true, force: true });
    };

    return { path: testDirPath, cleanup };
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