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
import { getErrorMessage, logger } from '../utils/logger';

const CODE_BLOCK_REGEX = /```(?:\w+)?(?:\s*\/\/\s*(.*?)|\s+(.*?))?[\r\n]([\s\S]*?)[\r\n]```/g;

type ParsedHeader = {
    filePath: string;
    patchStrategy: PatchStrategy | null;
};

const extractCodeBetweenMarkers = (content: string): string => {
    const startMarkerIndex = content.indexOf(CODE_BLOCK_START_MARKER);
    const endMarkerIndex = content.lastIndexOf(CODE_BLOCK_END_MARKER);    
    
    let relevantContent = content;
    if (startMarkerIndex !== -1 && endMarkerIndex !== -1 && endMarkerIndex > startMarkerIndex) {
        relevantContent = content.substring(startMarkerIndex + CODE_BLOCK_START_MARKER.length, endMarkerIndex);
    }
    
    return relevantContent.trim().replace(/\r\n/g, '\n');
};

const parseCodeBlockHeader = (headerLine: string): ParsedHeader | null => {
    const quotedMatch = headerLine.match(/^"(.+?)"(?:\s+(.*))?$/);
    if (quotedMatch) {
        const filePath = quotedMatch[1]!;
        const strategyStr = (quotedMatch[2] || '').trim();
        if (strategyStr) {
            const parsedStrategy = PatchStrategySchema.safeParse(strategyStr);
            if (!parsedStrategy.success) {
                logger.debug(`Invalid patch strategy for quoted path: ${strategyStr}`);
                return null;
            }
            return { filePath, patchStrategy: parsedStrategy.data };
        }
        return { filePath, patchStrategy: null };
    }

    const parts = headerLine.split(/\s+/);
    if (parts.length === 1 && parts[0]) {
        return { filePath: parts[0], patchStrategy: null };
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
        const parsedStrategy = PatchStrategySchema.safeParse(parts[1]);
        if (parsedStrategy.success) {
            return { filePath: parts[0], patchStrategy: parsedStrategy.data };
        } else {
            logger.debug(`Treating entire header as file path since second word is not a valid strategy: "${headerLine}"`);
            return { filePath: headerLine, patchStrategy: null };
        }
    }

    if (parts.length > 2) {
        logger.debug(`Skipping unquoted header with more than 2 words: "${headerLine}"`);
        return null;
    }

    return null; // For empty or invalid header
};

const inferPatchStrategy = (content: string, providedStrategy: PatchStrategy | null): PatchStrategy => {
    if (providedStrategy) return providedStrategy;
    if (/^<<<<<<< SEARCH\s*$/m.test(content) && content.includes('>>>>>>> REPLACE')) return 'multi-search-replace';
    if (content.startsWith('--- ') && content.includes('+++ ') && content.includes('@@')) return 'new-unified';
    return 'replace';
};

