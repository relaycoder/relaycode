import { describe, it, expect } from 'bun:test';
import { parseLLMResponse } from '../../src/core/parser';
import { v4 as uuidv4 } from 'uuid';
import { LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock } from '../test.util';
import { promises as fs } from 'fs';
import path from 'path';

describe('core/parser', () => {

    describe('legacy tests', () => {
        const testUuid = uuidv4();

        it('should return null if YAML block is missing', () => {
            const response = `
\`\`\`typescript // src/index.ts
console.log("hello");
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if YAML is malformed', () => {
            const response = `
\`\`\`typescript // src/index.ts
console.log("hello");
\`\`\`
\`\`\`yaml
projectId: test-project
uuid: ${testUuid}
  malformed: - yaml
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if YAML is missing required fields', () => {
            const response = `
\`\`\`typescript // src/index.ts
console.log("hello");
\`\`\`
\`\`\`yaml
projectId: test-project
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if no code blocks are found', () => {
            const response = LLM_RESPONSE_START + LLM_RESPONSE_END(testUuid, []);
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should correctly parse a single file write operation with default "replace" strategy', () => {
            const content = 'const a = 1;';
            const filePath = 'src/utils.ts';
            const block = createFileBlock(filePath, content); // No strategy provided
            const response = LLM_RESPONSE_START + block + LLM_RESPONSE_END(testUuid, [{ edit: filePath }]);
            
            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe(testUuid);
            expect(parsed?.control.projectId).toBe('test-project');
            expect(parsed?.reasoning.join(' ')).toContain('I have analyzed your request and here are the changes.');
            expect(parsed?.operations).toHaveLength(1);
            expect(parsed?.operations[0]).toEqual({
                type: 'write',
                path: filePath,
                content: content,
                patchStrategy: 'replace',
            });
        });
        
        it('should correctly parse a write operation with an explicit patch strategy', () => {
            const content = 'diff content';
            const filePath = 'src/utils.ts';
            const block = createFileBlock(filePath, content, 'new-unified');
            const response = LLM_RESPONSE_START + block + LLM_RESPONSE_END(testUuid, [{ edit: filePath }]);

            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            const writeOp = parsed?.operations[0];
            expect(writeOp?.type).toBe('write');
            if (writeOp?.type === 'write') {
                expect(writeOp.patchStrategy).toBe('new-unified');
                expect(writeOp.content).toBe(content);
            }
        });

        it('should correctly parse a single file delete operation', () => {
            const filePath = 'src/old-file.ts';
            const block = createDeleteFileBlock(filePath);
            const response = "I'm deleting this old file." + block + LLM_RESPONSE_END(testUuid, [{ delete: filePath }]);

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            expect(parsed?.operations[0]).toEqual({
                type: 'delete',
                path: filePath,
            });
        });

        it('should correctly parse multiple mixed operations', () => {
            const filePath1 = 'src/main.ts';
            const content1 = 'console.log("main");';
            const filePath2 = 'src/to-delete.ts';
            const filePath3 = 'src/new-feature.ts';

            const response = [
                "I'll make three changes.",
                createFileBlock(filePath1, content1, 'replace'),
                "Then delete a file.",
                createDeleteFileBlock(filePath2),
                "And finally add a new one with a diff.",
                createFileBlock(filePath3, 'diff content', 'new-unified'),
                LLM_RESPONSE_END(testUuid, [{edit: filePath1}, {delete: filePath2}, {new: filePath3}])
            ].join('\n');

            const parsed = parseLLMResponse(response);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(3);
            expect(parsed?.operations).toContainEqual({ type: 'write', path: filePath1, content: content1, patchStrategy: 'replace' });
            expect(parsed?.operations).toContainEqual({ type: 'delete', path: filePath2 });
            expect(parsed?.operations).toContainEqual({ type: 'write', path: filePath3, content: 'diff content', patchStrategy: 'new-unified' });
            expect(parsed?.reasoning.join(' ')).toContain("I'll make three changes.");
        });
        
        it('should handle file paths with spaces when quoted', () => {
            const filePath = 'src/components/a file with spaces.tsx';
            const content = '<button>Click Me</button>';
            const block = `
\`\`\`typescript // "${filePath}"
// START

${content}

// END
\`\`\`
`;
            const response = block + LLM_RESPONSE_END(testUuid, [{ new: filePath }]);
            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            expect(parsed!.operations[0]!.path).toBe(filePath);
        });

        it('should handle empty content in a write operation', () => {
            const filePath = 'src/empty.ts';
            const response = createFileBlock(filePath, '') + LLM_RESPONSE_END(testUuid, [{ new: filePath }]);
            const parsed = parseLLMResponse(response);
            expect(parsed).not.toBeNull();
            expect(parsed!.operations).toHaveLength(1);
            const operation = parsed!.operations[0]!;
            expect(operation.type).toBe('write');
            if (operation.type === 'write') {
                expect(operation.content).toBe('');
            }
        });

        it('should ignore malformed code blocks', () => {
            const response = `
\`\`\`typescript //
const a = 1;
\`\`\`
${LLM_RESPONSE_END(testUuid, [])}
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should correctly extract content even if START/END markers are missing', () => {
            const filePath = 'src/simple.ts';
            const content = 'const simple = true;';
            const response = `
\`\`\`typescript // ${filePath}
${content}
\`\`\`
${LLM_RESPONSE_END(testUuid, [{edit: filePath}])}
            `;

            const parsed = parseLLMResponse(response);
            const operation = parsed?.operations.find(op => op.path === filePath);
            
            expect(parsed).not.toBeNull();
            expect(operation?.type).toBe('write');
            if(operation?.type === 'write') {
                expect(operation.content).toBe(content);
            }
        });

        it('should strip START and END markers from parsed content', () => {
            const filePath = 'src/markers.ts';
            const content = 'const content = "here";';
            
            // The helper adds the markers
            const block = createFileBlock(filePath, content);
            
            // Verify the block has the markers for sanity
            expect(block).toContain('// START');
            expect(block).toContain('// END');
        
            const response = LLM_RESPONSE_START + block + LLM_RESPONSE_END(testUuid, [{ edit: filePath }]);
        
            const parsed = parseLLMResponse(response);
            const operation = parsed?.operations[0];
        
            expect(parsed).not.toBeNull();
            expect(operation).not.toBeUndefined();
            expect(operation?.type).toBe('write');
            if (operation?.type === 'write') {
                expect(operation.content).toBe(content);
                expect(operation.content).not.toContain('// START');
                expect(operation.content).not.toContain('// END');
            }
        });

        it('should return null for an unknown patch strategy', () => {
            const filePath = 'src/index.ts';
            const content = 'console.log("hello");';
            const block = `
\`\`\`typescript // ${filePath} unknown-strategy
${content}
\`\`\`
            `;
            const response = block + LLM_RESPONSE_END(uuidv4(), [{ edit: filePath }]);
            expect(parseLLMResponse(response)).toBeNull();
        });
    });

    describe('from fixtures', () => {
        const fixturesDir = path.resolve(__dirname, '../fixtures');

        const readFixture = (name: string) => fs.readFile(path.join(fixturesDir, name), 'utf-8');

        it('should correctly parse multi-search-replace.md', async () => {
            const content = await readFixture('multi-search-replace.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.projectId).toBe('diff-apply');
            expect(parsed?.control.uuid).toBe('486a43f8-874e-4f16-832f-b2fd3769c36c');
            expect(parsed?.operations).toHaveLength(1);

            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('package.json');
                expect(op.patchStrategy).toBe('multi-search-replace');
                expect(op.content).toContain('<<<<<<< SEARCH');
                expect(op.content).toContain('>>>>>>> REPLACE');
                expect(op.content).toContain('"name": "diff-patcher"');
            }
            expect(parsed?.reasoning.join(' ')).toContain("I will update the `package.json` file");
        });

        it('should correctly parse replace-with-markers.md', async () => {
            const content = await readFixture('replace-with-markers.md');
            const parsed = parseLLMResponse(content);
            const expectedContent = `export const newFunction = () => {\n    console.log("new file");\n};`;
            
            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe('1c8a41a8-20d7-4663-856e-9ebd03f7a1e1');
            expect(parsed?.operations).toHaveLength(1);

            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/new.ts');
                expect(op.patchStrategy).toBe('replace');
                expect(op.content).toBe(expectedContent);
                expect(op.content).not.toContain('// START');
                expect(op.content).not.toContain('// END');
            }
        });

        it('should correctly parse replace-no-markers.md', async () => {
            const content = await readFixture('replace-no-markers.md');
            const parsed = parseLLMResponse(content);
            const expectedContent = `export const newFunction = () => {\n    console.log("new file");\n};`;

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/new.ts');
                expect(op.patchStrategy).toBe('replace');
                expect(op.content).toBe(expectedContent);
            }
        });

        it('should correctly parse new-unified.md', async () => {
            const content = await readFixture('new-unified.md');
            const parsed = parseLLMResponse(content);
            const expectedContent = `--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,3 +1,3 @@\n-export function greet(name: string) {\n-  return \`Hello, \${name}!\`;\n+export function greet(name: string, enthusiasm: number) {\n+  return \`Hello, \${name}\` + '!'.repeat(enthusiasm);\n }`;

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/utils.ts');
                expect(op.patchStrategy).toBe('new-unified');
                expect(op.content.trim()).toBe(expectedContent.trim());
            }
        });

        it('should correctly parse delete-file.md', async () => {
            const content = await readFixture('delete-file.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0];
            expect(op.type).toBe('delete');
            if (op.type === 'delete') {
                expect(op.path).toBe('src/old-helper.ts');
            }
            expect(parsed?.reasoning.join(' ')).toContain("I'm removing the old helper file.");
        });

        it('should correctly parse path-with-spaces.md', async () => {
            const content = await readFixture('path-with-spaces.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.operations).toHaveLength(1);
            const op = parsed!.operations[0];
            expect(op.type).toBe('write');
            if (op.type === 'write') {
                expect(op.path).toBe('src/components/My Component.tsx');
            }
        });
        
        it('should correctly parse multiple-ops.md', async () => {
            const content = await readFixture('multiple-ops.md');
            const parsed = parseLLMResponse(content);

            expect(parsed).not.toBeNull();
            expect(parsed?.control.uuid).toBe('5e1a41d8-64a7-4663-c56e-3ebd03f7a1f5');
            expect(parsed?.operations).toHaveLength(3);

            expect(parsed?.operations).toContainEqual({
                type: 'write',
                path: 'src/main.ts',
                content: 'console.log("Updated main");',
                patchStrategy: 'replace'
            });

            expect(parsed?.operations).toContainEqual({
                type: 'delete',
                path: 'src/utils.ts',
            });
            
            const newOp = parsed?.operations.find(op => op.path.includes('New Component'));
            expect(newOp).toBeDefined();
            expect(newOp?.type).toBe('write');
            if (newOp?.type === 'write') {
                expect(newOp.patchStrategy).toBe('new-unified');
                expect(newOp.path).toBe('src/components/New Component.tsx');
            }
        });
    });
});