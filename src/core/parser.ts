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
    DELETE_FILE_MARKER,
    RENAME_FILE_OPERATION
} from '../utils/constants';
import { logger } from '../utils/logger';

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
        logger.debug('Parsing LLM response...');
        let yamlText: string | null = null;
        let textWithoutYaml: string = rawText;

        const yamlBlockMatch = rawText.match(YAML_BLOCK_REGEX);
        if (yamlBlockMatch && yamlBlockMatch[1]) {
            logger.debug('Found YAML code block.');
            yamlText = yamlBlockMatch[1];
            textWithoutYaml = rawText.replace(YAML_BLOCK_REGEX, '').trim();
        } else {
            logger.debug('No YAML code block found. Looking for raw YAML content at the end.');
            const lines = rawText.trim().split('\n');
            let yamlStartIndex = -1;
            // Search from the end, but not too far, maybe last 15 lines
            const searchLimit = Math.max(0, lines.length - 15);
            for (let i = lines.length - 1; i >= searchLimit; i--) {
                const trimmedLine = lines[i]?.trim();
                if (trimmedLine && trimmedLine.match(/^projectId:\s*['"]?[\w.-]+['"]?$/)) {
                    yamlStartIndex = i;
                    break;
                }
            }

            if (yamlStartIndex !== -1) {
                logger.debug(`Found raw YAML starting at line ${yamlStartIndex}.`);
                const yamlLines = lines.slice(yamlStartIndex);
                const textWithoutYamlLines = lines.slice(0, yamlStartIndex);
                yamlText = yamlLines.join('\n');
                textWithoutYaml = textWithoutYamlLines.join('\n').trim();
            }
        }
        
        logger.debug(`YAML content: ${yamlText ? 'Found' : 'Not found'}`);
        if (!yamlText) {
            logger.debug('No YAML content found');
            return null;
        }

        let control;
        try {
            const yamlContent = yaml.load(yamlText);
            logger.debug(`YAML content parsed: ${JSON.stringify(yamlContent)}`);
            control = ControlYamlSchema.parse(yamlContent);
            logger.debug(`Control schema parsed: ${JSON.stringify(control)}`);
        } catch (e) {
            logger.debug(`Error parsing YAML or control schema: ${e}`);
            return null;
        }
        
        const operations: FileOperation[] = [];
        const matchedBlocks: string[] = [];
        
        let match;
        logger.debug('Looking for code blocks...');
        let blockCount = 0;
        while ((match = CODE_BLOCK_REGEX.exec(textWithoutYaml)) !== null) {
            blockCount++;
            logger.debug(`Found code block #${blockCount}`);
            const [fullMatch, commentHeaderLine, spaceHeaderLine, rawContent] = match;

            // Get the header line from either the comment style or space style
            const headerLineUntrimmed = commentHeaderLine || spaceHeaderLine || '';
            
            if (typeof headerLineUntrimmed !== 'string' || typeof rawContent !== 'string') {
                logger.debug('Header line or raw content is not a string, skipping');
                continue;
            }

            const headerLine = headerLineUntrimmed.trim();
            const content = rawContent.trim();

            // Handle rename operation as a special case
            if (headerLine === RENAME_FILE_OPERATION) {
                logger.debug(`Found rename-file operation`);
                matchedBlocks.push(fullMatch);
                try {
                    const renameData = JSON.parse(content);
                    const RenameFileContentSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });
                    const renameOp = RenameFileContentSchema.parse(renameData);
                    operations.push({ type: 'rename', from: renameOp.from, to: renameOp.to });
                } catch (e) {
                    logger.debug(`Invalid rename operation content, skipping: ${e instanceof Error ? e.message : String(e)}`);
                }
                continue;
            }


            if (headerLine === '') {
                logger.debug('Empty header line, skipping');
                continue;
            }

            logger.debug(`Header line: ${headerLine}`);
            matchedBlocks.push(fullMatch);
            
            let filePath = '';
            let strategyProvided = false;
            let patchStrategy: PatchStrategy = 'replace'; // Default
            
            const quotedMatch = headerLine.match(/^"(.+?)"(?:\s+(.*))?$/);
            if (quotedMatch) {
                filePath = quotedMatch[1]!;
                const strategyStr = (quotedMatch[2] || '').trim();
                if (strategyStr) {
                    const parsedStrategy = PatchStrategySchema.safeParse(strategyStr);
                    if (!parsedStrategy.success) {
                        logger.debug('Invalid patch strategy for quoted path, skipping');
                        continue;
                    }
                    patchStrategy = parsedStrategy.data;
                    strategyProvided = true;
                }
            } else {
                const parts = headerLine.split(/\s+/);
                // For unquoted paths, we are strict:
                // - 1 word: it's a file path.
                // - 2 words: it must be `path strategy`.
                // - >2 words: it's a description and should be ignored.
                // This prevents misinterpreting descriptive text in the header as a file path.
                if (parts.length === 1) {
                    filePath = parts[0];
                } else if (parts.length === 2) {
                    const [pathPart, strategyPart] = parts;
                    const parsedStrategy = PatchStrategySchema.safeParse(strategyPart);
                    if (parsedStrategy.success) {
                        filePath = pathPart;
                        patchStrategy = parsedStrategy.data;
                        strategyProvided = true;
                    } else {
                        logger.debug(`Skipping unquoted header with 2 words where the second is not a strategy: "${headerLine}"`);
                    }
                } else if (parts.length > 2) {
                    logger.debug(`Skipping unquoted header with more than 2 words: "${headerLine}"`);
                }
            }

            if (!strategyProvided) {
                // Check for multi-search-replace format with a more precise pattern
                // Looking for the exact pattern at the start of a line AND the ending marker
                if (/^<<<<<<< SEARCH\s*$/m.test(content) && content.includes('>>>>>>> REPLACE')) {
                    patchStrategy = 'multi-search-replace';
                    logger.debug('Inferred patch strategy: multi-search-replace');
                } 
                // Check for new-unified format with more precise pattern
                else if (content.startsWith('--- ') && content.includes('+++ ') && content.includes('@@')) {
                    patchStrategy = 'new-unified';
                    logger.debug('Inferred patch strategy: new-unified');
                }
                // If neither pattern is detected, keep the default 'replace' strategy
                else {
                    logger.debug('No specific patch format detected, using default replace strategy');
                }
            }

            logger.debug(`File path: ${filePath}`);
            logger.debug(`Patch strategy: ${patchStrategy}`);
            
            if (!filePath) {
                logger.debug('Empty file path, skipping');
                continue;
            }

            if (content === DELETE_FILE_MARKER) {
                logger.debug(`Adding delete operation for: ${filePath}`);
                operations.push({ type: 'delete', path: filePath });
            } else {
                const cleanContent = extractCodeBetweenMarkers(content);
                logger.debug(`Adding write operation for: ${filePath}`);
                operations.push({ 
                    type: 'write', 
                    path: filePath, 
                    content: cleanContent, 
                    patchStrategy 
                });
            }
        }
        
        logger.debug(`Found ${blockCount} code blocks, ${operations.length} operations`);
        
        let reasoningText = textWithoutYaml;
        for (const block of matchedBlocks) {
            reasoningText = reasoningText.replace(block, '');
        }
        const reasoning = reasoningText.split('\n').map(line => line.trim()).filter(Boolean);

        if (operations.length === 0) {
            logger.debug('No operations found, returning null');
            return null;
        }

        try {
            const parsedResponse = ParsedLLMResponseSchema.parse({
                control,
                operations,
                reasoning,
            });
            logger.debug('Successfully parsed LLM response');
            return parsedResponse;
        } catch (e) {
            logger.debug(`Error parsing final response schema: ${e}`);
            return null;
        }
    } catch (e) {
        if (e instanceof z.ZodError) {
            logger.debug(`ZodError: ${JSON.stringify(e.errors)}`);
        } else {
            logger.debug(`Unexpected error: ${e}`);
        }
        return null;
    }
};