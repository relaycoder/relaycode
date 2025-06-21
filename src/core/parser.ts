import yaml from 'js-yaml';
import { z } from 'zod';
import {
    ControlYamlSchema,
    FileOperation,
    ParsedLLMResponse,
    ParsedLLMResponseSchema,
    PatchStrategy,
    PatchStrategySchema,
} from '../types';
import {
    CODE_BLOCK_START_MARKER,
    CODE_BLOCK_END_MARKER,
    DELETE_FILE_MARKER
} from '../utils/constants';

const CODE_BLOCK_REGEX = /```(?:\w+)?(?:\s*\/\/\s*(.*?)|\s+(.*?))?[\r\n]([\s\S]*?)[\r\n]```/g;
const YAML_BLOCK_REGEX = /```yaml[\r\n]([\s\S]+?)```/;

const extractCodeBetweenMarkers = (content: string): string => {
    const startMarkerIndex = content.indexOf(CODE_BLOCK_START_MARKER);
    const endMarkerIndex = content.lastIndexOf(CODE_BLOCK_END_MARKER);

    if (startMarkerIndex === -1 || endMarkerIndex === -1 || endMarkerIndex <= startMarkerIndex) {
        // Normalize line endings to Unix-style \n for consistency
        return content.trim().replace(/\r\n/g, '\n');
    }

    const startIndex = startMarkerIndex + CODE_BLOCK_START_MARKER.length;
    // Normalize line endings to Unix-style \n for consistency
    return content.substring(startIndex, endMarkerIndex).trim().replace(/\r\n/g, '\n');
};

export const parseLLMResponse = (rawText: string): ParsedLLMResponse | null => {
    try {
        console.log('Parsing LLM response...');
        const yamlMatch = rawText.match(YAML_BLOCK_REGEX);
        console.log('YAML match:', yamlMatch ? 'Found' : 'Not found');
        if (!yamlMatch || typeof yamlMatch[1] !== 'string') {
            console.log('No YAML block found or match[1] is not a string');
            return null;
        }

        let control;
        try {
            const yamlContent = yaml.load(yamlMatch[1]);
            console.log('YAML content parsed:', yamlContent);
            control = ControlYamlSchema.parse(yamlContent);
            console.log('Control schema parsed:', control);
        } catch (e) {
            console.log('Error parsing YAML or control schema:', e);
            return null;
        }

        const textWithoutYaml = rawText.replace(YAML_BLOCK_REGEX, '').trim();
        
        const operations: FileOperation[] = [];
        const matchedBlocks: string[] = [];
        
        let match;
        console.log('Looking for code blocks...');
        let blockCount = 0;
        while ((match = CODE_BLOCK_REGEX.exec(textWithoutYaml)) !== null) {
            blockCount++;
            console.log(`Found code block #${blockCount}`, match);
            const [fullMatch, commentHeaderLine, spaceHeaderLine, rawContent] = match;

            // Get the header line from either the comment style or space style
            const headerLineUntrimmed = commentHeaderLine || spaceHeaderLine || '';
            
            if (typeof headerLineUntrimmed !== 'string' || typeof rawContent !== 'string') {
                console.log('Header line or raw content is not a string, skipping');
                continue;
            }

            const headerLine = headerLineUntrimmed.trim();
            if (headerLine === '') {
                console.log('Empty header line, skipping');
                continue;
            }

            console.log('Header line:', headerLine);
            matchedBlocks.push(fullMatch);
            const content = rawContent.trim();
            
            let filePath = '';
            let patchStrategy: PatchStrategy;
            
            const quotedMatch = headerLine.match(/^"(.+?)"(?:\s+(.*))?$/);
            if (quotedMatch) {
                filePath = quotedMatch[1]!;
                const strategyStr = quotedMatch[2] || '';
                const parsedStrategy = PatchStrategySchema.safeParse(strategyStr || undefined);
                if (!parsedStrategy.success) {
                    console.log('Invalid patch strategy for quoted path, skipping');
                    continue;
                }
                patchStrategy = parsedStrategy.data;
            } else {
                const parts = headerLine.split(/\s+/);
                if (parts.length > 1) {
                    const strategyStr = parts.pop()!;
                    const parsedStrategy = PatchStrategySchema.safeParse(strategyStr);
                    if (!parsedStrategy.success) {
                        console.log('Invalid patch strategy, skipping');
                        continue;
                    }
                    patchStrategy = parsedStrategy.data;
                    filePath = parts.join(' ');
                } else {
                    filePath = headerLine;
                    patchStrategy = PatchStrategySchema.parse(undefined);
                }
            }

            console.log('File path:', filePath);
            console.log('Patch strategy:', patchStrategy);
            
            if (!filePath) {
                console.log('Empty file path, skipping');
                continue;
            }

            if (content === DELETE_FILE_MARKER) {
                console.log('Adding delete operation for:', filePath);
                operations.push({ type: 'delete', path: filePath });
            } else {
                const cleanContent = extractCodeBetweenMarkers(content);
                console.log('Adding write operation for:', filePath);
                operations.push({ 
                    type: 'write', 
                    path: filePath, 
                    content: cleanContent, 
                    patchStrategy 
                });
            }
        }
        
        console.log('Found', blockCount, 'code blocks,', operations.length, 'operations');
        
        let reasoningText = textWithoutYaml;
        for (const block of matchedBlocks) {
            reasoningText = reasoningText.replace(block, '');
        }
        const reasoning = reasoningText.split('\n').map(line => line.trim()).filter(Boolean);

        if (operations.length === 0) {
            console.log('No operations found, returning null');
            return null;
        }

        try {
            const parsedResponse = ParsedLLMResponseSchema.parse({
                control,
                operations,
                reasoning,
            });
            console.log('Successfully parsed LLM response');
            return parsedResponse;
        } catch (e) {
            console.log('Error parsing final response schema:', e);
            return null;
        }
    } catch (e) {
        if (e instanceof z.ZodError) {
            console.log('ZodError:', e.errors);
        } else {
            console.log('Unexpected error:', e);
        }
        return null;
    }
};