This file is a merged representation of a subset of the codebase, containing files not matching ignore patterns, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of the entire repository's contents.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
4. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching these patterns are excluded: .cursor, docs, node_modules, .gitignore, .repomixignore, bun.lock, README.md, repomix.config.json, tsconfig.tsbuildinfo, REQUIREMENT.md
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

## Additional Info

# Directory Structure
```
package.json
src/commands/init.ts
src/commands/watch.ts
src/core/clipboard.ts
src/core/config.ts
src/core/executor.ts
src/core/parser.ts
src/core/state.ts
src/core/transaction.ts
src/index.ts
src/types.ts
src/utils/constants.ts
src/utils/logger.ts
src/utils/prompt.ts
src/utils/shell.ts
tsconfig.json
```

# Files

## File: src/commands/init.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { findConfig, createConfig, ensureStateDirExists, getProjectId } from '../core/config';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../utils/constants';

const getSystemPrompt = (projectId: string): string => `
✅ relaycode has been initialized for this project.

IMPORTANT: For relaycode to work, you must configure your AI assistant.
Copy the entire text below and paste it into your LLM's "System Prompt"
or "Custom Instructions" section.
---------------------------------------------------------------------------

Code changes rules 1-6:

1. Make sure to isolate every file's code block with:
    \`\`\`typescript // {filePath}
    // START

    {content}

    // END
    \`\`\`

2. Only write new or affected files. Ignore unaffected files in the codebase.

3. Always write the FULL source code for each file. Do not use placeholders or comments like "... rest of the code".

4. Add your step-by-step reasoning in plain text before each code block as you progress.

5. If you need to delete a file, use this exact format:
    \`\`\`typescript // {filePath}
    //TODO: delete this file
    \`\`\`

6. ALWAYS add the following YAML block at the very end of your response. Use the exact projectId shown here. Generate a new random uuid for each response.

    \`\`\`yaml
    projectId: ${projectId}
    uuid: (generate a random uuid)
    changeSummary:
      - edit: src/main.ts
      - new: src/components/Button.tsx
      - delete: src/utils/old-helper.ts
      - .... (so on)
    \`\`\`
---------------------------------------------------------------------------
You are now ready to run 'relay watch' in your terminal.
`;

