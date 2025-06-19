import yaml from 'js-yaml';
import { z } from 'zod';
import {
    ControlYamlSchema,
    FileOperation,
    ParsedLLMResponse,
    ParsedLLMResponseSchema,
} from '../types';
import {
    CODE_BLOCK_START_MARKER,
    CODE_BLOCK_END_MARKER,
    DELETE_FILE_MARKER
} from '../utils/constants';

const CODE_BLOCK_REGEX = /```(?:\w+)?\s*\/\/\s*{(.*?)}\n([\s\S]*?)\n```/g;
const YAML_BLOCK_REGEX = /```yaml\n([\s\S]+?)\n```\s*$/;

const extractCodeBetweenMarkers = (content: string): string => {
    const startMarkerIndex = content.indexOf(CODE_BLOCK_START_MARKER);
    const endMarkerIndex = content.lastIndexOf(CODE_BLOCK_END_MARKER);

    if (startMarkerIndex === -1 || endMarkerIndex === -1 || endMarkerIndex <= startMarkerIndex) {
        return content.trim();
    }

    const startIndex = startMarkerIndex + CODE_BLOCK_START_MARKER.length;
    return content.substring(startIndex, endMarkerIndex).trim();
};

export const parseLLMResponse = (rawText: string): ParsedLLMResponse | null => {
    const yamlMatch = rawText.match(YAML_BLOCK_REGEX);
    if (!yamlMatch || typeof yamlMatch[1] !== 'string') return null;

    let control;
    try {
        const yamlContent = yaml.load(yamlMatch[1]);
        control = ControlYamlSchema.parse(yamlContent);
    } catch (e) {
        // Invalid YAML or doesn't match schema
        return null;
    }

    const textWithoutYaml = rawText.replace(YAML_BLOCK_REGEX, '').trim();
    
    const operations: FileOperation[] = [];
    const matchedBlocks: string[] = [];
    
    let match;
    while ((match = CODE_BLOCK_REGEX.exec(textWithoutYaml)) !== null) {
        const [fullMatch, filePath, rawContent] = match;

        if (typeof filePath !== 'string' || typeof rawContent !== 'string') {
            continue;
        }

        matchedBlocks.push(fullMatch);
        const content = rawContent.trim();

        if (content === DELETE_FILE_MARKER) {
            operations.push({ type: 'delete', path: filePath.trim() });
        } else {
            const cleanContent = extractCodeBetweenMarkers(content);
            operations.push({ type: 'write', path: filePath.trim(), content: cleanContent });
        }
    }
    
    let reasoningText = textWithoutYaml;
    for (const block of matchedBlocks) {
        reasoningText = reasoningText.replace(block, '');
    }
    const reasoning = reasoningText.split('\n').map(line => line.trim()).filter(Boolean);

    if (operations.length === 0) return null;

    try {
        const parsedResponse = ParsedLLMResponseSchema.parse({
            control,
            operations,
            reasoning,
        });
        return parsedResponse;
    } catch (e) {
        if (e instanceof z.ZodError) {
            console.error("Zod validation failed on final parsed object:", e.errors);
        }
        return null;
    }
};