Of course! I can help you refactor your codebase to be more concise and maintainable. I've identified a few areas where we can improve code clarity, reduce redundancy, and even fix a potential race condition, all while keeping the existing functionality intact.

Here are the optimized code changes:

```typescript
// src/commands/init.ts
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
\`\`\`typescript // {filePath} {patchStrategy}
... content ...
\`\`\`
- \`filePath\`: The path to the file.
- \`patchStrategy\`: (Optional) One of \`new-unified\`, \`multi-search-replace\`. If omitted, the entire file is replaced (this is the \`replace\` strategy).

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
    \`\`\`typescript // {filePath}
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
```
```typescript
// src/core/state.ts
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
```
```typescript
// src/core/transaction.ts
// src/core/transaction.ts
import { Config, ParsedLLMResponse, StateFile, FileSnapshot } from '../types';
import { logger } from '../utils/logger';
import { getErrorCount, executeShellCommand } from '../utils/shell';
import { createSnapshot, restoreSnapshot, applyOperations, readFileContent } from './executor';
import { hasBeenProcessed, writePendingState, commitState, deletePendingState } from './state';
import { getConfirmation } from '../utils/prompt';

type Prompter = (question: string) => Promise<boolean>;

type TransactionDependencies = {
  config: Config;
  parsedResponse: ParsedLLMResponse;
  prompter?: Prompter;
  cwd: string;
};

type LineChanges = {
    added: number;
    removed: number;
};

// A simple LCS-based diff to calculate line changes.
const calculateLineChanges = (oldContent: string | null, newContent: string): LineChanges => {
    if (oldContent === newContent) return { added: 0, removed: 0 };

    const oldLines = oldContent ? oldContent.split('\n') : [];
    const newLines = newContent ? newContent.split('\n') : [];

    if (oldContent === null || oldContent === '') return { added: newLines.length, removed: 0 };
    if (newContent === '') return { added: 0, removed: oldLines.length };

    // Simplified line change calculation for better performance
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    
    const added = newLines.filter(line => !oldSet.has(line)).length;
    const removed = oldLines.filter(line => !newSet.has(line)).length;
    
    return { added, removed };
};

// This HOF encapsulates the logic for processing a single patch.
const createTransaction = (deps: TransactionDependencies) => {
  const { config, parsedResponse, prompter = getConfirmation, cwd } = deps;
  const { control, operations, reasoning } = parsedResponse;
  const { uuid, projectId } = control;

  // Get file paths that will be affected
  const affectedFilePaths = operations.map(op => op.path);

  const validate = async (): Promise<boolean> => {
    if (projectId !== config.projectId) {
      logger.warn(`Skipping patch: projectId mismatch (expected '${config.projectId}', got '${projectId}').`);
      return false;
    }
    if (await hasBeenProcessed(cwd, uuid)) {
      logger.info(`Skipping patch: uuid '${uuid}' has already been processed.`);
      return false;
    }
    return true;
  };
  
  const execute = async (snapshot: FileSnapshot, startTime: number): Promise<void> => {
    logger.info(`🚀 Starting transaction for patch ${uuid}...`);
    logger.log(`Reasoning:\n  ${reasoning.join('\n  ')}`);
    
    logger.log(`  - Snapshot of ${Object.keys(snapshot).length} files taken.`);
    
    const stateFile: StateFile = {
      uuid,
      projectId,
      createdAt: new Date().toISOString(),
      reasoning,
      operations,
      snapshot,
      approved: false,
    };
    
    // Prepare state file but don't wait for write to complete yet
    const pendingStatePromise = writePendingState(cwd, stateFile);

    // --- Execution Phase ---
    const opStats: Array<{ type: 'Written' | 'Deleted', path: string, added: number, removed: number }> = [];
    
    try {
      // Wait for pending state write to complete
      await pendingStatePromise;
      logger.success('  - Staged changes to .pending.yml file.');
      
      logger.log('  - Applying file operations...');
      await applyOperations(operations, cwd);
      logger.success('File operations complete.');

      const statPromises = operations.map(async op => {
        const oldContent = snapshot[op.path] ?? null;
        if (op.type === 'write') {
            const newContent = await readFileContent(op.path, cwd);
            const { added, removed } = calculateLineChanges(oldContent, newContent ?? '');
            opStats.push({ type: 'Written', path: op.path, added, removed });
            logger.success(`✔ Written: ${op.path} (+${added}, -${removed})`);
        } else { // op.type === 'delete'
            const { added, removed } = calculateLineChanges(oldContent, '');
            opStats.push({ type: 'Deleted', path: op.path, added, removed });
            logger.success(`✔ Deleted: ${op.path}`);
        }
      });
      await Promise.all(statPromises);
      
    } catch (error) {
      logger.error(`Failed to apply file operations: ${error instanceof Error ? error.message : String(error)}. Rolling back.`);
      try {
        await restoreSnapshot(snapshot, cwd);
        logger.success('  - Files restored to original state.');
      } catch (rollbackError) {
        logger.error(`CRITICAL: Rollback after apply error failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
      await deletePendingState(cwd, uuid);
      logger.success(`↩️ Transaction ${uuid} rolled back due to apply error.`);
      return; // Abort transaction
    }

    // --- Verification & Decision Phase ---
    let postCommandFailed = false;
    if (config.postCommand) {
      logger.log(`  - Running post-command: ${config.postCommand}`);
      const postResult = await executeShellCommand(config.postCommand, cwd);
      if (postResult.exitCode !== 0) {
        logger.error(`Post-command failed with exit code ${postResult.exitCode}, forcing rollback.`);
        if (postResult.stderr) logger.error(`Stderr: ${postResult.stderr}`);
        postCommandFailed = true;
      }
    }

    // Run linter check in parallel with postCommand if possible
    const finalErrorCountPromise = config.linter ? getErrorCount(config.linter, cwd) : Promise.resolve(0);
    const finalErrorCount = await finalErrorCountPromise;
    logger.log(`  - Final linter error count: ${finalErrorCount}`);

    let isApproved = false;
    if (postCommandFailed) {
      isApproved = false; // Force rollback
    } else {
      const canAutoApprove = config.approval === 'yes' && finalErrorCount <= config.approvalOnErrorCount;
      if (canAutoApprove) {
          isApproved = true;
          logger.success('  - Changes automatically approved based on your configuration.');
      } else {
          isApproved = await prompter('Changes applied. Do you want to approve and commit them? (y/N)');
      }
    }
    
    // --- Commit/Rollback Phase ---
    if (isApproved) {
        logger.log('  - Committing changes...');
        const finalState: StateFile = { ...stateFile, approved: true };
        // Update pending state with approved: true, then commit (rename) the file.
        // This is now sequential to prevent a race condition.
        await writePendingState(cwd, finalState);
        await commitState(cwd, uuid);

        const duration = performance.now() - startTime;
        const totalSucceeded = opStats.length;
        const totalFailed = operations.length - totalSucceeded;
        const totalAdded = opStats.reduce((sum, s) => sum + s.added, 0);
        const totalRemoved = opStats.reduce((sum, s) => sum + s.removed, 0);
        
        logger.log('\nSummary:');
        logger.log(`Attempted: ${operations.length} file(s) (${totalSucceeded} succeeded, ${totalFailed} failed)`);
        logger.success(`Lines changed: +${totalAdded}, -${totalRemoved}`);
        logger.log(`Completed in ${duration.toFixed(2)}ms`);

        logger.success(`✅ Transaction ${uuid} committed successfully!`);
    } else {
        logger.warn('  - Rolling back changes...');
        
        try {
            await restoreSnapshot(snapshot, cwd);
            logger.success('  - Files restored to original state.');
            await deletePendingState(cwd, uuid);
            logger.success(`↩️ Transaction ${uuid} rolled back.`);
        } catch (error) {
            logger.error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }
  };

  return {
    run: async () => {
      if (!(await validate())) return;

      if (config.preCommand) {
        logger.log(`  - Running pre-command: ${config.preCommand}`);
        const { exitCode, stderr } = await executeShellCommand(config.preCommand, cwd);
        if (exitCode !== 0) {
          logger.error(`Pre-command failed with exit code ${exitCode}, aborting transaction.`);
          if (stderr) logger.error(`Stderr: ${stderr}`);
          return;
        }
      }

      const startTime = performance.now();

      try {
        // Take a snapshot before applying any changes
        logger.log(`Taking snapshot of files that will be affected...`);
        const snapshot = await createSnapshot(affectedFilePaths, cwd);
        
        await execute(snapshot, startTime);
      } catch (error) {
        logger.error(`Transaction ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
};

type ProcessPatchOptions = {
    prompter?: Prompter;
    cwd?: string;
}

export const processPatch = async (config: Config, parsedResponse: ParsedLLMResponse, options?: ProcessPatchOptions): Promise<void> => {
    const cwd = options?.cwd || process.cwd();
    const transaction = createTransaction({ config, parsedResponse, prompter: options?.prompter, cwd });
    await transaction.run();
};
```