const extractAndParseYaml = (rawText: string) => {
    // Strategy 1: Find all fenced YAML blocks and try to parse the last one.
    const yamlBlockMatches = [...rawText.matchAll(/```\s*(?:yaml|yml)[\r\n]([\s\S]+?)```/gi)];

    if (yamlBlockMatches.length > 0) {
        const lastMatch = yamlBlockMatches[yamlBlockMatches.length - 1]!;
        try {
            const yamlContent: unknown = yaml.load(lastMatch[1]!);
            const control = ControlYamlSchema.parse(yamlContent);
            // Success! This is our control block.
            const textWithoutYaml = rawText.substring(0, lastMatch.index) + rawText.substring(lastMatch.index! + lastMatch[0].length);
            return { control, textWithoutYaml: textWithoutYaml.trim() };
        } catch (e) {
            // The last block was not a valid control block.
            // We will now fall through to the non-fenced strategy, assuming the fenced block was just an example.
            logger.debug(`Last fenced YAML block was not a valid control block, trying non-fenced. Error: ${getErrorMessage(e)}`);
        }
    }

    // Strategy 2: Look for a non-fenced block at the end.
    const lines = rawText.trim().split('\n');
    let yamlStartIndex = -1;
    // Heuristic: project ID is required, so we look for that.
    const searchLimit = Math.max(0, lines.length - 20);
    for (let i = lines.length - 1; i >= searchLimit; i--) {
        if (lines[i]?.trim().match(/^projectId:/)) {
            yamlStartIndex = i;
            break;
        }
    }

    if (yamlStartIndex !== -1) {
        const yamlText = lines.slice(yamlStartIndex).join('\n');
        try {
            const yamlContent: unknown = yaml.load(yamlText);
            const control = ControlYamlSchema.parse(yamlContent);
            // Success!
            const textWithoutYaml = lines.slice(0, yamlStartIndex).join('\n');
            return { control, textWithoutYaml: textWithoutYaml.trim() };
        } catch (e) {
            logger.debug(`Non-fenced YAML block at the end was not a valid control block. Error: ${getErrorMessage(e)}`);
        }
    }
    
    // If both strategies fail, there's no valid control block.
    return { control: null, textWithoutYaml: rawText };
};

const parseCodeBlock = (match: RegExpExecArray): { operation: FileOperation, fullMatch: string } | null => {
    const [fullMatch, commentHeaderLine, spaceHeaderLine, rawContent] = match;
    const headerLine = (commentHeaderLine || spaceHeaderLine || '').trim();
    const content = (rawContent || '').trim();

    if (!headerLine) return null;

    if (headerLine === RENAME_FILE_OPERATION) {
        try {
            const { from, to } = z.object({ from: z.string().min(1), to: z.string().min(1) }).parse(JSON.parse(content));
            return { operation: { type: 'rename', from, to }, fullMatch };
        } catch (e) {
            logger.debug(`Invalid rename operation content: ${getErrorMessage(e)}`);
            return null;
        }
    }

    const parsedHeader = parseCodeBlockHeader(headerLine);
    if (!parsedHeader) {
        logger.debug(`Could not parse header: ${headerLine}`);
        return null;
    }

    const { filePath } = parsedHeader;

    if (content === DELETE_FILE_MARKER) {
        return { operation: { type: 'delete', path: filePath }, fullMatch };
    }

    const patchStrategy = inferPatchStrategy(content, parsedHeader.patchStrategy);
    const cleanContent = extractCodeBetweenMarkers(content);

    return {
        operation: { type: 'write', path: filePath, content: cleanContent, patchStrategy }, 
        fullMatch
    };
};

export const parseLLMResponse = (rawText: string): ParsedLLMResponse | null => {
    logger.debug('Parsing LLM response...');
    const { control, textWithoutYaml } = extractAndParseYaml(rawText);

    if (!control) {
        logger.debug('Could not parse control YAML from response.');
        return null;
    }

    const operations: FileOperation[] = [];
    const matchedBlocks: string[] = [];
    let match;

    while ((match = CODE_BLOCK_REGEX.exec(textWithoutYaml)) !== null) {
        const result = parseCodeBlock(match);
        if (result) {
            operations.push(result.operation);
            matchedBlocks.push(result.fullMatch);
        }
    }

    if (operations.length === 0) {
        logger.debug('No valid operations found in response.');
        return null;
    }

    let reasoningText = textWithoutYaml;
    for (const block of matchedBlocks) {
        reasoningText = reasoningText.replace(block, '');
    }
    const reasoning = reasoningText.split('\n').map(line => line.trim()).filter(Boolean);

    try {
        const parsedResponse = ParsedLLMResponseSchema.parse({ control, operations, reasoning });
        logger.debug('Successfully parsed LLM response.');
        return parsedResponse;
    } catch (e) {
        logger.debug(`Final validation failed: ${getErrorMessage(e)}`);
        return null;
    }
};