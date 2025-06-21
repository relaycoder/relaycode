import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import {
    setupE2ETest,
    E2ETestContext,
    createTestFile,
    runProcessPatch,
    createTestConfig,
} from '../test.util';
import { revertCommand } from '../../src/commands/revert';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';
import { logger } from '../../src/utils/logger';
import { findLatestStateFile } from '../../src/core/state';

describe('e2e/revert', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
        // We need an initialized project for revert to work
        await createTestConfig(context.testDir.path);
        await fs.mkdir(path.join(context.testDir.path, STATE_DIRECTORY_NAME), { recursive: true });
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should successfully revert a simple file modification', async () => {
        const testFile = 'src/index.ts';
        const originalContent = 'console.log("v1");';
        const modifiedContent = 'console.log("v2");';
        await createTestFile(context.testDir.path, testFile, originalContent);

        // 1. Apply a patch to create a transaction (T1)
        const { uuid: t1_uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: modifiedContent }]
        );

        // Verify file was modified
        const contentAfterPatch = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterPatch).toBe(modifiedContent);

        // 2. Revert T1
        await revertCommand(t1_uuid, context.testDir.path);

        // 3. Verify changes
        const contentAfterRevert = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterRevert).toBe(originalContent);

        // 4. Verify that a new transaction (T2) was created for the revert
        const t2 = await findLatestStateFile(context.testDir.path);
        expect(t2).not.toBeNull();
        expect(t2!.uuid).not.toBe(t1_uuid);
        expect(t2!.reasoning.join(' ')).toContain(`Reverting transaction ${t1_uuid}`);

        // 5. Verify T1 and T2 state files exist
        const t1StatePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${t1_uuid}.yml`);
        const t2StatePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${t2!.uuid}.yml`);
        expect(await fs.access(t1StatePath).then(() => true).catch(() => false)).toBe(true);
        expect(await fs.access(t2StatePath).then(() => true).catch(() => false)).toBe(true);
    });

    it('should correctly revert a complex transaction (edit, delete, create)', async () => {
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await createTestFile(context.testDir.path, fileToModify, originalModifyContent);
        
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const newFilePath = 'src/components/new.ts';
        const newFileContent = 'export const c = 3;';
    
        // 1. Apply a complex patch (T1)
        const { uuid: t1_uuid } = await runProcessPatch(
            context, {},
            [
                { type: 'edit', path: fileToModify, content: 'export const a = 100;' },
                { type: 'delete', path: fileToDelete },
                { type: 'new', path: newFilePath, content: newFileContent }
            ]
        );
        
        // 2. Revert T1
        await revertCommand(t1_uuid, context.testDir.path);

        // 3. Verify rollback
        const restoredModifyContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(restoredModifyContent).toBe(originalModifyContent);
        
        const restoredDeleteFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredDeleteFileExists).toBe(true);
        const restoredDeleteContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(restoredDeleteContent).toBe(originalDeleteContent);
        
        const newFileExistsAfterRevert = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExistsAfterRevert).toBe(false);

        // 4. Verify a new transaction (T2) was created
        const t2 = await findLatestStateFile(context.testDir.path);
        expect(t2).not.toBeNull();
        expect(t2!.uuid).not.toBe(t1_uuid);
    });

    it('should log an error and do nothing if UUID does not exist', async () => {
        let errorLog = '';
        (logger as any).error = (msg: string) => { errorLog = msg; };

        const fakeUuid = '00000000-0000-0000-0000-000000000000';
        await revertCommand(fakeUuid, context.testDir.path);
        
        expect(errorLog).toContain(`Transaction with UUID '${fakeUuid}' not found`);
    });

    it('should be possible to revert a revert', async () => {
        const testFile = 'src/index.ts';
        const v1 = 'v1';
        const v2 = 'v2';
        await createTestFile(context.testDir.path, testFile, v1);

        // 1. Apply patch to go from v1 -> v2 (T1)
        const { uuid: t1_uuid } = await runProcessPatch(
            context, {},
            [{ type: 'edit', path: testFile, content: v2 }]
        );
        let content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v2);

        // 2. Revert T1 to go from v2 -> v1 (T2)
        await revertCommand(t1_uuid, context.testDir.path);
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v1);

        // 3. Get T2's UUID and revert it to go from v1 -> v2 (T3)
        const t2 = await findLatestStateFile(context.testDir.path);
        expect(t2).not.toBeNull();
        await revertCommand(t2!.uuid, context.testDir.path);
        content = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(content).toBe(v2);

        // 4. Check that we have 3 state files
        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const files = (await fs.readdir(stateDir)).filter(f => f.endsWith('.yml'));
        expect(files.length).toBe(3);
    });
});