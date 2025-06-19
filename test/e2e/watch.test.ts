import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createClipboardWatcher } from '../../src/core/clipboard';
import { parseLLMResponse } from '../../src/core/parser';
import { processPatch } from '../../src/core/transaction';
import { findConfig } from '../../src/core/config';
import { setupTestDirectory, TestDir, createTestConfig, createTestFile, createFileBlock, LLM_RESPONSE_END, LLM_RESPONSE_START } from '../test.util';

// Suppress console output for cleaner test logs
beforeEach(() => {
    global.console.info = () => {};
    global.console.log = () => {};
    global.console.warn = () => {};
    global.console.error = () => {};
    //@ts-ignore
    global.console.success = () => {};
});

describe('e2e/watch', () => {
    let testDir: TestDir;
    let watcher: { stop: () => void } | null = null;

    beforeEach(async () => {
        testDir = await setupTestDirectory();
    });

    afterEach(async () => {
        watcher?.stop();
        if (testDir) {
            await testDir.cleanup();
        }
    });

    it('should ignore invalid patch and process subsequent valid patch', async () => {
        const pollInterval = 50;
        const config = await createTestConfig(testDir.path, { clipboardPollInterval: pollInterval });
        const testFile = 'src/index.ts';
        const originalContent = 'console.log("original");';
        await createTestFile(testDir.path, testFile, originalContent);
    
        let fakeClipboardContent = 'this is not a valid patch, just some random text.';
        const clipboardReader = async () => fakeClipboardContent;
    
        const onClipboardChange = async (content: string) => {
            const currentConfig = await findConfig(testDir.path);
            const parsedResponse = parseLLMResponse(content);
            if (!currentConfig || !parsedResponse) {
                return;
            }
            await processPatch(currentConfig, parsedResponse, { cwd: testDir.path });
        };
    
        watcher = createClipboardWatcher(pollInterval, onClipboardChange, clipboardReader);
    
        // Wait for a couple of poll cycles to ensure the invalid patch is read and ignored
        await new Promise(resolve => setTimeout(resolve, pollInterval * 3));
    
        const contentAfterInvalid = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(contentAfterInvalid).toBe(originalContent);
    
        // Now, provide a valid patch
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        const validPatch = LLM_RESPONSE_START + 
                           createFileBlock(testFile, newContent) + 
                           LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        fakeClipboardContent = validPatch;

        // Wait for polling to pick up the new content. 
        // We also need to account for file system operations.
        await new Promise(resolve => setTimeout(resolve, pollInterval * 3));
    
        const contentAfterValid = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(contentAfterValid).toBe(newContent);
    });
});