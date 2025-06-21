I've implemented the logging levels as requested. Here are the code changes:

I've introduced a `logLevel` setting in your `relaycode.config.json` which can be set to `'silent'`, `'error'`, `'warn'`, `'info'`, or `'debug'`. The default is `'info'`. I've updated the logger to respect this setting and converted verbose logs (like those in the parser) to the `'debug'` level.

Here are the affected files:

```typescript // src/types.ts
import { z } from 'zod';

export const LogLevelNameSchema = z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info');
export type LogLevelName = z.infer<typeof LogLevelNameSchema>;

// Schema for relaycode.config.json
export const ConfigSchema = z.object({
  projectId: z.string().min(1),
  logLevel: LogLevelNameSchema,
  clipboardPollInterval: z.number().int().positive().default(2000),
  approval: z.enum(['yes', 'no']).default('yes'),
  approvalOnErrorCount: z.number().int().min(0).default(0),
  linter: z.string().default('bun tsc --noEmit'),
  preCommand: z.string().default(''),
  postCommand: z.string().default(''),
});
export type Config = z.infer<typeof ConfigSchema>;

export const PatchStrategySchema = z.enum([
  'replace',
  'new-unified',
  'multi-search-replace',
  'unified',
]).default('replace');
export type PatchStrategy = z.infer<typeof PatchStrategySchema>;

// Schema for operations parsed from code blocks
export const FileOperationSchema = z.union([
  z.object({
    type: z.literal('write'),
    path: z.string(),
    content: z.string(),
    patchStrategy: PatchStrategySchema,
  }),
  z.object({
    type: z.literal('delete'),
    path: z.string(),
  }),
]);
export type FileOperation = z.infer<typeof FileOperationSchema>;

// Schema for the control YAML block at the end of the LLM response
export const ControlYamlSchema = z.object({
  projectId: z.string(),
  uuid: z.string().uuid(),
  changeSummary: z.array(z.record(z.string())).optional(), // Not strictly used, but good to parse
});
export type ControlYaml = z.infer<typeof ControlYamlSchema>;

// The fully parsed response from the clipboard
export const ParsedLLMResponseSchema = z.object({
  control: ControlYamlSchema,
  operations: z.array(FileOperationSchema),
  reasoning: z.array(z.string()),
});
export type ParsedLLMResponse = z.infer<typeof ParsedLLMResponseSchema>;

// Schema for the snapshot of original files
export const FileSnapshotSchema = z.record(z.string(), z.string().nullable()); // path -> content | null (if file didn't exist)
export type FileSnapshot = z.infer<typeof FileSnapshotSchema>;

// Schema for the state file (.relaycode/{uuid}.yml or .pending.yml)
export const StateFileSchema = z.object({
  uuid: z.string().uuid(),
  projectId: z.string(),
  createdAt: z.string().datetime(),
  reasoning: z.array(z.string()),
  operations: z.array(FileOperationSchema),
  snapshot: FileSnapshotSchema,
  approved: z.boolean(),
});
export type StateFile = z.infer<typeof StateFileSchema>;

// Shell command execution result
export const ShellCommandResultSchema = z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().nullable(),
});
export type ShellCommandResult = z.infer<typeof ShellCommandResultSchema>;
```
```typescript // src/utils/logger.ts
import chalk from 'chalk';
import { LogLevelName } from '../types';

const LogLevels = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
} as const;

let currentLogLevel: LogLevelName = 'info'; // Default level

export const logger = {
  setLevel: (level: LogLevelName) => {
    if (level in LogLevels) {
      currentLogLevel = level;
    }
  },
  info: (message: string) => {
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(chalk.blue(message));
    }
  },
  success: (message: string) => {
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(chalk.green(message));
    }
  },
  warn: (message: string) => {
    if (LogLevels.warn <= LogLevels[currentLogLevel]) {
      console.log(chalk.yellow(message));
    }
  },
  error: (message: string) => {
    if (LogLevels.error <= LogLevels[currentLogLevel]) {
      console.log(chalk.red(message));
    }
  },
  debug: (message: string) => {
    if (LogLevels.debug <= LogLevels[currentLogLevel]) {
      console.log(chalk.gray(message));
    }
  },
  log: (message: string) => {
    // General log, treat as info
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(message);
    }
  },
  prompt: (message: string) => {
    // Prompts are special and should be shown unless silent
    if (currentLogLevel !== 'silent') {
      console.log(chalk.cyan(message));
    }
  },
};
```
```typescript // src/core/config.ts
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { Config, ConfigSchema } from '../types';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME } from '../utils/constants';

export const findConfig = async (cwd: string = process.cwd()): Promise<Config | null> => {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);
  try {
    const fileContent = await fs.readFile(configPath, 'utf-8');
    const configJson = JSON.parse(fileContent);
    return ConfigSchema.parse(configJson);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid configuration in ${CONFIG_FILE_NAME}: ${error.message}`);
    }
    throw error;
  }
};

export const createConfig = async (projectId: string, cwd: string = process.cwd()): Promise<Config> => {
    const config = {
        projectId,
        clipboardPollInterval: 2000,
        approval: 'yes' as const,
        approvalOnErrorCount: 0,
        linter: 'bun tsc --noEmit',
        preCommand: '',
        postCommand: '',
    };
    
    // Ensure the schema defaults are applied, including for logLevel
    const validatedConfig = ConfigSchema.parse(config);

    const configPath = path.join(cwd, CONFIG_FILE_NAME);
    await fs.writeFile(configPath, JSON.stringify(validatedConfig, null, 2));

    return validatedConfig;
};

