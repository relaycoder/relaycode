# Directory Structure
```
package.json
relaycode.config.json
src/cli.ts
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
src/utils/notifier.ts
src/utils/prompt.ts
src/utils/shell.ts
test/e2e/init.test.ts
test/e2e/patcher.test.ts
test/e2e/transaction.test.ts
test/e2e/watch.test.ts
test/test.util.ts
test/unit/parser.test.ts
tsconfig.json
```

# Files

## File: relaycode.config.json
````json
{"projectId":"custom","customField":true}
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

## File: src/utils/notifier.ts
````typescript
const notifier = require('toasted-notifier');

const appName = 'Relaycode';

// This is a "fire-and-forget" utility. If notifications fail for any reason
// (e.g., unsupported OS, DND mode, permissions), it should not crash the app.
const sendNotification = (options: { title: string; message: string; }) => {
    try {
        notifier.notify(
            {
                title: options.title,
                message: options.message,
                sound: false, // Keep it quiet by default
                wait: false,
            },
            (err: any) => {
                if (err) {
                    // Silently ignore errors. This is a non-critical feature.
                }
            }
        );
    } catch (err) {
        // Silently ignore errors.
    }
};

export const notifyPatchDetected = (projectId: string) => {
    sendNotification({
        title: appName,
        message: `New patch detected for project \`${projectId}\`.`,
    });
};

export const notifyApprovalRequired = (projectId: string) => {
    sendNotification({
        title: appName,
        message: `Action required to approve changes for \`${projectId}\`.`,
    });
};

export const notifySuccess = (uuid: string) => {
    sendNotification({
        title: appName,
        message: `Patch \`${uuid}\` applied successfully.`,
    });
};

export const notifyFailure = (uuid: string) => {
    sendNotification({
        title: appName,
        message: `Patch \`${uuid}\` failed and was rolled back.`,
    });
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

## File: src/cli.ts
````typescript
#!/usr/bin/env node
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
  .action(() => initCommand());

program
  .command('watch')
  .description('Starts watching the clipboard for code changes to apply.')
  .action(watchCommand);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}
````

## File: src/core/config.ts
````typescript
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
````

## File: src/index.ts
````typescript
// Core logic
export { createClipboardWatcher } from './core/clipboard';
export { findConfig, createConfig, getProjectId, ensureStateDirExists } from './core/config';
export { 
    applyOperations, 
    createSnapshot, 
    deleteFile, 
    readFileContent, 
    restoreSnapshot, 
    writeFileContent 
} from './core/executor';
export { parseLLMResponse } from './core/parser';
export { 
    commitState,
    deletePendingState,
    hasBeenProcessed,
    writePendingState
} from './core/state';
export { processPatch } from './core/transaction';

// Types
export * from './types';

// Utils
export { executeShellCommand, getErrorCount } from './utils/shell';
export { logger } from './utils/logger';
export { getConfirmation } from './utils/prompt';
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
````

## File: src/commands/watch.ts
````typescript
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
  
  logger.success('Configuration loaded. Starting relaycode watch...');

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
````

## File: src/utils/shell.ts
````typescript
import { exec } from 'child_process';
import path from 'path';

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
      
    console.log(`Executing command: ${finalCommand} in directory: ${normalizedCwd}`);
    
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
````

## File: test/e2e/watch.test.ts
````typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createClipboardWatcher } from '../../src/core/clipboard';
import { parseLLMResponse } from '../../src/core/parser';
import { processPatch } from '../../src/core/transaction';
import { findConfig } from '../../src/core/config';
import { setupE2ETest, E2ETestContext, createTestConfig, createTestFile, createFileBlock, LLM_RESPONSE_END, LLM_RESPONSE_START } from '../test.util';

describe('e2e/watch', () => {
    let context: E2ETestContext;
    let watcher: { stop: () => void } | null = null;

    beforeEach(async () => {
        context = await setupE2ETest();
    });

    afterEach(async () => {
        if (watcher) {
            watcher.stop();
            watcher = null;
        }
        if (context) {
            await context.cleanup();
        }
    });

    it('should ignore invalid patch and process subsequent valid patch', async () => {
        const pollInterval = 50;
        await createTestConfig(context.testDir.path, { clipboardPollInterval: pollInterval });
        const testFile = 'src/index.ts';
        const originalContent = 'console.log("original");';
        await createTestFile(context.testDir.path, testFile, originalContent);
    
        let fakeClipboardContent = 'this is not a valid patch, just some random text.';
        const clipboardReader = async () => fakeClipboardContent;
    
        const onClipboardChange = async (content: string) => {
            const currentConfig = await findConfig(context.testDir.path);
            const parsedResponse = parseLLMResponse(content);
            if (!currentConfig || !parsedResponse) {
                return;
            }
            await processPatch(currentConfig, parsedResponse, { cwd: context.testDir.path });
        };
    
        watcher = createClipboardWatcher(pollInterval, onClipboardChange, clipboardReader);
    
        // Wait for a couple of poll cycles to ensure the invalid patch is read and ignored
        await new Promise(resolve => setTimeout(resolve, pollInterval * 3));
    
        const contentAfterInvalid = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterInvalid).toBe(originalContent);
    
        // Now, provide a valid patch
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        const validPatch = LLM_RESPONSE_START + 
                           createFileBlock(testFile, newContent) + 
                           LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        fakeClipboardContent = validPatch;

        // Wait for polling to pick up the new content. 
        // We also need to account for file system operations.
        await new Promise(resolve => setTimeout(resolve, pollInterval * 5));
    
        const contentAfterValid = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(contentAfterValid).toBe(newContent);
    });
});
````

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

You are an expert AI programmer. To modify a file, you MUST use a code block with a specified patch strategy.

**Syntax:**
\`\`\`typescript // filePath {patchStrategy}
... content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- \`patchStrategy\`: (Optional) One of \`new-unified\`, \`multi-search-replace\`. If omitted, the entire file is replaced (this is the \`replace\` strategy).

**Examples:**
\`\`\`typescript // src/components/Button.tsx
...
\`\`\`
\`\`\`typescript // "src/components/My Component.tsx" new-unified
...
\`\`\`

---

### Strategy 1: Advanced Unified Diff (\`new-unified\`) - RECOMMENDED

Use for most changes, like refactoring, adding features, and fixing bugs. It's resilient to minor changes in the source file.

**Diff Format:**
1.  **File Headers**: Start with \`--- {filePath}\` and \`+++ {filePath}\`.
2.  **Hunk Header**: Use \`@@ ... @@\`. Exact line numbers are not needed.
3.  **Context Lines**: Include 2-3 unchanged lines before and after your change for context.
4.  **Changes**: Mark additions with \`+\` and removals with \`-\`. Maintain indentation.

**Example:**
\`\`\`diff
--- src/utils.ts
+++ src/utils.ts
@@ ... @@
    function calculateTotal(items: number[]): number {
-      return items.reduce((sum, item) => {
-        return sum + item;
-      }, 0);
+      const total = items.reduce((sum, item) => {
+        return sum + item * 1.1;  // Add 10% markup
+      }, 0);
+      return Math.round(total * 100) / 100;  // Round to 2 decimal places
+    }
\`\`\`

---

### Strategy 2: Multi-Search-Replace (\`multi-search-replace\`)

Use for precise, surgical replacements. The \`SEARCH\` block must be an exact match of the content in the file.

**Diff Format:**
Repeat this block for each replacement.
\`\`\`diff
<<<<<<< SEARCH
:start_line: (optional)
:end_line: (optional)
-------
[exact content to find including whitespace]
=======
[new content to replace with]
>>>>>>> REPLACE
\`\`\`

---

### Other Operations

-   **Creating a file**: Use the default \`replace\` strategy (omit the strategy name) and provide the full file content.
-   **Deleting a file**:
    \`\`\`typescript // path/to/file.ts
    //TODO: delete this file
    \`\`\`
    \`\`\`typescript // "path/to/My Old Component.ts"
    //TODO: delete this file
    \`\`\`

---

### Final Steps

1.  Add your step-by-step reasoning in plain text before each code block.
2.  ALWAYS add the following YAML block at the very end of your response. Use the exact projectId shown here. Generate a new random uuid for each response.

    \`\`\`yaml
    projectId: ${projectId}
    uuid: (generate a random uuid)
    changeSummary:
      - edit: src/main.ts
      - new: src/components/Button.tsx
      - delete: src/utils/old-helper.ts
    \`\`\`
---------------------------------------------------------------------------
You are now ready to run 'relay watch' in your terminal.
`;

