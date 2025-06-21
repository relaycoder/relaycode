import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { setupE2ETest, E2ETestContext, createTestFile, runProcessPatch } from '../test.util';

// NOTE: This test file uses the actual 'diff-apply' dependency, not a mock.

describe('e2e/patcher', () => {
    let context: E2ETestContext;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should correctly apply a patch using the multi-search-replace strategy', async () => {
        const testFile = 'src/config.js';
        const originalContent = `
const config = {
    port: 3000,
    host: 'localhost',
    enableLogging: true,
};
`;
        await createTestFile(context.testDir.path, testFile, originalContent);

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
        
        await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: diffContent, strategy: 'multi-search-replace' }],
            { responseOverrides: { reasoning: [] } } // Don't care about reasoning in this test
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        
        const expectedContent = `
const config = {
    port: 8080,
    host: 'localhost',
    enableLogging: false,
};
`;
        expect(finalContent.replace(/\s/g, '')).toBe(expectedContent.replace(/\s/g, ''));
    });

    it('should correctly apply a patch using the new-unified strategy', async () => {
        const testFile = 'src/utils.js';
        const originalContent = `function calculate() {
    const a = 1;
    const b = 2;
    return a + b;
}`;
        await createTestFile(context.testDir.path, testFile, originalContent);

        const diffContent = `--- a/${testFile}
+++ b/${testFile}
@@ -2,4 +2,5 @@
     const a = 1;
     const b = 2;
-    return a + b;
+    // A more complex calculation
+    return (a + b) * 2;
 }`;
        
        await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: diffContent, strategy: 'new-unified' }],
            { responseOverrides: { reasoning: [] } } // Don't care about reasoning
        );

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        
        const expectedContent = `function calculate() {
    const a = 1;
    const b = 2;
    // A more complex calculation
    return (a + b) * 2;
}`;
        // Normalize line endings for comparison
        expect(finalContent.replace(/\r\n/g, '\n')).toBe(expectedContent.replace(/\r\n/g, '\n'));
    });


    it('should fail transaction if multi-search-replace content is not found', async () => {
        const testFile = 'src/index.js';
        const originalContent = 'const version = 1;';
        await createTestFile(context.testDir.path, testFile, originalContent);

        const diffContent = `
<<<<<<< SEARCH
-------
const version = 2; // This content does not exist
=======
const version = 3;
>>>>>>> REPLACE
`;
        const { uuid } = await runProcessPatch(
            context,
            {},
            [{ type: 'edit', path: testFile, content: diffContent, strategy: 'multi-search-replace' }],
            { responseOverrides: { reasoning: [] } }
        );

        // The file content should remain unchanged
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, '.relaycode', `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });
});