export const ensureStateDirExists = async (cwd: string = process.cwd()): Promise<void> => {
    const stateDirPath = path.join(cwd, STATE_DIRECTORY_NAME);
    await fs.mkdir(stateDirPath, { recursive: true });
};

export const getProjectId = async (cwd: string = process.cwd()): Promise<string> => {
    try {
        const pkgJsonPath = path.join(cwd, 'package.json');
        const fileContent = await fs.readFile(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(fileContent);
        if (pkgJson.name && typeof pkgJson.name === 'string') {
            return pkgJson.name;
        }
    } catch (e) {
        // Ignore if package.json doesn't exist or is invalid
    }
    return path.basename(cwd);
};
```
```typescript // src/commands/watch.ts
import { findConfig } from '../core/config';
import { createClipboardWatcher } from '../core/clipboard';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME } from '../utils/constants';
import { notifyPatchDetected } from '../utils/notifier';

export const watchCommand = async (): Promise<void> => {
  const config = await findConfig();

  if (!config) {
    logger.error(`Configuration file '${CONFIG_FILE_NAME}' not found.`);
    logger.info("Please run 'relay init' to create one.");
    process.exit(1);
  }
  
  logger.setLevel(config.logLevel);
  logger.success('Configuration loaded. Starting relaycode watch...');
  logger.debug(`Log level set to: ${config.logLevel}`);

  createClipboardWatcher(config.clipboardPollInterval, async (content) => {
    logger.info('New clipboard content detected. Attempting to parse...');
    const parsedResponse = parseLLMResponse(content);

    if (!parsedResponse) {
      logger.warn('Clipboard content is not a valid relaycode patch. Ignoring.');
      return;
    }
    
    notifyPatchDetected(config.projectId);
    logger.success('Valid patch format detected. Processing...');
    await processPatch(config, parsedResponse);
    logger.info('--------------------------------------------------');
    logger.info('Watching for next patch...');
  });
};
```
```typescript // src/utils/shell.ts
import { exec } from 'child_process';
import path from 'path';
import { logger } from './logger';

type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const executeShellCommand = (command: string, cwd = process.cwd()): Promise<ExecutionResult> => {
  if (!command || command.trim() === '') {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  // Normalize path for Windows environments
  const normalizedCwd = path.resolve(cwd);

  return new Promise((resolve) => {
    // On Windows, make sure to use cmd.exe or PowerShell to execute command
    const isWindows = process.platform === 'win32';
    const finalCommand = isWindows 
      ? `powershell -Command "${command.replace(/"/g, '\\"')}"`
      : command;
      
    logger.debug(`Executing command: ${finalCommand} in directory: ${normalizedCwd}`);
    
    exec(finalCommand, { cwd: normalizedCwd }, (error, stdout, stderr) => {
      const exitCode = error ? error.code || 1 : 0;
      
      resolve({
        exitCode,
        stdout: stdout.toString().trim(),
        stderr: stderr.toString().trim(),
      });
    });
  });
};

export const getErrorCount = async (linterCommand: string, cwd = process.cwd()): Promise<number> => {
  if (!linterCommand || linterCommand.trim() === '') {
    return 0;
  }
  
  const { exitCode, stderr } = await executeShellCommand(linterCommand, cwd);
  if (exitCode === 0) return 0;

  // Try to extract a number of errors from stderr or assume 1 if non-zero exit code
  const errorMatches = stderr.match(/(\d+) error/i);
  if (errorMatches && errorMatches[1]) {
    return parseInt(errorMatches[1], 10);
  }
  return exitCode === 0 ? 0 : 1;
};
```
```typescript // src/core/parser.ts
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
        const yamlMatch = rawText.match(YAML_BLOCK_REGEX);
        logger.debug(`YAML match: ${yamlMatch ? 'Found' : 'Not found'}`);
        if (!yamlMatch || typeof yamlMatch[1] !== 'string') {
            logger.debug('No YAML block found or match[1] is not a string');
            return null;
        }

        let control;
        try {
            const yamlContent = yaml.load(yamlMatch[1]);
            logger.debug(`YAML content parsed: ${JSON.stringify(yamlContent)}`);
            control = ControlYamlSchema.parse(yamlContent);
            logger.debug(`Control schema parsed: ${JSON.stringify(control)}`);
        } catch (e) {
            logger.debug(`Error parsing YAML or control schema: ${e}`);
            return null;
        }

        const textWithoutYaml = rawText.replace(YAML_BLOCK_REGEX, '').trim();
        
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
            if (headerLine === '') {
                logger.debug('Empty header line, skipping');
                continue;
            }

            logger.debug(`Header line: ${headerLine}`);
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
                    logger.debug('Invalid patch strategy for quoted path, skipping');
                    continue;
                }
                patchStrategy = parsedStrategy.data;
            } else {
                const parts = headerLine.split(/\s+/);
                if (parts.length > 1) {
                    const strategyStr = parts.pop()!;
                    const parsedStrategy = PatchStrategySchema.safeParse(strategyStr);
                    if (!parsedStrategy.success) {
                        logger.debug('Invalid patch strategy, skipping');
                        continue;
                    }
                    patchStrategy = parsedStrategy.data;
                    filePath = parts.join(' ');
                } else {
                    filePath = headerLine;
                    patchStrategy = PatchStrategySchema.parse(undefined);
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
```