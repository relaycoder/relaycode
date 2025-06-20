import { describe, it, expect } from 'bun:test';
import { parseLLMResponse } from '../../src/core/parser';
import { v4 as uuidv4 } from 'uuid';
import { LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock } from '../test.util';

describe('core/parser', () => {

    describe('parseLLMResponse', () => {
        const testUuid = uuidv4();

        it('should return null if YAML block is missing', () => {
            const response = `
\`\`\`typescript // {src/index.ts}
console.log("hello");
\`\`\`
            `;
            expect(parseLLMResponse(response)).toBeNull();
        });

        it('should return null if YAML is malformed', () => {
            const response = `
\`\`\`typescript // {src/index.ts}
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
\`\`\`typescript // {src/index.ts}
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
        
        it('should handle file paths with spaces', () => {
            const filePath = 'src/components/a file with spaces.tsx';
            const content = '<button>Click Me</button>';
            const response = createFileBlock(filePath, content) + LLM_RESPONSE_END(testUuid, [{ new: filePath }]);
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
\`\`\`typescript // {malformed-path.ts
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
\`\`\`typescript // {${filePath}}
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
    });
});