const updateGitignore = async (cwd: string): Promise<void> => {
    const gitignorePath = path.join(cwd, GITIGNORE_FILE_NAME);
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

export const initCommand = async (cwd: string = process.cwd()): Promise<void> => {
    logger.info('Initializing relaycode in this project...');

    const config = await findConfig(cwd);
    if (config) {
        logger.warn(`${CONFIG_FILE_NAME} already exists. Initialization skipped.`);
        logger.log(getSystemPrompt(config.projectId));
        return;
    }
    
    const projectId = await getProjectId(cwd);
    await createConfig(projectId, cwd);
    logger.success(`Created configuration file: ${CONFIG_FILE_NAME}`);
    
    await ensureStateDirExists(cwd);
    logger.success(`Created state directory: ${STATE_DIRECTORY_NAME}/`);

    await updateGitignore(cwd);

    logger.log(getSystemPrompt(projectId));
};
````

## File: src/core/clipboard.ts
````typescript
import clipboardy from 'clipboardy';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

type ClipboardCallback = (content: string) => void;
type ClipboardReader = () => Promise<string>;


// Direct Windows clipboard reader that uses the executable directly
const createDirectWindowsClipboardReader = (): ClipboardReader => {
  return async () => {
    try {
      const localExePath = path.join(process.cwd(), 'fallbacks', 'windows', 'clipboard_x86_64.exe');
      if (fs.existsSync(localExePath)) {
        const result = execSync(`"${localExePath}" --paste`, { encoding: 'utf8' });
        return result;
      }
      throw new Error('Windows clipboard executable not found');
    } catch (error) {
      throw new Error(`Clipboard read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
};

// Check if the clipboard executable exists and fix path issues on Windows
const ensureClipboardExecutable = () => {
  if (process.platform === 'win32') {
    try {
      // Try to find clipboard executables in common locations
      const possiblePaths = [
        // Global installation path
        path.join(process.env.HOME || '', '.bun', 'install', 'global', 'node_modules', 'relaycode', 'fallbacks', 'windows'),
        // Local installation paths
        path.join(process.cwd(), 'node_modules', 'clipboardy', 'fallbacks', 'windows'),
        path.join(process.cwd(), 'fallbacks', 'windows')
      ];
      
      // Create fallbacks directory in the current project if it doesn't exist
      const localFallbacksDir = path.join(process.cwd(), 'fallbacks', 'windows');
      if (!fs.existsSync(localFallbacksDir)) {
        fs.mkdirSync(localFallbacksDir, { recursive: true });
      }
      
      // Find an existing executable
      let sourceExePath = null;
      for (const dir of possiblePaths) {
        const exePath = path.join(dir, 'clipboard_x86_64.exe');
        if (fs.existsSync(exePath)) {
          sourceExePath = exePath;
          break;
        }
      }
      
      // Copy the executable to the local fallbacks directory if found
      if (sourceExePath && sourceExePath !== path.join(localFallbacksDir, 'clipboard_x86_64.exe')) {
        fs.copyFileSync(sourceExePath, path.join(localFallbacksDir, 'clipboard_x86_64.exe'));
        logger.info('Copied Windows clipboard executable to local fallbacks directory');
      } else if (!sourceExePath) {
        logger.error('Windows clipboard executable not found in any location');
      }
    } catch (error) {
      logger.warn('Error ensuring clipboard executable: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
};

export const createClipboardWatcher = (
  pollInterval: number,
  callback: ClipboardCallback,
  reader?: ClipboardReader,
) => {
  // Ensure clipboard executable exists before starting
  ensureClipboardExecutable();
  
  // On Windows, use the direct Windows reader
  // Otherwise use the provided reader or clipboardy
  const clipboardReader = process.platform === 'win32' ? 
    createDirectWindowsClipboardReader() : 
    reader || clipboardy.read;
  
  let lastContent = '';
  let intervalId: NodeJS.Timeout | null = null;

  const checkClipboard = async () => {
    try {
      const content = await clipboardReader();
      if (content && content !== lastContent) {
        lastContent = content;
        callback(content);
      }
    } catch (error) {
      // It's common for clipboard access to fail occasionally (e.g., on VM focus change)
      // So we log a warning but don't stop the watcher.
      logger.warn('Could not read from clipboard: ' + (error instanceof Error ? error.message : String(error)));
    }
  };

  const start = () => {
    if (intervalId) {
      return;
    }
    logger.info(`Starting clipboard watcher (polling every ${pollInterval}ms)`);
    // Immediately check once, then start the interval
    checkClipboard();
    intervalId = setInterval(checkClipboard, pollInterval);
  };

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      logger.info('Clipboard watcher stopped.');
    }
  };

  start();
  
  return { stop };
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
    PatchStrategy,
    PatchStrategySchema,
} from '../types';
import {
    CODE_BLOCK_START_MARKER,
    CODE_BLOCK_END_MARKER,
    DELETE_FILE_MARKER
} from '../utils/constants';

const CODE_BLOCK_REGEX = /```(?:\w+)?\s*\/\/\s*(.*?)\n([\s\S]*?)\n```/g;
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
    try {
        const yamlMatch = rawText.match(YAML_BLOCK_REGEX);
        if (!yamlMatch || typeof yamlMatch[1] !== 'string') return null;

        let control;
        try {
            const yamlContent = yaml.load(yamlMatch[1]);
            control = ControlYamlSchema.parse(yamlContent);
        } catch (e) {
            return null;
        }

        const textWithoutYaml = rawText.replace(YAML_BLOCK_REGEX, '').trim();
        
        const operations: FileOperation[] = [];
        const matchedBlocks: string[] = [];
        
        let match;
        while ((match = CODE_BLOCK_REGEX.exec(textWithoutYaml)) !== null) {
            const [fullMatch, headerLineUntrimmed, rawContent] = match;

            if (typeof headerLineUntrimmed !== 'string' || typeof rawContent !== 'string') {
                continue;
            }

            const headerLine = headerLineUntrimmed.trim();
            if (headerLine === '') {
                continue;
            }

            matchedBlocks.push(fullMatch);
            const content = rawContent.trim();
            
            let filePath = '';
            let patchStrategy: PatchStrategy;
            
            const quotedMatch = headerLine.match(/^"(.+?)"(?:\s+(.*))?$/);
            if (quotedMatch) {
                filePath = quotedMatch[1]!;
                const strategyStr = quotedMatch[2] || '';
                const parsedStrategy = PatchStrategySchema.safeParse(strategyStr || undefined);
                if (!parsedStrategy.success) continue;
                patchStrategy = parsedStrategy.data;
            } else {
                const parts = headerLine.split(/\s+/);
                if (parts.length > 1) {
                    const strategyStr = parts.pop()!;
                    const parsedStrategy = PatchStrategySchema.safeParse(strategyStr);
                    if (!parsedStrategy.success) continue;
                    patchStrategy = parsedStrategy.data;
                    filePath = parts.join(' ');
                } else {
                    filePath = headerLine;
                    patchStrategy = PatchStrategySchema.parse(undefined);
                }
            }

            if (!filePath) continue;

            if (content === DELETE_FILE_MARKER) {
                operations.push({ type: 'delete', path: filePath });
            } else {
                const cleanContent = extractCodeBetweenMarkers(content);
                operations.push({ 
                    type: 'write', 
                    path: filePath, 
                    content: cleanContent, 
                    patchStrategy 
                });
            }
        }
        
        let reasoningText = textWithoutYaml;
        for (const block of matchedBlocks) {
            reasoningText = reasoningText.replace(block, '');
        }
        const reasoning = reasoningText.split('\n').map(line => line.trim()).filter(Boolean);

        if (operations.length === 0) return null;

        const parsedResponse = ParsedLLMResponseSchema.parse({
            control,
            operations,
            reasoning,
        });
        return parsedResponse;
    } catch (e) {
        if (e instanceof z.ZodError) {
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

const stateDirectoryCache = new Map<string, boolean>();

const getStateDirectory = (cwd: string) => path.resolve(cwd, STATE_DIRECTORY_NAME);

const getStateFilePath = (cwd: string, uuid: string, isPending: boolean): string => {
  const fileName = isPending ? `${uuid}.pending.yml` : `${uuid}.yml`;
  return path.join(getStateDirectory(cwd), fileName);
};

// Ensure state directory exists with caching for performance
const ensureStateDirectory = async (cwd: string): Promise<void> => {
  const dirPath = getStateDirectory(cwd);
  if (!stateDirectoryCache.has(dirPath)) {
    await fs.mkdir(dirPath, { recursive: true });
    stateDirectoryCache.set(dirPath, true);
  }
};

export const hasBeenProcessed = async (cwd: string, uuid: string): Promise<boolean> => {
  const committedPath = getStateFilePath(cwd, uuid, false);
  try {
    // Only check for a committed state file.
    // This allows re-processing a transaction that failed and left an orphaned .pending.yml
    await fs.access(committedPath);
    return true;
  } catch (e) {
    return false;
  }
};

export const writePendingState = async (cwd: string, state: StateFile): Promise<void> => {
  const validatedState = StateFileSchema.parse(state);
  const yamlString = yaml.dump(validatedState);
  const filePath = getStateFilePath(cwd, state.uuid, true);
  
  // Ensure directory exists (cached)
  await ensureStateDirectory(cwd);
  
  // Write file
  await fs.writeFile(filePath, yamlString, 'utf-8');
};

export const commitState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
  const committedPath = getStateFilePath(cwd, uuid, false);

  try {
    // fs.rename is atomic on most POSIX filesystems if src and dest are on the same partition.
    await fs.rename(pendingPath, committedPath);
  } catch (error) {
    // If rename fails with EXDEV, it's likely a cross-device move. Fallback to copy+unlink.
    if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
      await fs.copyFile(pendingPath, committedPath);
      await fs.unlink(pendingPath);
    } else {
      // Re-throw other errors
      throw error;
    }
  }
};

export const deletePendingState = async (cwd: string, uuid: string): Promise<void> => {
  const pendingPath = getStateFilePath(cwd, uuid, true);
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

## File: test/e2e/patcher.test.ts
````typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { processPatch } from '../../src/core/transaction';
import { parseLLMResponse } from '../../src/core/parser';
import { setupE2ETest, E2ETestContext, createTestConfig, createTestFile, LLM_RESPONSE_END, createFileBlock } from '../test.util';

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
        const config = await createTestConfig(context.testDir.path);
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
        
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'multi-search-replace') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(llmResponse);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: context.testDir.path });

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
        const config = await createTestConfig(context.testDir.path);
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
        
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'new-unified') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(llmResponse);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: context.testDir.path });

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
        const config = await createTestConfig(context.testDir.path);
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
        const uuid = uuidv4();
        const llmResponse = createFileBlock(testFile, diffContent, 'multi-search-replace') + 
                            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(llmResponse)!;

        await processPatch(config, parsedResponse, { cwd: context.testDir.path });

        // The file content should remain unchanged
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been committed
        const stateFileExists = await fs.access(path.join(context.testDir.path, '.relaycode', `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });
});
````

## File: test/test.util.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Config, PatchStrategy } from '../src/types';
import { CONFIG_FILE_NAME } from '../src/utils/constants';

export interface TestDir {
    path: string;
    cleanup: () => Promise<void>;
}

export const setupTestDirectory = async (): Promise<TestDir> => {
    const testDirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'relaycode-test-'));

    const cleanup = async () => {
        await fs.rm(testDirPath, { recursive: true, force: true });
    };

    return { path: testDirPath, cleanup };
};

