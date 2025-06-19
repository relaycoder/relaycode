import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
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
        await createTestFile(testFile, originalContent);
        // A tsconfig is needed for `bun tsc` to run
        await createTestFile('tsconfig.json', JSON.stringify({
            compilerOptions: { "strict": true }
        }));
    });

    afterEach(async () => {
        if (testDir) {
            await testDir.cleanup();
        }
    });

    it('should apply changes and commit when auto-approved', async () => {
        const config = await createTestConfig({ linter: `bun tsc --noEmit` });
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!);

        const finalContent = await fs.readFile(testFile, 'utf-8');
        expect(finalContent).toBe(newContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);

        const pendingStateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
        const pendingStateFileExists = await fs.access(pendingStateFilePath).then(() => true).catch(() => false);
        expect(pendingStateFileExists).toBe(false);
    });

    it('should rollback changes when manually disapproved', async () => {
        const config = await createTestConfig({ approval: 'no' });
        const newContent = 'const x: number = "hello";'; // This would also fail linter, but approval:no is checked first
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        const prompter = async () => false; // Disapprove
        await processPatch(config, parsedResponse!, { prompter });

        const finalContent = await fs.readFile(testFile, 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should rollback changes on linter failure if not auto-approved', async () => {
        const config = await createTestConfig({ 
            approval: 'yes', // try to auto-approve
            approvalOnErrorCount: 0, // but fail if there is any error
            linter: `bun tsc --noEmit`
        });
        const badContent = 'const x: string = 123;'; // TS error
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, badContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        // This will require manual approval because linter fails, so we need a prompter
        const prompter = async () => false; // User sees errors and disapproves
        await processPatch(config, parsedResponse!, { prompter });

        const finalContent = await fs.readFile(testFile, 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should commit changes if linter errors are within approvalOnErrorCount', async () => {
        await createTestFile(testFile, `function one() { const x: string = 1; }`); // 1 error
        const config = await createTestConfig({ 
            approval: 'yes',
            approvalOnErrorCount: 2, // Allow up to 2 errors
            linter: `bun tsc --noEmit`
        });
        const newContentWithErrors = `function one() { const x: string = 1; }\nfunction two() { const y: string = 2; }`; // 2 errors
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContentWithErrors) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!);

        const finalContent = await fs.readFile(testFile, 'utf-8');
        expect(finalContent).toBe(newContentWithErrors);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should correctly handle file creation and deletion in a single transaction', async () => {
        const config = await createTestConfig();
        const newFilePath = 'src/new-file.ts';
        const newFileContent = 'export const hello = "world";';
        const fileToDeletePath = 'src/to-delete.ts';
        await createTestFile(fileToDeletePath, 'delete me');
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(newFilePath, newFileContent) +
                         createDeleteFileBlock(fileToDeletePath) +
                         LLM_RESPONSE_END(uuid, [{ new: newFilePath }, { delete: fileToDeletePath }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!);

        // Check new file was created
        const newFileContentResult = await fs.readFile(newFilePath, 'utf-8');
        expect(newFileContentResult).toBe(newFileContent);

        // Check old file was deleted
        const deletedFileExists = await fs.access(fileToDeletePath).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);

        // Check state was committed
        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

     it('should not process a patch with a mismatched projectId', async () => {
        const config = await createTestConfig({ projectId: 'real-project' });
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        // LLM_RESPONSE_END uses 'test-project' by default from the test util
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        // Manually set a different projectId than the one in the config
        parsedResponse!.control.projectId = 'wrong-project'; 

        await processPatch(config, parsedResponse!);

        const finalContent = await fs.readFile(testFile, 'utf-8');
        expect(finalContent).toBe(originalContent); // No change should have occurred
    });
});