const updateGitignore = async (): Promise<void> => {
    const gitignorePath = path.join(process.cwd(), GITIGNORE_FILE_NAME);
    const entry = `\n# relaycode state\n/${STATE_DIRECTORY_NAME}/\n`;

    try {
        let content = await fs.readFile(gitignorePath, 'utf-8');
        if (!content.includes(STATE_DIRECTORY_NAME)) {
            content += entry;
            await fs.writeFile(gitignorePath, content);
            logger.info(`Updated ${GITIGNORE_FILE_NAME} to ignore ${STATE_DIRECTORY_NAME}/`);
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            await fs.writeFile(gitignorePath, entry.trim());
            logger.info(`Created ${GITIGNORE_FILE_NAME} and added ${STATE_DIRECTORY_NAME}/`);
        } else {
            logger.error(`Failed to update ${GITIGNORE_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};

export const initCommand = async (): Promise<void> => {
    logger.info('Initializing relaycode in this project...');

    const existingConfig = await findConfig();
    if (existingConfig) {
        logger.warn(`${CONFIG_FILE_NAME} already exists. Initialization skipped.`);
        return;
    }
    
    const projectId = await getProjectId();
    await createConfig(projectId);
    logger.success(`Created configuration file: ${CONFIG_FILE_NAME}`);
    
    await ensureStateDirExists();
    logger.success(`Created state directory: ${STATE_DIRECTORY_NAME}/`);

    await updateGitignore();

    logger.log(getSystemPrompt(projectId));
};
````

## File: src/commands/watch.ts
````typescript
import { findConfig } from '../core/config';
import { createClipboardWatcher } from '../core/clipboard';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME } from '../utils/constants';

export const watchCommand = async (): Promise<void> => {
  const config = await findConfig();

  if (!config) {
    logger.error(`Configuration file '${CONFIG_FILE_NAME}' not found.`);
    logger.info("Please run 'relay init' to create one.");
    process.exit(1);
  }
  
  logger.success('Configuration loaded. Starting relaycode watch...');

  const watcher = createClipboardWatcher(config.clipboardPollInterval, async (content) => {
    logger.info('New clipboard content detected. Attempting to parse...');
    const parsedResponse = parseLLMResponse(content);

    if (!parsedResponse) {
      logger.warn('Clipboard content is not a valid relaycode patch. Ignoring.');
      return;
    }
    
    logger.success('Valid patch format detected. Processing...');
    await processPatch(config, parsedResponse);
    logger.info('--------------------------------------------------');
    logger.info('Watching for next patch...');
  });

  watcher.start();
};
````

## File: src/core/clipboard.ts
````typescript
import clipboardy from 'clipboardy';
import { logger } from '../utils/logger';

type ClipboardCallback = (content: string) => void;

export const createClipboardWatcher = (pollInterval: number, callback: ClipboardCallback) => {
  let lastContent = '';

  const checkClipboard = async () => {
    try {
      const currentContent = await clipboardy.read();
      if (currentContent && currentContent !== lastContent) {
        lastContent = currentContent;
        callback(currentContent);
      }
    } catch (error) {
      // It's common for clipboard access to fail occasionally (e.g., on VM focus change)
      // So we log a warning but don't stop the watcher.
      logger.warn('Could not read from clipboard.');
    }
  };

  const start = () => {
    logger.info(`Watching clipboard every ${pollInterval}ms...`);
    // The setInterval itself will keep the process alive.
    setInterval(checkClipboard, pollInterval);
  };

  return { start };
};
````

## File: src/core/config.ts
````typescript
import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { Config, ConfigSchema } from '../types';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME } from '../utils/constants';

export const findConfig = async (): Promise<Config | null> => {
  const configPath = path.join(process.cwd(), CONFIG_FILE_NAME);
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

export const createConfig = async (projectId: string): Promise<Config> => {
    const config: Config = {
        projectId,
        clipboardPollInterval: 2000,
        approval: 'yes',
        approvalOnErrorCount: 0,
        linter: 'bun tsc --noEmit',
        preCommand: '',
        postCommand: '',
    };
    
    // Ensure the schema defaults are applied
    const validatedConfig = ConfigSchema.parse(config);

    const configPath = path.join(process.cwd(), CONFIG_FILE_NAME);
    await fs.writeFile(configPath, JSON.stringify(validatedConfig, null, 2));

    return validatedConfig;
};

export const ensureStateDirExists = async (): Promise<void> => {
    const stateDirPath = path.join(process.cwd(), STATE_DIRECTORY_NAME);
    await fs.mkdir(stateDirPath, { recursive: true });
};

export const getProjectId = async (): Promise<string> => {
    try {
        const pkgJsonPath = path.join(process.cwd(), 'package.json');
        const fileContent = await fs.readFile(pkgJsonPath, 'utf-8');
        const pkgJson = JSON.parse(fileContent);
        if (pkgJson.name && typeof pkgJson.name === 'string') {
            return pkgJson.name;
        }
    } catch (e) {
        // Ignore if package.json doesn't exist or is invalid
    }
    return path.basename(process.cwd());
};
````

## File: src/core/executor.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';

export const readFileContent = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(path.join(process.cwd(), filePath), 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw error;
  }
};

export const writeFileContent = async (filePath: string, content: string): Promise<void> => {
  const absolutePath = path.join(process.cwd(), filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');
};

export const deleteFile = async (filePath: string): Promise<void> => {
  try {
    await fs.unlink(path.join(process.cwd(), filePath));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // File already deleted, which is fine.
      return;
    }
    throw error;
  }
};

export const createSnapshot = async (filePaths: string[]): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = {};
  const uniquePaths = [...new Set(filePaths)];
  for (const filePath of uniquePaths) {
    snapshot[filePath] = await readFileContent(filePath);
  }
  return snapshot;
};

export const applyOperations = async (operations: FileOperation[]): Promise<void> => {
  for (const op of operations) {
    if (op.type === 'write') {
      await writeFileContent(op.path, op.content);
    } else if (op.type === 'delete') {
      await deleteFile(op.path);
    }
  }
};

export const restoreSnapshot = async (snapshot: FileSnapshot): Promise<void> => {
  for (const [filePath, content] of Object.entries(snapshot)) {
    if (content === null) {
      // File didn't exist before, so delete it.
      await deleteFile(filePath);
    } else {
      // File existed, so restore its content.
      await writeFileContent(filePath, content);
    }
  }
};
````

## File: src/core/parser.ts
````typescript
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
const YAML_BLOCK_REGEX = /```yaml\n([\s\S]+?)\n```$/;

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
````

## File: src/core/state.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { StateFile, StateFileSchema } from '../types';
import { STATE_DIRECTORY_NAME } from '../utils/constants';

const getStateFilePath = (uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}.pending.yml` : `${uuid}.yml`;
  return path.join(process.cwd(), STATE_DIRECTORY_NAME, fileName);
};

export const hasBeenProcessed = async (uuid: string): Promise<boolean> => {
  const pendingPath = getStateFilePath(uuid, true);
  const committedPath = getStateFilePath(uuid, false);
  try {
    await fs.access(pendingPath);
    return true;
  } catch (e) {
    // pending doesn't exist, check committed
  }
  try {
    await fs.access(committedPath);
    return true;
  } catch (e) {
    return false;
  }
};

export const writePendingState = async (state: StateFile): Promise<void> => {
  const validatedState = StateFileSchema.parse(state);
  const yamlString = yaml.dump(validatedState);
  const filePath = getStateFilePath(state.uuid, true);
  await fs.writeFile(filePath, yamlString, 'utf-8');
};

export const commitState = async (uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(uuid, true);
  const committedPath = getStateFilePath(uuid, false);
  await fs.rename(pendingPath, committedPath);
};

export const deletePendingState = async (uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(uuid, true);
  try {
    await fs.unlink(pendingPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Already gone, that's fine.
      return;
    }
    throw error;
  }
};
````

## File: src/core/transaction.ts
````typescript
import { Config, ParsedLLMResponse, StateFile } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, applyOperations, restoreSnapshot } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';

type TransactionDependencies = {
  config: Config;
  parsedResponse: ParsedLLMResponse;
};

// This HOF encapsulates the logic for processing a single patch.
const createTransaction = (deps: TransactionDependencies) => {
  const { config, parsedResponse } = deps;
  const { control, operations, reasoning } = parsedResponse;
  const { uuid, projectId } = control;

  const affectedFilePaths = operations.map(op => op.path);

  const validate = async (): Promise<boolean> => {
    if (projectId !== config.projectId) {
      logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
      return false;
    }
    if (await hasBeenProcessed(uuid)) {
      // This is not a warning because it's expected if you copy the same response twice.
      logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
      return false;
    }
    return true;
  };
  
  const execute = async (): Promise<void> => {
    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);
    
    // --- Staging Phase ---
    logger.log('  - Taking snapshot of affected files...');
    const snapshot = await createSnapshot(affectedFilePaths);
    
    if(config.preCommand) {
      logger.log(`  - Running pre-command: ${config.preCommand}`);
      await executeShellCommand(config.preCommand);
    }
    
    await getErrorCount(config.linter); // Run initial check, primarily for logging.

    const stateFile: StateFile = {
      uuid,
      projectId,
      createdAt: new Date().toISOString(),
      reasoning,
      operations,
      snapshot,
      approved: false,
    };
    await writePendingState(stateFile);
    logger.success('  - Staged changes to .pending.yml file.');

    // --- Execution Phase ---
    logger.log('  - Applying file operations...');
    await applyOperations(operations);
    logger.success('  - File operations applied.');

    // --- Verification & Decision Phase ---
    if(config.postCommand) {
      logger.log(`  - Running post-command: ${config.postCommand}`);
      await executeShellCommand(config.postCommand);
    }
    const finalErrorCount = await getErrorCount(config.linter);
    logger.log(`  - Final linter error count: ${finalErrorCount}`);

    let isApproved = false;
    const canAutoApprove = config.approval === 'yes' && finalErrorCount <= config.approvalOnErrorCount;

    if (canAutoApprove) {
        isApproved = true;
        logger.success('  - Changes automatically approved based on your configuration.');
    } else {
        isApproved = await getConfirmation('Changes applied. Do you want to approve and commit them? (y/N)');
    }
    
    // --- Commit/Rollback Phase ---
    if (isApproved) {
        logger.log('  - Committing changes...');
        const finalState: StateFile = { ...stateFile, approved: true };
        await writePendingState(finalState); 
        await commitState(uuid);
        logger.success(`✅ Transaction ${uuid} committed successfully!`);
    } else {
        logger.warn('  - Rolling back changes...');
        await restoreSnapshot(snapshot);
        await deletePendingState(uuid);
        logger.success(`↩️ Transaction ${uuid} rolled back.`);
    }
  };

  return {
    run: async () => {
      if (!(await validate())) return;

      try {
        await execute();
      } catch (error) {
        logger.error(`Transaction ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
        logger.warn('Attempting to roll back from snapshot...');
        const snapshot = await createSnapshot(affectedFilePaths); // Re-create snapshot just in case it failed before writing
        await restoreSnapshot(snapshot);
        await deletePendingState(uuid);
        logger.success('Rollback attempted.');
      }
    },
  };
};

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse): Promise<void> => {
    const transaction = createTransaction({ config, parsedResponse });
    await transaction.run();
};
````

## File: src/index.ts
````typescript
#!/usr/bin/env bun
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { watchCommand } from './commands/watch';

const program = new Command();

program
  .name('relay')
  .description('A developer assistant that automates applying code changes from LLMs.');

program
  .command('init')
  .description('Initializes relaycode in the current project.')
  .action(initCommand);

program
  .command('watch')
  .description('Starts watching the clipboard for code changes to apply.')
  .action(watchCommand);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}
````

## File: src/types.ts
````typescript
import { z } from 'zod';

// Schema for relaycode.config.json
export const ConfigSchema = z.object({
  projectId: z.string().min(1),
  clipboardPollInterval: z.number().int().positive().default(2000),
  approval: z.enum(['yes', 'no']).default('yes'),
  approvalOnErrorCount: z.number().int().min(0).default(0),
  linter: z.string().default('bun tsc --noEmit'),
  preCommand: z.string().default(''),
  postCommand: z.string().default(''),
});
export type Config = z.infer<typeof ConfigSchema>;

// Schema for operations parsed from code blocks
export const FileOperationSchema = z.union([
  z.object({
    type: z.literal('write'),
    path: z.string(),
    content: z.string(),
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
````

## File: src/utils/constants.ts
````typescript
export const CONFIG_FILE_NAME = 'relaycode.config.json';
export const STATE_DIRECTORY_NAME = '.relaycode';
export const GITIGNORE_FILE_NAME = '.gitignore';

export const CODE_BLOCK_START_MARKER = '// START';
export const CODE_BLOCK_END_MARKER = '// END';
export const DELETE_FILE_MARKER = '//TODO: delete this file';
````

## File: src/utils/logger.ts
````typescript
import chalk from 'chalk';

export const logger = {
  info: (message: string) => console.log(chalk.blue(message)),
  success: (message: string) => console.log(chalk.green(message)),
  warn: (message: string) => console.log(chalk.yellow(message)),
  error: (message: string) => console.log(chalk.red(message)),
  log: (message: string) => console.log(message),
  prompt: (message: string) => console.log(chalk.cyan(message)),
};
````

## File: src/utils/prompt.ts
````typescript
import { logger } from './logger';

export const getConfirmation = (question: string): Promise<boolean> => {
  return new Promise(resolve => {
    logger.prompt(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const onData = (text: string) => {
      const cleanedText = text.trim().toLowerCase();
      if (cleanedText === 'y' || cleanedText === 'yes') {
        resolve(true);
      } else {
        resolve(false);
      }
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    process.stdin.on('data', onData);
  });
};
````

## File: src/utils/shell.ts
````typescript
import { ShellCommandResult } from '../types';

export const executeShellCommand = async (command: string): Promise<ShellCommandResult> => {
  if (!command) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  
  const parts = command.split(' ');
  const proc = Bun.spawn(parts, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exitCode,
  ]);
  
  return { stdout, stderr, exitCode };
};

export const getErrorCount = async (linterCommand: string): Promise<number> => {
    if (!linterCommand) return 0;
    try {
        const { stderr, stdout } = await executeShellCommand(linterCommand);
        // A simple way to count errors. This could be made more sophisticated.
        // For `tsc --noEmit`, errors are usually on stderr.
        const output = stderr || stdout;
        const errorLines = output.split('\n').filter(line => line.includes('error TS')).length;
        return errorLines;
    } catch (e) {
        // If the command itself fails to run, treat as a high number of errors.
        return 999;
    }
};
````

## File: package.json
````json
{
  "name": "relaycode",
  "version": "1.0.0",
  "description": "A developer assistant that automates applying code changes from LLMs.",
  "main": "src/index.ts",
  "bin": {
    "relay": "./src/index.ts"
  },
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun run --watch src/index.ts"
  },
  "dependencies": {
    "chalk": "^5.3.0",
    "clipboardy": "^4.0.0",
    "commander": "14.0.0",
    "js-yaml": "^4.1.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/js-yaml": "^4.0.9"
  },
  "module": "src/index.ts",
  "type": "module"
}
````

## File: tsconfig.json
````json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "lib": ["esnext"],
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "allowJs": true,
    "checkJs": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"]
}
````
