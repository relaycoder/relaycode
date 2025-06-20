import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { processPatch } from '../../src/core/transaction';
import { parseLLMResponse } from '../../src/core/parser';
import { setupTestDirectory, TestDir, createTestConfig, createTestFile, LLM_RESPONSE_END, createFileBlock } from '../test.util';

// Mock the diff-apply library
mock.module('diff-apply', () => {
    const multiSearchReplaceLogic = (params: { originalContent: string; diffContent: string; }): { success: boolean; content: string; error?: string; } => {
        let modifiedContent = params.originalContent;
        const blocks = params.diffContent.split('>>>>>>> REPLACE').filter(b => b.trim());
        
        for (const block of blocks) {
            const parts = block.split('=======');
            if (parts.length !== 2) return { success: false, content: params.originalContent, error: 'Invalid block' };

            const searchBlock = parts[0];
            let replaceContent = parts[1];

            if (searchBlock === undefined || replaceContent === undefined) {
                return { success: false, content: params.originalContent, error: 'Invalid block structure' };
            }

            const searchPart = searchBlock.split('<<<<<<< SEARCH')[1];
            if (!searchPart) return { success: false, content: params.originalContent, error: 'Invalid search block' };
            
            const searchContentPart = searchPart.split('-------')[1];
            if (searchContentPart === undefined) return { success: false, content: params.originalContent, error: 'Invalid search block content' };

            let searchContent = searchContentPart;
            if (searchContent.startsWith('\n')) searchContent = searchContent.substring(1);
            if (searchContent.endsWith('\n')) searchContent = searchContent.slice(0, -1);
            if (replaceContent.startsWith('\n')) replaceContent = replaceContent.substring(1);
            if (replaceContent.endsWith('\n')) replaceContent = replaceContent.slice(0, -1);

            if (modifiedContent.includes(searchContent)) {
                modifiedContent = modifiedContent.replace(searchContent, replaceContent);
            } else {
                return { success: false, content: params.originalContent, error: 'Search content not found' };
            }
        }
        return { success: true, content: modifiedContent };
    };

    return {
        newUnifiedDiffStrategyService: {
            newUnifiedDiffStrategyService: {
                create: () => ({
                    applyDiff: async (p: any) => ({ success: false, content: p.originalContent, error: 'Not implemented' })
                })
            }
        },
        multiSearchReplaceService: {
            multiSearchReplaceService: {
                applyDiff: async (params: { originalContent: string, diffContent: string }) => {
                    return multiSearchReplaceLogic(params);
                }
            }
        },
        unifiedDiffService: {
            unifiedDiffService: {
                applyDiff: async (p: any) => ({ success: false, content: p.originalContent, error: 'Not implemented' })
            }
        }
    };
});


describe('e2e/patcher', () => {
    let testDir: TestDir;

    beforeEach(async () => {
        testDir = await setupTestDirectory();
        // Suppress console output for cleaner test logs
        global.console.info = () => {};
        global.console.log = () => {};
        global.console.warn = () => {};
        global.console.error = () => {};
        //@ts-ignore
        global.console.success = () => {};
    });

    afterEach(async () => {
        await testDir.cleanup();
    });

    it('should correctly apply a patch using the multi-search-replace strategy', async () => {
        const config = await createTestConfig(testDir.path);
        const testFile = 'src/config.js';
        const originalContent = `
const config = {
    port: 3000,
    host: 'localhost',
    enableLogging: true,
};
`;
        await createTestFile(testDir.path, testFile, originalContent);

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
        
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'multi-search-replace') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(llmResponse);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        
        const expectedContent = `
const config = {
    port: 8080,
    host: 'localhost',
    enableLogging: false,
};
`;
        expect(finalContent.replace(/\s/g, '')).toBe(expectedContent.replace(/\s/g, ''));
    });

    it('should fail transaction if multi-search-replace content is not found', async () => {
        const config = await createTestConfig(testDir.path);
        const testFile = 'src/index.js';
        const originalContent = 'const version = 1;';
        await createTestFile(testDir.path, testFile, originalContent);

        const diffContent = `
<<<<<<< SEARCH
-------
const version = 2; // This content does not exist
=======
const version = 3;
>>>>>>> REPLACE
`;
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'multi-search-replace') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(llmResponse)!;

        await processPatch(config, parsedResponse, { cwd: testDir.path });

        // The file content should remain unchanged
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(testDir.path, '.relaycode', `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });
});