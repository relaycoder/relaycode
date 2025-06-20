Answering your request to implement a `rename` operation and fix a failing test.

Here are the code changes:

First, I'll update the core types to include a `rename` operation.

```typescript // src/types.ts
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
  z.object({
    type: z.literal('rename'),
    from: z.string(),
    to: z.string(),
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

I'll add a new constant for the rename operation syntax.

```typescript // src/utils/constants.ts
export const CONFIG_FILE_NAME = 'relaycode.config.json';
export const STATE_DIRECTORY_NAME = '.relaycode';
export const GITIGNORE_FILE_NAME = '.gitignore';

export const CODE_BLOCK_START_MARKER = '// START';
export const CODE_BLOCK_END_MARKER = '// END';
export const DELETE_FILE_MARKER = '//TODO: delete this file';
export const RENAME_FILE_MARKER_PREFIX = '//TODO: rename to ';
```

The system prompt for the AI assistant needs to be updated to include instructions for the new `rename` operation.

```typescript // src/commands/init.ts
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
-   **Renaming/Moving a file**:
    \`\`\`typescript // path/to/old-file.ts
    //TODO: rename to path/to/new-file.ts
    \`\`\`
    \`\`\`typescript // "path/to/My Old Component.ts"
    //TODO: rename to "path/to/My New Component.ts"
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
      - rename:
          from: src/old.ts
          to: src/new.ts
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
```

Next, I'll update the parser to recognize the new syntax.

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
    DELETE_FILE_MARKER,
    RENAME_FILE_MARKER_PREFIX
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
            } else if (content.startsWith(RENAME_FILE_MARKER_PREFIX)) {
                const toPathRaw = content.substring(RENAME_FILE_MARKER_PREFIX.length).trim();
                const quotedToPathMatch = toPathRaw.match(/^"(.+?)"$/);
                const toPath = quotedToPathMatch ? quotedToPathMatch[1] : toPathRaw;

                if (toPath) {
                    operations.push({ type: 'rename', from: filePath, to: toPath });
                }
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
```

The file executor needs a `renameFile` function and `applyOperations` must be updated to handle the new operation type.

```typescript // src/core/executor.ts
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

export const renameFile = async (fromPath: string, toPath: string, cwd: string = process.cwd()): Promise<void> => {
  const fromAbsolutePath = path.resolve(cwd, fromPath);
  const toAbsolutePath = path.resolve(cwd, toPath);
  await fs.mkdir(path.dirname(toAbsolutePath), { recursive: true });
  await fs.rename(fromAbsolutePath, toAbsolutePath);
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
    if (op.type === 'rename') {
      return renameFile(op.from, op.to, cwd);
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
```

I'll now apply the fix for the failing test and update the transaction logic to handle renames. The key change is making `rollbackTransaction` more robust by using a `finally` block to ensure the pending state file is always cleaned up on rollback.

```typescript // src/core/transaction.ts
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
    if (op.type === 'rename') {
        return { added: 0, removed: 0 };
    }
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

    const affectedFilePaths = operations.flatMap(op => {
        if (op.type === 'rename') return [op.from, op.to];
        return [op.path];
    });
    const snapshot = await createSnapshot([...new Set(affectedFilePaths)], cwd);
    
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
            } else if (op.type === 'delete') {
                logger.success(`✔ Deleted: ${op.path}`);
            } else if (op.type === 'rename') {
                logger.success(`✔ Renamed: ${op.from} -> ${op.to}`);
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
```

Finally, I'll add tests for the new rename functionality to `transaction.test.ts`.

```typescript // test/e2e/transaction.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import yaml from 'js-yaml';
import { processPatch } from '../../src/core/transaction';
import { parseLLMResponse } from '../../src/core/parser';
import { setupE2ETest, E2ETestContext, createTestConfig, createTestFile, LLM_RESPONSE_START, LLM_RESPONSE_END, createFileBlock, createDeleteFileBlock, createRenameFileBlock } from '../test.util';
import { STATE_DIRECTORY_NAME, RENAME_FILE_MARKER_PREFIX } from '../../src/utils/constants';


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

    it('should correctly apply a file rename operation', async () => {
        const config = await createTestConfig(context.testDir.path);
        const oldPath = 'src/rename-me.ts';
        const newPath = 'src/has-been-renamed.ts';
        const fileContent = 'this file will be renamed';
        await createTestFile(context.testDir.path, oldPath, fileContent);

        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createRenameFileBlock(oldPath, newPath) +
            LLM_RESPONSE_END(uuid, [{ rename: { from: oldPath, to: newPath } }]);
        const parsedResponse = parseLLMResponse(response)!;

        await processPatch(config, parsedResponse, { cwd: context.testDir.path });

        const oldFileExists = await fs.access(path.join(context.testDir.path, oldPath)).then(() => true).catch(() => false);
        expect(oldFileExists).toBe(false);

        const newFileExists = await fs.access(path.join(context.testDir.path, newPath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(true);

        const newFileContent = await fs.readFile(path.join(context.testDir.path, newPath), 'utf-8');
        expect(newFileContent).toBe(fileContent);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileContent = await fs.readFile(stateFilePath, 'utf-8');
        const stateData: any = yaml.load(stateFileContent);
        expect(stateData.snapshot[oldPath]).toBe(fileContent);
        expect(stateData.snapshot[newPath]).toBe(null);
        expect(stateData.operations[0]).toEqual({ type: 'rename', from: oldPath, to: newPath });
    });

    it('should correctly roll back a file rename operation', async () => {
        const config = await createTestConfig(context.testDir.path, { approval: 'no' });
        const oldPath = 'src/rename-me-then-rollback.ts';
        const newPath = 'src/i-should-not-exist.ts';
        const fileContent = 'this rename will be undone';
        await createTestFile(context.testDir.path, oldPath, fileContent);

        const uuid = uuidv4();
        const response = LLM_RESPONSE_START +
            createRenameFileBlock(oldPath, newPath) +
            LLM_RESPONSE_END(uuid, [{ rename: { from: oldPath, to: newPath } }]);

        const parsedResponse = parseLLMResponse(response)!;
        await processPatch(config, parsedResponse, { prompter: async () => false, cwd: context.testDir.path });

        const oldFileExists = await fs.access(path.join(context.testDir.path, oldPath)).then(() => true).catch(() => false);
        expect(oldFileExists).toBe(true);
        const oldFileContent = await fs.readFile(path.join(context.testDir.path, oldPath), 'utf-8');
        expect(oldFileContent).toBe(fileContent);

        const newFileExists = await fs.access(path.join(context.testDir.path, newPath)).then(() => true).catch(() => false);
        expect(newFileExists).toBe(false);

        const stateFilePath = path.join(context.testDir.path, STATE_DIRECTORY_NAME, `${uuid}.yml`);
        const stateFileExists = await fs.access(stateFilePath).then(() => true).catch(() => false);
        expect(stateFileExists).toBe(false);
    });
});
```

And finally, I'll update the test utilities to include a helper for creating rename blocks.

```typescript // test/test.util.ts
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Config, PatchStrategy } from '../src/types';
import { CONFIG_FILE_NAME, RENAME_FILE_MARKER_PREFIX } from '../src/utils/constants';

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

export const LLM_RESPONSE_END = (uuid: string, changeSummary: { [key: string]: any }[]) => `
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

export const createRenameFileBlock = (fromPath: string, toPath: string): string => {
    return `
\`\`\`typescript // ${fromPath}
${RENAME_FILE_MARKER_PREFIX}${toPath}
\`\`\`
`;
};
```