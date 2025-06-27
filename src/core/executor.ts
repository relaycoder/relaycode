import path from 'path';
import { FileOperation, FileSnapshot } from '../types';
import { newUnifiedDiffStrategyService, multiSearchReplaceService, unifiedDiffService } from 'diff-apply';
import { getErrorMessage } from '../utils/logger';
import { deleteFile, readFileContent, removeEmptyParentDirectories, renameFile, writeFileContent } from '../utils/fs';

const patchStrategies = {
  'new-unified': (p: { originalContent: string; diffContent: string; }) => {
    const service = newUnifiedDiffStrategyService.newUnifiedDiffStrategyService.create(0.95);
    return service.applyDiff(p);
  },
  'multi-search-replace': (p: { originalContent: string; diffContent: string; }) => {
    return multiSearchReplaceService.multiSearchReplaceService.applyDiff(p);
  },
  'unified': (p: { originalContent: string; diffContent: string; }) => {
    return unifiedDiffService.unifiedDiffService.applyDiff(p.originalContent, p.diffContent);
  },
};

export const createSnapshot = async (filePaths: string[], cwd: string = process.cwd()): Promise<FileSnapshot> => {
  const snapshot: FileSnapshot = {};
  await Promise.all(
    filePaths.map(async (filePath) => {
      snapshot[filePath] = await readFileContent(filePath, cwd);
    })
  );
  return snapshot;
};

export const applyOperations = async (operations: FileOperation[], cwd: string = process.cwd()): Promise<Map<string, string>> => {
  const fileStates = new Map<string, string | null>();
  const newContents = new Map<string, string>();

  const getFileContent = async (filePath: string): Promise<string | null> => {
    if (fileStates.has(filePath)) {
      return fileStates.get(filePath) ?? null;
    }
    const content = await readFileContent(filePath, cwd);
    fileStates.set(filePath, content);
    return content;
  };

  // Operations must be applied sequentially to ensure that if one fails,
  // we can roll back from a known state.
  for (const op of operations) {
    if (op.type === 'delete') {
      await deleteFile(op.path, cwd);
      fileStates.set(op.path, null);
      continue;
    }
    if (op.type === 'rename') {
      const content = await getFileContent(op.from);
      await renameFile(op.from, op.to, cwd);
      fileStates.set(op.from, null);
      if (content !== null) {
        fileStates.set(op.to, content);
      }
      // Propagate the change to newContents map if the source file was modified in this transaction
      if (newContents.has(op.from)) {
        newContents.set(op.to, newContents.get(op.from)!);
        newContents.delete(op.from);
      }
      continue;
    }
    
    let finalContent: string;
    const currentContent = await getFileContent(op.path);

    if (op.patchStrategy === 'replace') {
      finalContent = op.content;
    } else {
      if (currentContent === null && op.patchStrategy === 'multi-search-replace') {
        throw new Error(`Cannot use 'multi-search-replace' on a new file: ${op.path}`);
      }

      try {
        const diffParams = {
          originalContent: currentContent ?? '',
          diffContent: op.content,
        };
        
        const patcher = patchStrategies[op.patchStrategy as keyof typeof patchStrategies];
        if (!patcher) {
          throw new Error(`Unknown patch strategy: '${op.patchStrategy}'`);
        }
        
        const result = await patcher(diffParams);
        if (result.success) {
          finalContent = result.content;
        } else {
          throw new Error(`Patch failed for ${op.path}: ${result.error}`);
        }
      } catch (e) {
        throw new Error(`Error applying patch for ${op.path} with strategy '${op.patchStrategy}': ${getErrorMessage(e)}`);
      }
    }
    
    await writeFileContent(op.path, finalContent, cwd);
    fileStates.set(op.path, finalContent);
    newContents.set(op.path, finalContent);
  }
  return newContents;
};

export const restoreSnapshot = async (snapshot: FileSnapshot, cwd: string = process.cwd()): Promise<void> => {
  const projectRoot = path.resolve(cwd);
  const entries = Object.entries(snapshot);
  const directoriesToClean = new Set<string>();
  const restoreErrors: { path: string, error: unknown }[] = [];

  // Attempt to restore all files in parallel, collecting errors.
  await Promise.all(entries.map(async ([filePath, content]) => {
      const fullPath = path.resolve(cwd, filePath);
      try {
        if (content === null) {
          // If the file didn't exist in the snapshot, make sure it doesn't exist after restore.
          await deleteFile(filePath, cwd);
          directoriesToClean.add(path.dirname(fullPath));
        } else {
          // Create directory structure if needed and write the original content back.
          await writeFileContent(filePath, content, cwd);
        }
      } catch (error) {
        restoreErrors.push({ path: filePath, error });
      }
  }));
  
  // After all files are processed, clean up empty directories
  // Sort directories by depth (deepest first) to clean up nested empty dirs properly
  const sortedDirs = Array.from(directoriesToClean)
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  
  // Process each directory that had files deleted
  for (const dir of sortedDirs) {
    await removeEmptyParentDirectories(dir, projectRoot);
  }

  if (restoreErrors.length > 0) {
    const errorSummary = restoreErrors
      .map(e => `  - ${e.path}: ${getErrorMessage(e.error)}`)
      .join('\n');
    throw new Error(`Rollback failed for ${restoreErrors.length} file(s):\n${errorSummary}`);
  }
};