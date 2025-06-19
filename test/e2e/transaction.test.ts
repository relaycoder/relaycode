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