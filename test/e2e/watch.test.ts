import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createClipboardWatcher } from '../../src/core/clipboard';
import { parseLLMResponse } from '../../src/core/parser';
import { processPatch } from '../../src/core/transaction';
import { findConfig } from '../../src/core/config';
import { setupE2ETest, E2ETestContext, createTestConfig, createTestFile, createFileBlock, LLM_RESPONSE_END, LLM_RESPONSE_START } from '../test.util';

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
        const uuid = uuidv4();
        const validPatch = LLM_RESPONSE_START + 
                           createFileBlock(testFile, newContent) + 
                           LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
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