export interface E2ETestContext {
    testDir: TestDir;
    cleanup: () => Promise<void>;
}

export const setupE2ETest = async (options: { withTsconfig?: boolean } = {}): Promise<E2ETestContext> => {
    const testDir = await setupTestDirectory();

    if (options.withTsconfig) {
        await createTestFile(testDir.path, 'tsconfig.json', JSON.stringify({
            "compilerOptions": { "strict": true, "noEmit": true, "isolatedModules": true },
            "include": ["src/**/*.ts"]
        }, null, 2));
    }
    
    // Suppress console output
    const originalConsole = {
        info: global.console.info,
        log: global.console.log,
        warn: global.console.warn,
        error: global.console.error,
        success: (global.console as any).success,
        prompt: (global.console as any).prompt,
    };
    
    global.console.info = () => {};
    global.console.log = () => {};
    global.console.warn = () => {};
    global.console.error = () => {};
    if ((global.console as any).success) (global.console as any).success = () => {};
    if ((global.console as any).prompt) (global.console as any).prompt = () => {};


    const cleanup = async () => {
        // Restore console
        global.console.info = originalConsole.info;
        global.console.log = originalConsole.log;
        global.console.warn = originalConsole.warn;
        global.console.error = originalConsole.error;
        if (originalConsole.success) (global.console as any).success = originalConsole.success;
        if (originalConsole.prompt) (global.console as any).prompt = originalConsole.prompt;
        
        // Give fs operations time to complete before cleanup
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Cleanup directory
        await testDir.cleanup();
    };

    return { testDir, cleanup };
};


export const createTestConfig = async (cwd: string, overrides: Partial<Config> = {}): Promise<Config> => {
    const defaultConfig: Config = {
        projectId: 'test-project',
        clipboardPollInterval: 100,
        approval: 'yes',
        approvalOnErrorCount: 0,
        linter: `bun -e "process.exit(0)"`, // A command that always succeeds
        preCommand: '',
        postCommand: '',
    };
    const config = { ...defaultConfig, ...overrides };
    await fs.writeFile(path.join(cwd, CONFIG_FILE_NAME), JSON.stringify(config, null, 2));
    return config;
};

