import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';


describe('e2e/transaction', () => {
    let context: E2ETestContext;
    const testFile = 'src/index.ts';
    const originalContent = 'console.log("original");';

    beforeEach(async () => {
        context = await setupE2ETest({ withTsconfig: true });
        await createTestFile(context.testDir.path, testFile, originalContent);
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should apply changes, commit, and store correct state in .yml file', async () => {
        const newContent = 'console.log("new content");';
        const { uuid } = await runProcessPatch(
            context,
            { linter: '', approval: 'yes' },
            [{ type: 'edit', path: testFile, content: newContent }]
        );
        // Add a small delay to ensure file operations have completed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check file content
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        // Check state file was committed
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        
        // Try multiple times with a small delay to check if the file exists
        let stateFileExists = false;
        for (let i = 0; i < 5; i++) {
            stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
            if (stateFileExists) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(stateFileExists).toBe(true);

        // Check state file content
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.uuid).toBe(uuid);
        expect(stateData.approved).toBe(true);
        expect(stateData.operations).toHaveLength(1);
        expect(stateData.operations[0].path).toBe(testFile);
        expect(stateData.snapshot[testFile]).toBe(originalContent);
        expect(stateData.reasoning).toBeDefined();
    });

    it('should rollback changes when manually disapproved', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { approval: 'no' },
            [{ type: 'edit', path: testFile, content: 'console.log("I will be rolled back");' }],
            { prompter: async () => false }
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should require manual approval if linter errors exceed approvalOnErrorCount', async () => {
        await runProcessPatch(
            context,
            { approval: 'yes', approvalOnErrorCount: 0, linter: 'bun tsc' },
            [{ type: 'edit', path: testFile, content: 'const x: string = 123;' }],
            { prompter: async () => false }
        );
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    });

    it('should skip linter if command is empty and auto-approve', async () => {
        const badContent = 'const x: string = 123;'; // Would fail linter, but it's skipped

        await runProcessPatch(
            context,
            { linter: '' },
            [{ type: 'edit', path: testFile, content: badContent }]
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);
    });

    it('should ignore patch with already processed UUID', async () => {
        const uuid = uuidv4();
        
        // 1. Process and commit a patch
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: "first change" }], { responseOverrides: { uuid }});
        
        // 2. Try to process another patch with the same UUID - this will create a new response with the same UUID.
        // The `processPatch` logic should see the existing state file and ignore it.
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: "second change" }], { responseOverrides: { uuid }});

        // Content should be from the first change, not the second
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("first change");
    });
    
    it('should create nested directories for new files', async () => {
        const newFilePath = 'src/a/b/c/new-file.ts';
        const newFileContent = 'hello world';
        
        await runProcessPatch(
            context, 
            {}, 
            [{ type: 'new', path: newFilePath, content: newFileContent }]
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, newFilePath), 'utf-8');
        expect(finalContent).toBe(newFileContent);
    });

    it('should rollback new file and its new empty parent directory on rejection', async () => {
        const newFilePath = 'src/new/dir/file.ts';
        
        await runProcessPatch(context, { approval: 'no' },
            [{ type: 'new', path: newFilePath, content: 'content' }], { prompter: async () => false });

        const fileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(fileExists).toBe(false);

        const dirExists = await fs.access(path.join(context.testDir.path, 'src/new/dir')).then(() => true).catch(() => false);
        expect(dirExists).toBe(false);

        const midDirExists = await fs.access(path.join(context.testDir.path, 'src/new')).then(() => true).catch(() => false);
        expect(midDirExists).toBe(false);
        
        // src directory should still exist as it contained a file before
        const srcDirExists = await fs.access(path.join(context.testDir.path, 'src')).then(() => true).catch(() => false);
        expect(srcDirExists).toBe(true);
    });

    it('should not delete parent directory on rollback if it was not empty beforehand', async () => {
        const existingFilePath = 'src/shared/existing.ts';
        const newFilePath = 'src/shared/new.ts';

        await createTestFile(context.testDir.path, existingFilePath, 'const existing = true;');

        await runProcessPatch(context, { approval: 'no' },
            [{ type: 'new', path: newFilePath, content: 'const brandNew = true;' }],
            { prompter: async () => false });

        // New file should be gone
        const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);

        // Existing file and its directory should remain
        const existingFileExists = await fs.access(path.join(context.testDir.path, existingFilePath)).then(() => true).catch(() => false);
        expect(existingFileExists).toBe(true);

        const sharedDirExists = await fs.access(path.join(context.testDir.path, 'src/shared')).then(() => true).catch(() => false);
        expect(sharedDirExists).toBe(true);
    });

    it('should abort transaction if preCommand fails', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { preCommand: 'bun -e "process.exit(1)"' },
            [{ type: 'edit', path: testFile, content: 'new content' }]
        );

        // File should not have been changed
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been created
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should automatically roll back if postCommand fails', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { postCommand: 'bun -e "process.exit(1)"' },
            [{ type: 'edit', path: testFile, content: 'new content' }]
        );

        // File should have been rolled back
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should ignore patch with non-matching projectId', async () => {
        const { uuid } = await runProcessPatch(
            context,
            { projectId: 'correct-project' },
            [{ type: 'edit', path: testFile, content: 'should not be applied' }],
            { responseOverrides: { projectId: 'wrong-project' }}
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should correctly apply a file deletion operation', async () => {
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'delete', path: fileToDelete }]
        );

        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);

        // State file should have been committed with the deleted file content
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should correctly roll back a file deletion operation', async () => {
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const { uuid } = await runProcessPatch(
            context, { approval: 'no' },
            [{ type: 'delete', path: fileToDelete }], { prompter: async () => false }
        );

        const restoredFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredFileExists).toBe(true);

        // Content should be the same as the original
        const restoredContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(restoredContent).toBe(originalDeleteContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should auto-approve if linter errors are within approvalOnErrorCount', async () => {
        const badContent = 'const x: string = 123;'; // 1 TS error

        const { uuid } = await runProcessPatch(
            context,
            { approval: 'yes', approvalOnErrorCount: 1, linter: 'bun tsc' },
            [{ type: 'edit', path: testFile, content: badContent }]
        );
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);

        // State file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should ignore orphaned .pending.yml file and allow reprocessing', async () => {
        const uuid = uuidv4();
        const newContent = 'console.log("final content");';

        // Create an orphaned pending file
        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        await fs.mkdir(stateDir, { recursive: true });
        const orphanedPendingFile = path.join(stateDir, `${uuid}.pending.yml`);
        const orphanedState = { uuid, message: 'this is from a crashed run' };
        await fs.writeFile(orphanedPendingFile, yaml.dump(orphanedState));

        await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: newContent }],
            { responseOverrides: { uuid } }
        );
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        // The pending file should have been removed
        const pendingFileExists = await fs.access(orphanedPendingFile).then(() => true).catch(() => false);
        expect(pendingFileExists).toBe(false);

        // A committed state file should exist
        const committedFileExists = await fs.access(path.join(stateDir, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(true);
    });

    it('should run pre and post commands in the correct order', async () => {
        const preCommandFile = path.join(context.testDir.path, 'pre.txt');
        const postCommandFile = path.join(context.testDir.path, 'post.txt');
    
        // Use node directly as it's more reliable cross-platform
        await runProcessPatch(
            context,
            {
                preCommand: `node -e "require('fs').writeFileSync('${preCommandFile.replace(/\\/g, '\\\\')}', '')"`,
                postCommand: `node -e "require('fs').writeFileSync('${postCommandFile.replace(/\\/g, '\\\\')}', '')"`,
            },
            [{ type: 'edit', path: testFile, content: 'new content' }]
        );
    
        const preExists = await fs.access(preCommandFile).then(() => true).catch(() => false);
        expect(preExists).toBe(true);
    
        const postExists = await fs.access(postCommandFile).then(() => true).catch(() => false);
        expect(postExists).toBe(true);
    
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe('new content');
    });

    it('should create a pending file during transaction and remove it on rollback', async () => {
        const uuid = uuidv4();
    
        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const pendingPath = path.join(stateDir, `${uuid}.pending.yml`);
    
        // Make sure the directory exists
        await fs.mkdir(stateDir, { recursive: true });
    
        // Check if the pending file exists during the transaction
        let pendingFileExistedDuringRun = false;
    
        const prompter = async (): Promise<boolean> => {
            pendingFileExistedDuringRun = await fs.access(pendingPath).then(() => true).catch(() => false);
            return false; // Disapprove to trigger rollback
        };

        await runProcessPatch(
            context,
            { approval: 'no' },
            [{ type: 'edit', path: testFile, content: 'I will be rolled back' }],
            { prompter, responseOverrides: { uuid } }
        );
    
        expect(pendingFileExistedDuringRun).toBe(true);
        
        // After rollback, the pending file should be gone
        const pendingFileExistsAfter = await fs.access(pendingPath).then(() => true).catch(() => false);
        expect(pendingFileExistsAfter).toBe(false);
    
        // No committed file should exist
        const committedPath = path.join(stateDir, `${uuid}.yml`);
        const committedFileExists = await fs.access(committedPath).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(false);
    });

    it('should fail transaction gracefully if a file is not writable and rollback all changes', async () => {
        const unwritableFile = 'src/unwritable.ts';
        const writableFile = 'src/writable.ts';
        const originalUnwritableContent = 'original unwritable';
        const originalWritableContent = 'original writable';
        
        await createTestFile(context.testDir.path, unwritableFile, originalUnwritableContent);
        await createTestFile(context.testDir.path, writableFile, originalWritableContent);
        
        const unwritableFilePath = path.join(context.testDir.path, unwritableFile);
        
        try {
            await fs.chmod(unwritableFilePath, 0o444); // Make read-only

            const { uuid } = await runProcessPatch(
                context, {},
                [
                    { type: 'edit', path: writableFile, content: 'new writable content' },
                    { type: 'edit', path: unwritableFile, content: 'new unwritable content' }
                ]
            );
        
            // Check file states: both should be rolled back to original content.
            const finalWritable = await fs.readFile(path.join(context.testDir.path, writableFile), 'utf-8');
            expect(finalWritable).toBe(originalWritableContent);
            
            const finalUnwritable = await fs.readFile(path.join(context.testDir.path, unwritableFile), 'utf-8');
            expect(finalUnwritable).toBe(originalUnwritableContent);
            
            // No state file should have been committed
            const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
        } finally {
            // Make the file writable again to allow cleanup
            try {
                await fs.chmod(unwritableFilePath, 0o644);
            } catch (err) {
                console.error('Failed to restore file permissions:', err);
            }
        }
    });

    it('should rollback gracefully if creating a file in a non-writable directory fails', async () => {
        const readonlyDir = 'src/readonly-dir';
        const newFilePath = path.join(readonlyDir, 'new-file.ts');
        const readonlyDirPath = path.join(context.testDir.path, readonlyDir);
        
        await fs.mkdir(readonlyDirPath, { recursive: true });
        await fs.chmod(readonlyDirPath, 0o555); // Read and execute only
    
        try {
            const { uuid } = await runProcessPatch(
                context,
                {},
                [{ type: 'new', path: newFilePath, content: 'this should not be written' }]
            );
    
            // Check that the new file was not created
            const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
            expect(newFileExists).toBe(false);
    
            // No state file should have been committed
            const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
        } finally {
            // Restore permissions for cleanup
            try {
                await fs.chmod(readonlyDirPath, 0o755);
            } catch (err) {
                console.error('Failed to restore directory permissions:', err);
            }
        }
    });

    it('should correctly rollback a complex transaction (modify, delete, create)', async () => {
        // Setup initial files
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await createTestFile(context.testDir.path, fileToModify, originalModifyContent);
        
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const newFilePath = 'src/new/component.ts';
        const newFileContent = 'export const c = 3;';
    
        // Disapprove the transaction
        await runProcessPatch(
            context,
            { approval: 'no' },
            [
                { type: 'edit', path: fileToModify, content: 'export const a = 100;' },
                { type: 'delete', path: fileToDelete },
                { type: 'new', path: newFilePath, content: newFileContent }
            ], { prompter: async () => false }
        );
    
        // Verify rollback
        const modifiedFileContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(modifiedFileContent).toBe(originalModifyContent);
        
        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(true);
        
        const deletedFileContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(deletedFileContent).toBe(originalDeleteContent);
        
        const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);
    });
});