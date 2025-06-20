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
        // A tsconfig is needed for `bun tsc` to run and find files
        await createTestFile(testDir.path, 'tsconfig.json', JSON.stringify({
            "compilerOptions": { "strict": true, "noEmit": true, "isolatedModules": true },
            "include": ["src/**/*.ts"]
        }));
    });

    afterEach(async () => {
        if (testDir) {
            await testDir.cleanup();
        }
    });

    it('should apply changes, commit, and store correct state in .yml file', async () => {
        const config = await createTestConfig(testDir.path, { 
            linter: '', // Skip actual linting to avoid timeout
            approval: 'yes'
        });
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
        expect(stateData.reasoning).toEqual(parsedResponse!.reasoning);
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

    it('should not delete parent directory on rollback if it was not empty beforehand', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const existingFilePath = 'src/shared/existing.ts';
        const newFilePath = 'src/shared/new.ts';
        const uuid = uuidv4();

        await createTestFile(testDir.path, existingFilePath, 'const existing = true;');

        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, 'const brandNew = true;') +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { prompter: async () => false, cwd: testDir.path });

        // New file should be gone
        const newFileExists = await fs.access(path.join(testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);

        // Existing file and its directory should remain
        const existingFileExists = await fs.access(path.join(testDir.path, existingFilePath)).then(() => true).catch(() => false);
        expect(existingFileExists).toBe(true);

        const sharedDirExists = await fs.access(path.join(testDir.path, 'src/shared')).then(() => true).catch(() => false);
        expect(sharedDirExists).toBe(true);
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

    it('should ignore patch with non-matching projectId', async () => {
        const config = await createTestConfig(testDir.path, { projectId: 'correct-project' });
        const uuid = uuidv4();
        
        const responseWithWrongProject =
`\`\`\`typescript // {src/index.ts}
// START
console.log("should not be applied");
// END
\`\`\`
\`\`\`yaml
projectId: wrong-project
uuid: ${uuid}
changeSummary: []
\`\`\``;
        
        const parsedResponse = parseLLMResponse(responseWithWrongProject);
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should correctly apply a file deletion operation', async () => {
        const config = await createTestConfig(testDir.path);
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(testDir.path, fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createDeleteFileBlock(fileToDelete) +
                         LLM_RESPONSE_END(uuid, [{ delete: fileToDelete }]);
        const parsedResponse = parseLLMResponse(response)!;
        
        await processPatch(config, parsedResponse, { cwd: testDir.path });

        const deletedFileExists = await fs.access(path.join(testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);
        
        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.snapshot[fileToDelete]).toBe(originalDeleteContent);
        expect(stateData.operations[0]).toEqual({ type: 'delete', path: fileToDelete });
    });

    it('should correctly roll back a file deletion operation', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(testDir.path, fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createDeleteFileBlock(fileToDelete) +
                         LLM_RESPONSE_END(uuid, [{ delete: fileToDelete }]);

        const parsedResponse = parseLLMResponse(response)!;
        
        await processPatch(config, parsedResponse, { prompter: async () => false, cwd: testDir.path });

        const restoredFileExists = await fs.access(path.join(testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredFileExists).toBe(true);
        const content = await fs.readFile(path.join(testDir.path, fileToDelete), 'utf-8');
        expect(content).toBe(originalDeleteContent);
        
        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should auto-approve if linter errors are within approvalOnErrorCount', async () => {
        const config = await createTestConfig(testDir.path, {
            approval: 'yes',
            approvalOnErrorCount: 1,
            linter: 'bun tsc'
        });
        const badContent = 'const x: string = 123;'; // 1 TS error
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                        createFileBlock(testFile, badContent) + 
                        LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!, { cwd: testDir.path });
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);

        const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should ignore orphaned .pending.yml file and allow reprocessing', async () => {
        const config = await createTestConfig(testDir.path);
        const uuid = uuidv4();
        const newContent = 'console.log("final content");';

        const stateDir = path.join(testDir.path, STATE_DIRECTORY_NAME);
        await fs.mkdir(stateDir, { recursive: true });
        const orphanedPendingFile = path.join(stateDir, `${uuid}.pending.yml`);
        const orphanedState = { uuid, message: 'this is from a crashed run' };
        await fs.writeFile(orphanedPendingFile, yaml.dump(orphanedState));

        const response = LLM_RESPONSE_START + createFileBlock(testFile, newContent) + LLM_RESPONSE_END(uuid, []);
        const parsedResponse = parseLLMResponse(response)!;
        await processPatch(config, parsedResponse, { cwd: testDir.path });
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        const finalStateFile = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(finalStateFile).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
        
        const stateFileContent = await fs.readFile(finalStateFile, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.projectId).toBe(config.projectId);
        expect(stateData.approved).toBe(true);
    });

    it('should successfully run pre and post commands (happy path)', async () => {
        const preCommandFile = path.join(testDir.path, 'pre.txt');
        const postCommandFile = path.join(testDir.path, 'post.txt');
    
        // Use node directly as it's more reliable cross-platform
        const config = await createTestConfig(testDir.path, {
            preCommand: `node -e "require('fs').writeFileSync('${preCommandFile.replace(/\\/g, '\\\\')}', '')"`,
            postCommand: `node -e "require('fs').writeFileSync('${postCommandFile.replace(/\\/g, '\\\\')}', '')"`,
        });
    
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);
        const parsed = parseLLMResponse(response)!;
    
        await processPatch(config, parsed, { cwd: testDir.path });
    
        const preExists = await fs.access(preCommandFile).then(() => true).catch(() => false);
        expect(preExists).toBe(true);
    
        const postExists = await fs.access(postCommandFile).then(() => true).catch(() => false);
        expect(postExists).toBe(true);
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("new content");
    });

    it('should create a pending file during transaction and remove it on rollback', async () => {
        const config = await createTestConfig(testDir.path, { approval: 'no' });
        const newContent = 'I will be rolled back';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
    
        const parsedResponse = parseLLMResponse(response)!;
    
        const stateDir = path.join(testDir.path, STATE_DIRECTORY_NAME);
        const pendingPath = path.join(stateDir, `${uuid}.pending.yml`);
        const committedPath = path.join(stateDir, `${uuid}.yml`);
    
        let pendingFileExistedDuringRun = false;
    
        const prompter = async (): Promise<boolean> => {
            // At this point, the pending file should exist before we answer the prompt
            pendingFileExistedDuringRun = await fs.access(pendingPath).then(() => true).catch(() => false);
            return false; // Disapprove to trigger rollback
        };
    
        await processPatch(config, parsedResponse, { prompter, cwd: testDir.path });
    
        expect(pendingFileExistedDuringRun).toBe(true);
        
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    
        const pendingFileExistsAfter = await fs.access(pendingPath).then(() => true).catch(() => false);
        expect(pendingFileExistsAfter).toBe(false);
    
        const committedFileExists = await fs.access(committedPath).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(false);
    });

    it('should fail transaction gracefully if a file is not writable and rollback all changes', async () => {
        const config = await createTestConfig(testDir.path);
        const unwritableFile = 'src/unwritable.ts';
        const writableFile = 'src/writable.ts';
        const originalUnwritableContent = 'original unwritable';
        const originalWritableContent = 'original writable';
    
        await createTestFile(testDir.path, unwritableFile, originalUnwritableContent);
        await createTestFile(testDir.path, writableFile, originalWritableContent);
        
        const unwritableFilePath = path.join(testDir.path, unwritableFile);

        try {
            await fs.chmod(unwritableFilePath, 0o444); // Make read-only

            const uuid = uuidv4();
            const response = LLM_RESPONSE_START +
                createFileBlock(writableFile, "new writable content") +
                createFileBlock(unwritableFile, "new unwritable content") +
                LLM_RESPONSE_END(uuid, [{ edit: writableFile }, { edit: unwritableFile }]);
            
            const parsedResponse = parseLLMResponse(response)!;
            await processPatch(config, parsedResponse, { cwd: testDir.path });
        
            // Check file states: both should be rolled back to original content.
            const finalWritable = await fs.readFile(path.join(testDir.path, writableFile), 'utf-8');
            expect(finalWritable).toBe(originalWritableContent); 

            const finalUnwritable = await fs.readFile(unwritableFilePath, 'utf-8');
            expect(finalUnwritable).toBe(originalUnwritableContent);
        
            // Check that pending and final state files were cleaned up/not created.
            const pendingStatePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
            const pendingFileExists = await fs.access(pendingStatePath).then(() => true).catch(() => false);
            expect(pendingFileExists).toBe(false);

            const finalStatePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
            const finalStateExists = await fs.access(finalStatePath).then(() => true).catch(() => false);
            expect(finalStateExists).toBe(false);
        } finally {
            // Ensure file is writable again so afterEach hook can clean up
            await fs.chmod(unwritableFilePath, 0o666);
        }
    });

    it('should rollback gracefully if creating a file in a non-writable directory fails', async () => {
        const config = await createTestConfig(testDir.path);
        const readonlyDir = 'src/readonly-dir';
        const newFilePath = path.join(readonlyDir, 'new-file.ts');
        const readonlyDirPath = path.join(testDir.path, readonlyDir);
    
        await fs.mkdir(readonlyDirPath, { recursive: true });
        await fs.chmod(readonlyDirPath, 0o555); // Read and execute only
    
        try {
            const uuid = uuidv4();
            const response = LLM_RESPONSE_START +
                createFileBlock(newFilePath, 'this should not be written') +
                LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);
            
            const parsedResponse = parseLLMResponse(response)!;
            await processPatch(config, parsedResponse, { cwd: testDir.path });
    
            // Check that the new file was not created
            const newFileExists = await fs.access(path.join(testDir.path, newFilePath)).then(() => true).catch(() => false);
            expect(newFileExists).toBe(false);
    
            // Check that the transaction was rolled back (no final .yml file)
            const stateFilePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
            const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
            
            // Check that pending state file was cleaned up
            const pendingStatePath = path.join(testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
            const pendingFileExists = await fs.access(pendingStatePath).then(() => true).catch(() => false);
            expect(pendingFileExists).toBe(false);
    
        } finally {
            await fs.chmod(readonlyDirPath, 0o777); // Make writable again for cleanup
        }
    });
});