export const createTestFile = async (cwd: string, filePath: string, content: string): Promise<void> => {
    const absolutePath = path.resolve(cwd, filePath);
    const dir = path.dirname(absolutePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absolutePath, content);
};

export const LLM_RESPONSE_START = `
I have analyzed your request and here are the changes.
First, I will edit the main file.
`;

export const LLM_RESPONSE_END = (uuid: string, changeSummary: { [key: string]: string }[]) => `
\`\`\`yaml
projectId: test-project
uuid: ${uuid}
changeSummary: ${JSON.stringify(changeSummary)}
\`\`\`
`;

export const createFileBlock = (filePath: string, content: string, patchStrategy?: PatchStrategy): string => {
    const strategyString = patchStrategy ? ` ${patchStrategy}` : '';
    return `
\`\`\`typescript // ${filePath}${strategyString}
// START

${content}

// END
\`\`\`
`;
};

export const createDeleteFileBlock = (filePath: string): string => {
    return `
\`\`\`typescript // ${filePath}
//TODO: delete this file
\`\`\`
`;
};
````

## File: tsconfig.json
````json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "lib": ["ESNext"],
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
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
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts"]
}
````

## File: src/core/executor.ts
````typescript
import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';
import { newUnifiedDiffStrategyService, multiSearchReplaceService, unifiedDiffService } from 'diff-apply';

export const readFileContent = async (filePath: string, cwd: string = process.cwd()): Promise<string | null> => {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), 'utf-8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null; // File doesn't exist
    }
    throw error;
  }
};

export const writeFileContent = async (filePath: string, content: string, cwd: string = process.cwd()): Promise<void> => {
  const absolutePath = path.resolve(cwd, filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');
};

export const deleteFile = async (filePath: string, cwd: string = process.cwd()): Promise<void> => {
  try {
    await fs.unlink(path.resolve(cwd, filePath));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // File already deleted, which is fine.
      return;
    }
    throw error;
  }
};

export const createSnapshot = async (filePaths: string[], cwd: string = process.cwd()): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = {};
  
  // Process file reads in parallel for better performance
  const snapshotPromises = filePaths.map(async (filePath) => {
    try {
      const absolutePath = path.resolve(cwd, filePath);
      try {
        const content = await fs.readFile(absolutePath, 'utf-8');
        return { path: filePath, content };
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return { path: filePath, content: null }; // File doesn't exist, which is fine.
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`Error creating snapshot for ${filePath}:`, error);
      throw error;
    }
  });
  
  const results = await Promise.all(snapshotPromises);
  
  // Combine results into snapshot object
  for (const result of results) {
    snapshot[result.path] = result.content;
  }
  
  return snapshot;
};

