import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { processPatch } from '../../src/core/transaction';
import { parseLLMResponse } from '../../src/core/parser';
import { setupTestDirectory, TestDir, createTestConfig, createTestFile, LLM_RESPONSE_END, createFileBlock } from '../test.util';

// NOTE: This test file uses the actual 'diff-apply' dependency, not a mock.

describe('e2e/patcher', () => {
    let testDir: TestDir;

    beforeEach(async () => {
        testDir = await setupTestDirectory();
        // Suppress console output for cleaner test logs
        global.console.info = () => {};
        global.console.log = () => {};
        global.console.warn = () => {};
        global.console.error = () => {};
        //@ts-ignore
        global.console.success = () => {};
    });

    afterEach(async () => {
        await testDir.cleanup();
    });

    it('should correctly apply a patch using the multi-search-replace strategy', async () => {
        const config = await createTestConfig(testDir.path);
        const testFile = 'src/config.js';
        const originalContent = `
const config = {
    port: 3000,
    host: 'localhost',
    enableLogging: true,
};
`;
        await createTestFile(testDir.path, testFile, originalContent);

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
        
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'multi-search-replace') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(llmResponse);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        
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
        const config = await createTestConfig(testDir.path);
        const testFile = 'src/utils.js';
        const originalContent = `function calculate() {
    const a = 1;
    const b = 2;
    return a + b;
}`;
        await createTestFile(testDir.path, testFile, originalContent);

        const diffContent = `--- a/${testFile}
+++ b/${testFile}
@@ -2,4 +2,5 @@
     const a = 1;
     const b = 2;
-    return a + b;
+    // A more complex calculation
+    return (a + b) * 2;
 }`;
        
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'new-unified') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(llmResponse);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: testDir.path });

        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        
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
        const config = await createTestConfig(testDir.path);
        const testFile = 'src/index.js';
        const originalContent = 'const version = 1;';
        await createTestFile(testDir.path, testFile, originalContent);

        const diffContent = `
<<<<<<< SEARCH
-------
const version = 2; // This content does not exist
=======
const version = 3;
>>>>>>> REPLACE
`;
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'multi-search-replace') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(llmResponse)!;

        await processPatch(config, parsedResponse, { cwd: testDir.path });

        // The file content should remain unchanged
        const finalContent = await fs.readFile(path.join(testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(testDir.path, '.relaycode', `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });
});