import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';
import { undoCommand } from '../../src/commands/undo';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';

describe('e2e/undo', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should successfully undo a single file modification', async () => {
        const testFile = 'src/index.js';
        const originalContent = `console.log('original');`;
        const modifiedContent = `console.log('modified');`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        // 1. Apply a patch to create a transaction
        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: modifiedContent }]
        );

        // Verify file was modified
        const contentAfterPatch = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterPatch).toBe(modifiedContent);
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(true);

        // 2. Run undo command with auto-approval
        await undoCommand(context.testDir.path, async () => true);

        // 3. Verify changes
        const contentAfterUndo = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterUndo).toBe(originalContent);

        // Original transaction file should be moved to 'undone'
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(false);
        const undoneFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, 'undone', `${uuid}.yml`);
        expect(await fs.access(undoneFilePath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should cancel undo operation if user declines', async () => {
        const testFile = 'src/index.js';
        const originalContent = `console.log('original');`;
        const modifiedContent = `console.log('modified');`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: modifiedContent }]
        );

        const contentAfterPatch = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterPatch).toBe(modifiedContent);

        // Run undo command and decline confirmation
        await undoCommand(context.testDir.path, async () => false);

        // Verify that nothing changed
        const contentAfterUndo = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterUndo).toBe(modifiedContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(true);
        const undoneFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, 'undone', `${uuid}.yml`);
        expect(await fs.access(undoneFilePath).then(() => true).catch(() => false)).toBe(false);
    });

    it('should do nothing when no transactions exist', async () => {
        // Run undo in a directory with no .relaycode state
        await undoCommand(context.testDir.path);

        // The command should just log a warning and exit. No files should be created.
        const relaycodeDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const dirExists = await fs.access(relaycodeDir).then(() => true).catch(() => false);
        expect(dirExists).toBe(false);
    });

    it('should correctly undo a complex transaction (edit, delete, create)', async () => {
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await createTestFile(context.testDir.path, fileToModify, originalModifyContent);
        
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const newFilePath = 'src/components/new.ts';
        const newFileContent = 'export const c = 3;';
    
        // 1. Apply a complex patch
        const { uuid } = await runProcessPatch(
            context,
            {},
            [
                { type: 'edit', path: fileToModify, content: 'export const a = 100;' },
                { type: 'delete', path: fileToDelete },
                { type: 'new', path: newFilePath, content: newFileContent }
            ]
        );

        // Verify the patch was applied correctly
        const modifiedContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(modifiedContent).toBe('export const a = 100;');
        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);
        const newFileContentOnDisk = await fs.readFile(path.join(context.testDir.path, newFilePath), 'utf-8');
        expect(newFileContentOnDisk).toBe(newFileContent);
        const newFileDirExists = await fs.access(path.join(context.testDir.path, 'src/components')).then(() => true).catch(() => false);
        expect(newFileDirExists).toBe(true);

        // 2. Run undo
        await undoCommand(context.testDir.path, async () => true);

        // 3. Verify rollback
        const restoredModifyContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(restoredModifyContent).toBe(originalModifyContent);
        
        const restoredDeleteFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredDeleteFileExists).toBe(true);
        const restoredDeleteContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(restoredDeleteContent).toBe(originalDeleteContent);
        
        const newFileExistsAfterUndo = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExistsAfterUndo).toBe(false);
        
        // The `components` directory should also be removed as it's now empty
        const newFileDirExistsAfterUndo = await fs.access(path.join(context.testDir.path, 'src/components')).then(() => true).catch(() => false);
        expect(newFileDirExistsAfterUndo).toBe(false);

        // Verify transaction file was moved
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        expect(await fs.access(stateFilePath).then(() => true).catch(() => false)).toBe(false);
        const undoneFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, 'undone', `${uuid}.yml`);
        expect(await fs.access(undoneFilePath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should only undo the most recent transaction', async () => {
        const testFile = 'src/index.js';
        const originalContent = `console.log('v1');`;
        const v2Content = `console.log('v2');`;
        const v3Content = `console.log('v3');`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        // Transaction 1
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: v2Content }]);
        let content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v2Content);
        
        // Transaction 2
        await runProcessPatch(context, {}, [{ type: 'edit', path: testFile, content: v3Content }]);
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v3Content);

        // Undo Transaction 2
        await undoCommand(context.testDir.path, async () => true);

        // Verify file is back to v2 state
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v2Content);

        // Undo again (Transaction 1)
        await undoCommand(context.testDir.path, async () => true);

        // Verify file is back to original state
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(originalContent);
    });
});