export const applyOperations = async (operations: FileOperation[], cwd: string = process.cwd()): Promise<void> => {
  await Promise.all(operations.map(async op => {
    if (op.type === 'delete') {
      return deleteFile(op.path, cwd);
    } 
    
    if (op.patchStrategy === 'replace') {
      return writeFileContent(op.path, op.content, cwd);
    }

    const originalContent = await readFileContent(op.path, cwd);
    if (originalContent === null && op.patchStrategy === 'multi-search-replace') {
      throw new Error(`Cannot use 'multi-search-replace' on a new file: ${op.path}`);
    }

    const diffParams = {
      originalContent: originalContent ?? '',
      diffContent: op.content,
    };

    let result;
    try {
      switch (op.patchStrategy) {
        case 'new-unified':
          const newUnifiedStrategy = newUnifiedDiffStrategyService.newUnifiedDiffStrategyService.create(0.95);
          result = await newUnifiedStrategy.applyDiff(diffParams);
          break;
        case 'multi-search-replace':
          result = await multiSearchReplaceService.multiSearchReplaceService.applyDiff(diffParams);
          break;
        case 'unified':
          result = await unifiedDiffService.unifiedDiffService.applyDiff(diffParams.originalContent, diffParams.diffContent);
          break;
        default:
          throw new Error(`Unknown patch strategy: ${op.patchStrategy}`);
      }

      if (result.success) {
        await writeFileContent(op.path, result.content, cwd);
      } else {
        throw new Error(result.error);
      }
    } catch (e) {
      throw new Error(`Error applying patch for ${op.path} with strategy ${op.patchStrategy}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }));
};

// Helper to check if a directory is empty
const isDirectoryEmpty = async (dirPath: string): Promise<boolean> => {
  try {
    const files = await fs.readdir(dirPath);
    return files.length === 0;
  } catch (error) {
    // If directory doesn't exist or is not accessible, consider it "not empty"
    return false;
  }
};

// Recursively remove all empty parent directories up to a limit
const removeEmptyParentDirectories = async (dirPath: string, rootDir: string): Promise<void> => {
  if (!dirPath.startsWith(rootDir) || dirPath === rootDir) {
    return;
  }
  
  try {
    const isEmpty = await isDirectoryEmpty(dirPath);
    if (isEmpty) {
      await fs.rmdir(dirPath);
      // Recursively check parent directory
      await removeEmptyParentDirectories(path.dirname(dirPath), rootDir);
    }
  } catch (error) {
    // Ignore directory removal errors, but don't continue up the chain
    if (!(error instanceof Error && 'code' in error && 
        (error.code === 'ENOENT' || error.code === 'ENOTDIR'))) {
      console.warn(`Failed to clean up directory ${dirPath}:`, error);
    }
  }
};

export const restoreSnapshot = async (snapshot: FileSnapshot, cwd: string = process.cwd()): Promise<void> => {
  const projectRoot = path.resolve(cwd);
  const entries = Object.entries(snapshot);
  const directoriesDeleted = new Set<string>();

  // First handle all file operations in parallel
  await Promise.all(entries.map(async ([filePath, content]) => {
    const fullPath = path.resolve(cwd, filePath);
    try {
      if (content === null) {
        // If the file didn't exist in the snapshot, make sure it doesn't exist after restore
        try {
          await fs.unlink(fullPath);
          directoriesDeleted.add(path.dirname(fullPath));
        } catch (error) {
          if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            // File or directory already doesn't exist, which is fine
          } else {
            throw error;
          }
        }
      } else {
        // Create directory structure if needed
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        
        // Write the original content back to the file
        await fs.writeFile(fullPath, content, 'utf-8');
      }
    } catch (error) {
      console.error(`Failed to restore ${filePath}:`, error);
      throw error;
    }
  }));
  
  // After all files are processed, clean up empty directories
  // Sort directories by depth (deepest first) to clean up nested empty dirs properly
  const sortedDirs = Array.from(directoriesDeleted)
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  
  // Process each directory that had files deleted
  for (const dir of sortedDirs) {
    await removeEmptyParentDirectories(dir, projectRoot);
  }
};
````

## File: test/e2e/init.test.ts
````typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { initCommand } from '../../src/commands/init';
import { setupTestDirectory, TestDir, createTestFile } from '../test.util';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../../src/utils/constants';
import { ConfigSchema } from '../../src/types';
import { logger } from '../../src/utils/logger';

describe('e2e/init', () => {
    let testDir: TestDir;

    beforeEach(async () => {
        testDir = await setupTestDirectory();
    });

    afterEach(async () => {
        await testDir.cleanup();
    });

    it('should create config file with correct defaults, state directory, and .gitignore', async () => {
        // Suppress console output for this test
        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog; // Restore console output

        // Check for config file
        const configPath = path.join(testDir.path, CONFIG_FILE_NAME);
        const configExists = await fs.access(configPath).then(() => true).catch(() => false);
        expect(configExists).toBe(true);

        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        
        // Validate against schema to check defaults
        const parsedConfig = ConfigSchema.parse(config);
        expect(parsedConfig.projectId).toBe(path.basename(testDir.path));
        expect(parsedConfig.clipboardPollInterval).toBe(2000);
        expect(parsedConfig.approval).toBe('yes');
        expect(parsedConfig.linter).toBe('bun tsc --noEmit');

        // Check for state directory
        const stateDirPath = path.join(testDir.path, STATE_DIRECTORY_NAME);
        const stateDirExists = await fs.stat(stateDirPath).then(s => s.isDirectory()).catch(() => false);
        expect(stateDirExists).toBe(true);

        // Check for .gitignore
        const gitignorePath = path.join(testDir.path, GITIGNORE_FILE_NAME);
        const gitignoreExists = await fs.access(gitignorePath).then(() => true).catch(() => false);
        expect(gitignoreExists).toBe(true);

        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should use package.json name for projectId if available', async () => {
        const pkgName = 'my-awesome-project';
        await createTestFile(testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        const originalLog = console.log;
        console.log = () => {};
        
        await initCommand(testDir.path);

        console.log = originalLog;

        const configPath = path.join(testDir.path, CONFIG_FILE_NAME);
        const configContent = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe(pkgName);
    });

    it('should append to existing .gitignore', async () => {
        const initialContent = '# Existing rules\nnode_modules/';
        await createTestFile(testDir.path, GITIGNORE_FILE_NAME, initialContent);

        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog;

        const gitignoreContent = await fs.readFile(path.join(testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        expect(gitignoreContent).toContain(initialContent);
        expect(gitignoreContent).toContain(`/${STATE_DIRECTORY_NAME}/`);
    });

    it('should not add entry to .gitignore if it already exists', async () => {
        const entry = `/${STATE_DIRECTORY_NAME}/`;
        const initialContent = `# Existing rules\n${entry}`;
        await createTestFile(testDir.path, GITIGNORE_FILE_NAME, initialContent);

        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog;

        const gitignoreContent = await fs.readFile(path.join(testDir.path, GITIGNORE_FILE_NAME), 'utf-8');
        const occurrences = (gitignoreContent.match(new RegExp(entry, 'g')) || []).length;
        expect(occurrences).toBe(1);
    });

    it('should not overwrite an existing relaycode.config.json', async () => {
        const customConfig = { projectId: 'custom', customField: true };
        await createTestFile(testDir.path, CONFIG_FILE_NAME, JSON.stringify(customConfig));

        const originalLog = console.log;
        console.log = () => {};

        await initCommand(testDir.path);

        console.log = originalLog;

        const configContent = await fs.readFile(path.join(testDir.path, CONFIG_FILE_NAME), 'utf-8');
        const config = JSON.parse(configContent);
        expect(config.projectId).toBe('custom');
        expect(config.customField).toBe(true);
    });

    it('should output the system prompt with the correct project ID', async () => {
        const capturedOutput: string[] = [];
        const originalLog = console.log;
        console.log = (message: string) => capturedOutput.push(message);

        const pkgName = 'my-prompt-project';
        await createTestFile(testDir.path, 'package.json', JSON.stringify({ name: pkgName }));

        await initCommand(testDir.path);

        console.log = originalLog; // Restore

        const outputString = capturedOutput.join('\n');
        expect(outputString).toContain(`projectId: ${pkgName}`);
        expect(outputString).toContain('You are an expert AI programmer.');
    });

    it('should log an error if .gitignore is not writable', async () => {
        const gitignorePath = path.join(testDir.path, GITIGNORE_FILE_NAME);
        await createTestFile(testDir.path, GITIGNORE_FILE_NAME, '# initial');
        
        const capturedErrors: string[] = [];
        const originalError = logger.error;
        const originalInfo = logger.info;
        const originalSuccess = logger.success;
        const originalLog = logger.log;
        const originalWarn = logger.warn;

        logger.error = (message: string) => capturedErrors.push(message);
        logger.info = () => {};
        logger.success = () => {};
        logger.log = () => {};
        logger.warn = () => {};

        try {
            await fs.chmod(gitignorePath, 0o444); // Read-only

            // initCommand doesn't throw, it just logs an error.
            await initCommand(testDir.path);

            const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
            expect(gitignoreContent).toBe('# initial'); // Should not have changed
            expect(capturedErrors.length).toBe(1);
            expect(capturedErrors[0]).toContain(`Failed to update ${GITIGNORE_FILE_NAME}`);
        } finally {
            // Restore loggers
            logger.error = originalError;
            logger.info = originalInfo;
            logger.success = originalSuccess;
            logger.log = originalLog;
            logger.warn = originalWarn;
            
            // Make writable again for cleanup
            await fs.chmod(gitignorePath, 0o666);
        }
    });
});
````

## File: test/unit/parser.test.ts
````typescript
import { describe, it, expect } from 'bun:test';
import { parseLLMResponse } from '../../src/core/parser';
import { v4 as uuidv4 } from 'uuid';
import { LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock } from '../test.util';

describe('core/parser', () => {

    describe('parseLLMResponse', () => {
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
});
````

## File: test/e2e/transaction.test.ts
````typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { processPatch } from '../../src/core/transaction';
import { parseLLMResponse } from '../../src/core/parser';
import { setupE2ETest, E2ETestContext, createTestConfig, createTestFile, LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock } from '../test.util';
import { STATE_DIRECTORY_NAME } from '../../src/utils/constants';


describe('e2e/transaction', () => {
    let context: E2ETestContext;
    const testFile = 'src/index.ts';
    const originalContent = 'console.log("original");';

    beforeEach(async () => {
        context = await setupE2ETest({ withTsconfig: true });
        await createTestFile(context.testDir.path, testFile, originalContent);
    });

    afterEach(async () => {
        if (context) await context.cleanup();
    });

    it('should apply changes, commit, and store correct state in .yml file', async () => {
        const config = await createTestConfig(context.testDir.path, { 
            linter: '', // Skip actual linting to avoid timeout
            approval: 'yes'
        });
        const newContent = 'console.log("new content");';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: context.testDir.path });

        // Add a small delay to ensure file operations have completed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Check file content
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        // Check state file was committed
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        
        // Try multiple times with a small delay to check if the file exists
        let stateFileExists = false;
        for (let i = 0; i < 5; i++) {
            stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
            if (stateFileExists) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(stateFileExists).toBe(true);

        // Check state file content
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.uuid).toBe(uuid);
        expect(stateData.approved).toBe(true);
        expect(stateData.operations).toHaveLength(1);
        expect(stateData.operations[0].path).toBe(testFile);
        expect(stateData.snapshot[testFile]).toBe(originalContent);
        expect(stateData.reasoning).toEqual(parsedResponse!.reasoning);
    });

    it('should rollback changes when manually disapproved', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        const newContent = 'console.log("I will be rolled back");';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        const prompter = async () => false; // Disapprove
        await processPatch(config, parsedResponse!, { prompter, cwd: context.testDir.path });

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should require manual approval if linter errors exceed approvalOnErrorCount', async () => {
        const config = await createTestConfig(context.testDir.path, { 
            approval: 'yes',
            approvalOnErrorCount: 0,
            linter: `bun tsc`
        });
        
        const badContent = 'const x: string = 123;'; // 1 TS error
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                        createFileBlock(testFile, badContent) + 
                        LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        // Disapprove when prompted
        const prompter = async () => false;
        await processPatch(config, parsedResponse!, { prompter, cwd: context.testDir.path });
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    });

    it('should skip linter if command is empty and auto-approve', async () => {
        const config = await createTestConfig(context.testDir.path, { linter: '' });
        const badContent = 'const x: string = 123;'; // Would fail linter, but it's skipped
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(testFile, badContent) +
            LLM_RESPONSE_END(uuid, [{ edit: testFile }]);

        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();

        await processPatch(config, parsedResponse!, { cwd: context.testDir.path });

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);
    });

    it('should ignore patch with already processed UUID', async () => {
        const config = await createTestConfig(context.testDir.path);
        const uuid = uuidv4();
        
        // 1. Process and commit a patch
        const response1 = LLM_RESPONSE_START + createFileBlock(testFile, "first change") + LLM_RESPONSE_END(uuid, []);
        const parsed1 = parseLLMResponse(response1)!;
        await processPatch(config, parsed1, { cwd: context.testDir.path });
        
        // 2. Try to process another patch with the same UUID
        const response2 = LLM_RESPONSE_START + createFileBlock(testFile, "second change") + LLM_RESPONSE_END(uuid, []);
        const parsed2 = parseLLMResponse(response2)!;
        await processPatch(config, parsed2, { cwd: context.testDir.path });

        // Content should be from the first change, not the second
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("first change");
    });
    
    it('should create nested directories for new files', async () => {
        const config = await createTestConfig(context.testDir.path);
        const newFilePath = 'src/a/b/c/new-file.ts';
        const newFileContent = 'hello world';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, newFileContent) +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { cwd: context.testDir.path });

        const finalContent = await fs.readFile(path.join(context.testDir.path, newFilePath), 'utf-8');
        expect(finalContent).toBe(newFileContent);
    });

    it('should rollback new file and its new empty parent directory on rejection', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        const newFilePath = 'src/new/dir/file.ts';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, 'content') +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { prompter: async () => false, cwd: context.testDir.path });

        const fileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(fileExists).toBe(false);

        const dirExists = await fs.access(path.join(context.testDir.path, 'src/new/dir')).then(() => true).catch(() => false);
        expect(dirExists).toBe(false);

        const midDirExists = await fs.access(path.join(context.testDir.path, 'src/new')).then(() => true).catch(() => false);
        expect(midDirExists).toBe(false);
        
        // src directory should still exist as it contained a file before
        const srcDirExists = await fs.access(path.join(context.testDir.path, 'src')).then(() => true).catch(() => false);
        expect(srcDirExists).toBe(true);
    });

    it('should not delete parent directory on rollback if it was not empty beforehand', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        const existingFilePath = 'src/shared/existing.ts';
        const newFilePath = 'src/shared/new.ts';
        const uuid = uuidv4();

        await createTestFile(context.testDir.path, existingFilePath, 'const existing = true;');

        const response = LLM_RESPONSE_START +
            createFileBlock(newFilePath, 'const brandNew = true;') +
            LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { prompter: async () => false, cwd: context.testDir.path });

        // New file should be gone
        const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);

        // Existing file and its directory should remain
        const existingFileExists = await fs.access(path.join(context.testDir.path, existingFilePath)).then(() => true).catch(() => false);
        expect(existingFileExists).toBe(true);

        const sharedDirExists = await fs.access(path.join(context.testDir.path, 'src/shared')).then(() => true).catch(() => false);
        expect(sharedDirExists).toBe(true);
    });

    it('should abort transaction if preCommand fails', async () => {
        const config = await createTestConfig(context.testDir.path, { preCommand: 'bun -e "process.exit(1)"' });
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { cwd: context.testDir.path });

        // File should not have been changed
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        // No state file should have been created
        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should automatically roll back if postCommand fails', async () => {
        const config = await createTestConfig(context.testDir.path, { postCommand: 'bun -e "process.exit(1)"' });
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);

        const parsed = parseLLMResponse(response)!;
        await processPatch(config, parsed, { cwd: context.testDir.path });

        // File should have been rolled back
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFileExists = await fs.access(path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`)).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should ignore patch with non-matching projectId', async () => {
        const config = await createTestConfig(context.testDir.path, { projectId: 'correct-project' });
        const uuid = uuidv4();
        
        const responseWithWrongProject =
`\`\`\`typescript // {src/index.ts}
// START
console.log("should not be applied");
// END
\`\`\`
\`\`\`yaml
projectId: wrong-project
uuid: ${uuid}
changeSummary: []
\`\`\``;
        
        const parsedResponse = parseLLMResponse(responseWithWrongProject);
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!, { cwd: context.testDir.path });

        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should correctly apply a file deletion operation', async () => {
        const config = await createTestConfig(context.testDir.path);
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createDeleteFileBlock(fileToDelete) +
                         LLM_RESPONSE_END(uuid, [{ delete: fileToDelete }]);
        const parsedResponse = parseLLMResponse(response)!;
        
        await processPatch(config, parsedResponse, { cwd: context.testDir.path });

        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(false);
        
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.snapshot[fileToDelete]).toBe(originalDeleteContent);
        expect(stateData.operations[0]).toEqual({ type: 'delete', path: fileToDelete });
    });

    it('should correctly roll back a file deletion operation', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        const fileToDelete = 'src/delete-me.ts';
        const originalDeleteContent = 'delete this content';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
        
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createDeleteFileBlock(fileToDelete) +
                         LLM_RESPONSE_END(uuid, [{ delete: fileToDelete }]);

        const parsedResponse = parseLLMResponse(response)!;
        
        await processPatch(config, parsedResponse, { prompter: async () => false, cwd: context.testDir.path });

        const restoredFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(restoredFileExists).toBe(true);
        const content = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(content).toBe(originalDeleteContent);
        
        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });

    it('should auto-approve if linter errors are within approvalOnErrorCount', async () => {
        const config = await createTestConfig(context.testDir.path, {
            approval: 'yes',
            approvalOnErrorCount: 1,
            linter: 'bun tsc'
        });
        const badContent = 'const x: string = 123;'; // 1 TS error
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                        createFileBlock(testFile, badContent) + 
                        LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
        
        const parsedResponse = parseLLMResponse(response);
        expect(parsedResponse).not.toBeNull();
        
        await processPatch(config, parsedResponse!, { cwd: context.testDir.path });
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(badContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
    });

    it('should ignore orphaned .pending.yml file and allow reprocessing', async () => {
        const config = await createTestConfig(context.testDir.path);
        const uuid = uuidv4();
        const newContent = 'console.log("final content");';

        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        await fs.mkdir(stateDir, { recursive: true });
        const orphanedPendingFile = path.join(stateDir, `${uuid}.pending.yml`);
        const orphanedState = { uuid, message: 'this is from a crashed run' };
        await fs.writeFile(orphanedPendingFile, yaml.dump(orphanedState));

        const response = LLM_RESPONSE_START + createFileBlock(testFile, newContent) + LLM_RESPONSE_END(uuid, []);
        const parsedResponse = parseLLMResponse(response)!;
        await processPatch(config, parsedResponse, { cwd: context.testDir.path });
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(newContent);

        const finalStateFile = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(finalStateFile).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(true);
        
        const stateFileContent = await fs.readFile(finalStateFile, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.projectId).toBe(config.projectId);
        expect(stateData.approved).toBe(true);
    });

    it('should successfully run pre and post commands (happy path)', async () => {
        const preCommandFile = path.join(context.testDir.path, 'pre.txt');
        const postCommandFile = path.join(context.testDir.path, 'post.txt');
    
        // Use node directly as it's more reliable cross-platform
        const config = await createTestConfig(context.testDir.path, {
            preCommand: `node -e "require('fs').writeFileSync('${preCommandFile.replace(/\\/g, '\\\\')}', '')"`,
            postCommand: `node -e "require('fs').writeFileSync('${postCommandFile.replace(/\\/g, '\\\\')}', '')"`,
        });
    
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + createFileBlock(testFile, "new content") + LLM_RESPONSE_END(uuid, []);
        const parsed = parseLLMResponse(response)!;
    
        await processPatch(config, parsed, { cwd: context.testDir.path });
    
        const preExists = await fs.access(preCommandFile).then(() => true).catch(() => false);
        expect(preExists).toBe(true);
    
        const postExists = await fs.access(postCommandFile).then(() => true).catch(() => false);
        expect(postExists).toBe(true);
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe("new content");
    });

    it('should create a pending file during transaction and remove it on rollback', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        const newContent = 'I will be rolled back';
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START + 
                         createFileBlock(testFile, newContent) + 
                         LLM_RESPONSE_END(uuid, [{ edit: testFile }]);
    
        const parsedResponse = parseLLMResponse(response)!;
    
        const stateDir = path.join(context.testDir.path, STATE_DIRECTORY_NAME);
        const pendingPath = path.join(stateDir, `${uuid}.pending.yml`);
        const committedPath = path.join(stateDir, `${uuid}.yml`);
    
        let pendingFileExistedDuringRun = false;
    
        const prompter = async (): Promise<boolean> => {
            // At this point, the pending file should exist before we answer the prompt
            pendingFileExistedDuringRun = await fs.access(pendingPath).then(() => true).catch(() => false);
            return false; // Disapprove to trigger rollback
        };
    
        await processPatch(config, parsedResponse, { prompter, cwd: context.testDir.path });
    
        expect(pendingFileExistedDuringRun).toBe(true);
        
        const finalContent = await fs.readFile(path.join(context.testDir.path, testFile), 'utf-8');
        expect(finalContent).toBe(originalContent);
    
        const pendingFileExistsAfter = await fs.access(pendingPath).then(() => true).catch(() => false);
        expect(pendingFileExistsAfter).toBe(false);
    
        const committedFileExists = await fs.access(committedPath).then(() => true).catch(() => false);
        expect(committedFileExists).toBe(false);
    });

    it('should fail transaction gracefully if a file is not writable and rollback all changes', async () => {
        const config = await createTestConfig(context.testDir.path);
        const unwritableFile = 'src/unwritable.ts';
        const writableFile = 'src/writable.ts';
        const originalUnwritableContent = 'original unwritable';
        const originalWritableContent = 'original writable';
    
        await createTestFile(context.testDir.path, unwritableFile, originalUnwritableContent);
        await createTestFile(context.testDir.path, writableFile, originalWritableContent);
        
        const unwritableFilePath = path.join(context.testDir.path, unwritableFile);

        try {
            await fs.chmod(unwritableFilePath, 0o444); // Make read-only

            const uuid = uuidv4();
            const response = LLM_RESPONSE_START +
                createFileBlock(writableFile, "new writable content") +
                createFileBlock(unwritableFile, "new unwritable content") +
                LLM_RESPONSE_END(uuid, [{ edit: writableFile }, { edit: unwritableFile }]);
            
            const parsedResponse = parseLLMResponse(response)!;
            await processPatch(config, parsedResponse, { cwd: context.testDir.path });
        
            // Check file states: both should be rolled back to original content.
            const finalWritable = await fs.readFile(path.join(context.testDir.path, writableFile), 'utf-8');
            expect(finalWritable).toBe(originalWritableContent); 

            const finalUnwritable = await fs.readFile(unwritableFilePath, 'utf-8');
            expect(finalUnwritable).toBe(originalUnwritableContent);
        
            // Check that pending and final state files were cleaned up/not created.
            const pendingStatePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
            const pendingFileExists = await fs.access(pendingStatePath).then(() => true).catch(() => false);
            expect(pendingFileExists).toBe(false);

            const finalStatePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
            const finalStateExists = await fs.access(finalStatePath).then(() => true).catch(() => false);
            expect(finalStateExists).toBe(false);
        } finally {
            // Ensure file is writable again so afterEach hook can clean up
            await fs.chmod(unwritableFilePath, 0o666);
        }
    });

    it('should rollback gracefully if creating a file in a non-writable directory fails', async () => {
        const config = await createTestConfig(context.testDir.path);
        const readonlyDir = 'src/readonly-dir';
        const newFilePath = path.join(readonlyDir, 'new-file.ts');
        const readonlyDirPath = path.join(context.testDir.path, readonlyDir);
    
        await fs.mkdir(readonlyDirPath, { recursive: true });
        await fs.chmod(readonlyDirPath, 0o555); // Read and execute only
    
        try {
            const uuid = uuidv4();
            const response = LLM_RESPONSE_START +
                createFileBlock(newFilePath, 'this should not be written') +
                LLM_RESPONSE_END(uuid, [{ new: newFilePath }]);
            
            const parsedResponse = parseLLMResponse(response)!;
            await processPatch(config, parsedResponse, { cwd: context.testDir.path });
    
            // Check that the new file was not created
            const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
            expect(newFileExists).toBe(false);
    
            // Check that the transaction was rolled back (no final .yml file)
            const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
            const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
            expect(stateFileExists).toBe(false);
            
            // Check that pending state file was cleaned up
            const pendingStatePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.pending.yml`);
            const pendingFileExists = await fs.access(pendingStatePath).then(() => true).catch(() => false);
            expect(pendingFileExists).toBe(false);
    
        } finally {
            await fs.chmod(readonlyDirPath, 0o777); // Make writable again for cleanup
        }
    });

    it('should correctly rollback a complex transaction (modify, delete, create)', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        
        // Setup initial files
        const fileToModify = 'src/modify.ts';
        const originalModifyContent = 'export const a = 1;';
        await createTestFile(context.testDir.path, fileToModify, originalModifyContent);
    
        const fileToDelete = 'src/delete.ts';
        const originalDeleteContent = 'export const b = 2;';
        await createTestFile(context.testDir.path, fileToDelete, originalDeleteContent);
    
        const newFilePath = 'src/new/component.ts';
        const newFileContent = 'export const c = 3;';
    
        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createFileBlock(fileToModify, 'export const a = 100;') +
            createDeleteFileBlock(fileToDelete) +
            createFileBlock(newFilePath, newFileContent) +
            LLM_RESPONSE_END(uuid, [{ edit: fileToModify }, { delete: fileToDelete }, { new: newFilePath }]);
    
        const parsed = parseLLMResponse(response)!;
    
        // Disapprove the transaction
        await processPatch(config, parsed, { prompter: async () => false, cwd: context.testDir.path });
    
        // Verify rollback
        const modifiedFileContent = await fs.readFile(path.join(context.testDir.path, fileToModify), 'utf-8');
        expect(modifiedFileContent).toBe(originalModifyContent);
    
        const deletedFileExists = await fs.access(path.join(context.testDir.path, fileToDelete)).then(() => true).catch(() => false);
        expect(deletedFileExists).toBe(true);
        const deletedFileContent = await fs.readFile(path.join(context.testDir.path, fileToDelete), 'utf-8');
        expect(deletedFileContent).toBe(originalDeleteContent);
    
        const newFileExists = await fs.access(path.join(context.testDir.path, newFilePath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);
    
        // Verify empty parent directory of new file is also removed
        const newFileDirExists = await fs.access(path.join(context.testDir.path, 'src/new')).then(() => true).catch(() => false);
        expect(newFileDirExists).toBe(false);
    });
});
````

## File: src/core/transaction.ts
````typescript
import { Config, ParsedLLMResponse, StateFile, FileSnapshot, FileOperation } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations, readFileContent } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';
import { notifyApprovalRequired, notifyFailure, notifySuccess } from '../utils/notifier';

type Prompter = (question: string) => Promise<boolean>;

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
};

const calculateLineChanges = async (op: FileOperation, snapshot: FileSnapshot, cwd: string): Promise<{ added: number; removed: number }> => {
    const oldContent = snapshot[op.path] ?? null;

    if (op.type === 'delete') {
        const oldLines = oldContent ? oldContent.split('\n') : [];
        return { added: 0, removed: oldLines.length };
    }

    // After applyOperations, the new content is on disk
    const newContent = await readFileContent(op.path, cwd);
    if (oldContent === newContent) return { added: 0, removed: 0 };

    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];

    if (oldContent === null || oldContent === '') return { added: newLines.length, removed: 0 };
    if (newContent === null || newContent === '') return { added: 0, removed: oldLines.length };
    
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    
    const added = newLines.filter(line => !oldSet.has(line)).length;
    const removed = oldLines.filter(line => !newSet.has(line)).length;
    
    return { added, removed };
};

const logCompletionSummary = (
    uuid: string,
    startTime: number,
    operations: FileOperation[],
    opStats: Array<{ added: number; removed: number }>
) => {
    const duration = performance.now() - startTime;
    const totalAdded = opStats.reduce((sum, s) => sum + s.added, 0);
    const totalRemoved = opStats.reduce((sum, s) => sum + s.removed, 0);

    logger.log('\nSummary:');
    logger.log(`Applied ${operations.length} file operation(s) successfully.`);
    logger.success(`Lines changed: +${totalAdded}, -${totalRemoved}`);
    logger.log(`Completed in ${duration.toFixed(2)}ms`);
    logger.success(`✅ Transaction ${uuid} committed successfully!`);
};

const rollbackTransaction = async (cwd: string, uuid: string, snapshot: FileSnapshot, reason: string): Promise<void> => {
    logger.warn(`Rolling back changes: ${reason}`);
    try {
        await restoreSnapshot(snapshot, cwd);
        logger.success('  - Files restored to original state.');
    } catch (error) {
        logger.error(`Fatal: Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
        // Do not rethrow; we're already in a final error handling state.
    } finally {
        try {
            await deletePendingState(cwd, uuid);
            logger.success(`↩️ Transaction ${uuid} rolled back.`);
            notifyFailure(uuid);
        } catch (cleanupError) {
            logger.error(`Fatal: Could not clean up pending state for ${uuid}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
    }
};

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const cwd = options?.cwd || process.cwd();
    const prompter = options?.prompter || getConfirmation;
    const { control, operations, reasoning } = parsedResponse;
    const { uuid, projectId } = control;
    const startTime = performance.now();

    // 1. Validation
    if (projectId !== config.projectId) {
        logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
        return;
    }
    if (await hasBeenProcessed(cwd, uuid)) {
        logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
        return;
    }

    // 2. Pre-flight checks
    if (config.preCommand) {
        logger.log(`  - Running pre-command: ${config.preCommand}`);
        const { exitCode, stderr } = await executeShellCommand(config.preCommand, cwd);
        if (exitCode !== 0) {
            logger.error(`Pre-command failed with exit code ${exitCode}, aborting transaction.`);
            if (stderr) logger.error(`Stderr: ${stderr}`);
            return;
        }
    }

    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);

    const affectedFilePaths = operations.map(op => op.path);
    const snapshot = await createSnapshot(affectedFilePaths, cwd);
    
    const stateFile: StateFile = {
        uuid, projectId, createdAt: new Date().toISOString(), reasoning, operations, snapshot, approved: false,
    };

    try {
        await writePendingState(cwd, stateFile);
        logger.success('  - Staged changes to .pending.yml file.');

        // Apply changes
        logger.log('  - Applying file operations...');
        await applyOperations(operations, cwd);
        logger.success('  - File operations complete.');

        const opStatsPromises = operations.map(async op => {
            const stats = await calculateLineChanges(op, snapshot, cwd);
            if (op.type === 'write') {
                logger.success(`✔ Written: ${op.path} (+${stats.added}, -${stats.removed})`);
            } else {
                logger.success(`✔ Deleted: ${op.path}`);
            }
            return stats;
        });
        const opStats = await Promise.all(opStatsPromises);

        // Run post-command
        if (config.postCommand) {
            logger.log(`  - Running post-command: ${config.postCommand}`);
            const postResult = await executeShellCommand(config.postCommand, cwd);
            if (postResult.exitCode !== 0) {
                logger.error(`Post-command failed with exit code ${postResult.exitCode}.`);
                if (postResult.stderr) logger.error(`Stderr: ${postResult.stderr}`);
                throw new Error('Post-command failed, forcing rollback.');
            }
        }

        // Check for approval
        const finalErrorCount = await getErrorCount(config.linter, cwd);
        logger.log(`  - Final linter error count: ${finalErrorCount}`);
        const canAutoApprove = config.approval === 'yes' && finalErrorCount <= config.approvalOnErrorCount;
        
        let isApproved: boolean;
        if (canAutoApprove) {
            logger.success('  - Changes automatically approved based on your configuration.');
            isApproved = true;
        } else {
            notifyApprovalRequired(config.projectId);
            isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
        }

        if (isApproved) {
            stateFile.approved = true;
            await writePendingState(cwd, stateFile); // Update state with approved: true before commit
            await commitState(cwd, uuid);
            logCompletionSummary(uuid, startTime, operations, opStats);
            notifySuccess(uuid);
        } else {
            throw new Error('Changes were not approved.');
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await rollbackTransaction(cwd, uuid, snapshot, reason);
    }
};
````

## File: package.json
````json
{
  "name": "relaycode",
  "version": "1.0.5",
  "description": "A developer assistant that automates applying code changes from LLMs.",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "relay": "./dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "clean": "rm -rf dist",
    "build": "bun run clean && bun build ./src/index.ts ./src/cli.ts --outdir ./dist --target node",
    "test": "bun test",
    "dev": "bun run src/cli.ts",
    "prepublishOnly": "bun run build"
  },
  "dependencies": {
    "chalk": "^5.4.1",
    "clipboardy": "^4.0.0",
    "commander": "^12.1.0",
    "diff-apply": "^1.0.6",
    "js-yaml": "^4.1.0",
    "relaycode": "^1.0.2",
    "toasted-notifier": "^10.1.0",
    "uuid": "^9.0.1",
    "zod": "^3.25.67"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/js-yaml": "^4.0.9",
    "@types/uuid": "^9.0.8",
    "typescript": "^5.8.3"
  },
  "keywords": [
    "ai",
    "llm",
    "automation",
    "codegen",
    "developer-tool",
    "cli"
  ],
  "author": "Relay Code",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/relaycoder/relaycode.git"
  },
  "homepage": "https://relay.code"
}
````
