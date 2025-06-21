import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { initCommand } from '../../src/commands/init';
import { setupE2ETest, E2ETestContext, createTestFile } from '../test.util';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../../src/utils/constants';
import { ConfigSchema } from '../../src/types';
import { logger } from '../../src/utils/logger';

describe('e2e/init', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should create config file with correct defaults, state directory, and .gitignore', async () => {
        await initCommand(context.testDir.path);

        // Check for config file
        const configPath = path.join(context.testDir.path, CONFIG_FILE_NAME);
        const configExists = await fs.access(configPath).then(() => true).catch(() => false);
        expect(configExists).toBe(true);

        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        
        // Validate against schema to check defaults
        const parsedConfig = ConfigSchema.parse(config);
        expect(parsedConfig.projectId).toBe(path.basename(context.testDir.path));
        expect(parsedConfig.clipboardPollInterval).toBe(2000);
        expect(parsedConfig.approval).toBe('yes');
        expect(parsedConfig.linter).toBe('bun tsc --noEmit');

        // Check for state directory
        const stateDirPath = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const stateDirExists = await fs.stat(stateDirPath).then(s => s.isDirectory()).catch(() => false);
        expect(stateDirExists).toBe(true);

        // Check for .gitignore
        const gitignorePath = path.join(context.testDir.path, GITIGNORE_FILE_NAME);
        const gitignoreExists = await fs.access(gitignorePath).then(() => true).catch(() => false);
        expect(gitignoreExists).toBe(true);

        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should use package.json name for projectId if available', async () => {
        const pkgName = 'my-awesome-project';
        await createTestFile(context.testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        await initCommand(context.testDir.path);

        const configPath = path.join(context.testDir.path, CONFIG_FILE_NAME);
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe(pkgName);
    });

    it('should append to existing .gitignore', async () => {
        const initialContent = '# Existing rules\nnode_modules/';
        await createTestFile(context.testDir.path, GITIGNORE_FILE_NAME, initialContent);

        await initCommand(context.testDir.path);

        const gitignoreContent = await fs.readFile(path.join(context.testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        expect(gitignoreContent).toContain(initialContent);
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should not add entry to .gitignore if it already exists', async () => {
        const entry = `/${STATE_DIRECTORY_NAME}/`;
        const initialContent = `# Existing rules\n${entry}`;
        await createTestFile(context.testDir.path, GITIGNORE_FILE_NAME, initialContent);

        await initCommand(context.testDir.path);

        const gitignoreContent = await fs.readFile(path.join(context.testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        const occurrences = (gitignoreContent.match(new RegExp(entry, 'g')) || []).length;
        expect(occurrences).toBe(1);
    });

    it('should not overwrite an existing relaycode.config.json', async () => {
        const customConfig = { projectId: 'custom', customField: true };
        await createTestFile(context.testDir.path, CONFIG_FILE_NAME, JSON.stringify(customConfig));

        await initCommand(context.testDir.path);

        const configContent = await fs.readFile(path.join(context.testDir.path, CONFIG_FILE_NAME), 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe('custom');
        expect(config.customField).toBe(true);
    });

    it('should output the system prompt with the correct project ID', async () => {
        const capturedOutput: string[] = [];
        const originalLog = logger.log;
        (logger as any).log = (message: string) => capturedOutput.push(message);

        const pkgName = 'my-prompt-project';
        await createTestFile(context.testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        await initCommand(context.testDir.path);

        (logger as any).log = originalLog; // Restore

        const outputString = capturedOutput.join('\n');
        expect(outputString).toContain(`Project ID: ${pkgName}`);
    });

    it('should log an error if .gitignore is not writable', async () => {
        const gitignorePath = path.join(context.testDir.path, GITIGNORE_FILE_NAME);
        await createTestFile(context.testDir.path, GITIGNORE_FILE_NAME, '# initial');
        
        const capturedErrors: string[] = [];
        const originalError = logger.error;
        (logger as any).error = (message: string) => capturedErrors.push(message);

        try {
            await fs.chmod(gitignorePath, 0o444); // Read-only

            // initCommand doesn't throw, it just logs an error.
            await initCommand(context.testDir.path);

            const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
            expect(gitignoreContent).toBe('# initial'); // Should not have changed
            expect(capturedErrors.length).toBe(1);
            expect(capturedErrors[0]).toContain(`Failed to update ${GITIGNORE_FILE_NAME}`);
        } finally {
            // Restore logger
            (logger as any).error = originalError;
            
            // Make writable again for cleanup
            await fs.chmod(gitignorePath, 0o666);
        }
    });
});