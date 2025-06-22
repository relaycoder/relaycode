import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';
import { newUnifiedDiffStrategyService, multiSearchReplaceService, unifiedDiffService } from 'diff-apply';
import { getErrorMessage, isEnoentError } from '../utils/logger';

export const readFileContent = async (filePath: string, cwd: string = process.cwd()): Promise<string | null> => {
  try {
    return await fs.readFile(path.resolve(cwd, filePath), 'utf-8');
  } catch (error) {
    if (isEnoentError(error)) {
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
    if (isEnoentError(error)) {
      // File already deleted, which is fine.
      return;
    }
    throw error;
  }
};

export const fileExists = async (filePath: string, cwd: string = process.cwd()): Promise<boolean> => {
  try {
    await fs.access(path.resolve(cwd, filePath));
    return true;
  } catch {
    return false;
  }
};

export const safeRename = async (fromPath: string, toPath:string): Promise<void> => {
    try {
        await fs.rename(fromPath, toPath);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EXDEV') {
            await fs.copyFile(fromPath, toPath);
            await fs.unlink(fromPath);
        } else {
            throw error;
        }
    }
};

export const renameFile = async (fromPath: string, toPath: string, cwd: string = process.cwd()): Promise<void> => {
  const fromAbsolutePath = path.resolve(cwd, fromPath);
  const toAbsolutePath = path.resolve(cwd, toPath);
  await fs.mkdir(path.dirname(toAbsolutePath), { recursive: true });
  await safeRename(fromAbsolutePath, toAbsolutePath);
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
        if (isEnoentError(error)) {
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
  // Operations must be applied sequentially to ensure that if one fails,
  // we can roll back from a known state.
  for (const op of operations) {
    if (op.type === 'delete') {
      await deleteFile(op.path, cwd);
      continue;
    }
    if (op.type === 'rename') {
      await renameFile(op.from, op.to, cwd);
      continue;
    } 
    
    if (op.patchStrategy === 'replace') {
      await writeFileContent(op.path, op.content, cwd);
      continue;
    }

    // For patch strategies, apply them sequentially
    const originalContent = await readFileContent(op.path, cwd);
    if (originalContent === null && op.patchStrategy === 'multi-search-replace') {
      throw new Error(`Cannot use 'multi-search-replace' on a new file: ${op.path}`);
    }

    try {
      const diffParams = {
        originalContent: originalContent ?? '',
        diffContent: op.content,
      };

      let result;
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
      throw new Error(`Error applying patch for ${op.path} with strategy ${op.patchStrategy}: ${getErrorMessage(e)}`);
    }
  }
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
      console.warn(`Failed to clean up directory ${dirPath}:`, getErrorMessage(error));
    }
  }
};

export const restoreSnapshot = async (snapshot: FileSnapshot, cwd: string = process.cwd()): Promise<void> => {
  const projectRoot = path.resolve(cwd);
  const entries = Object.entries(snapshot);
  const directoriesDeleted = new Set<string>();

  // Handle all file operations sequentially to ensure atomicity during rollback
  for (const [filePath, content] of entries) {
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
  }
  
  // After all files are processed, clean up empty directories
  // Sort directories by depth (deepest first) to clean up nested empty dirs properly
  const sortedDirs = Array.from(directoriesDeleted)
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  
  // Process each directory that had files deleted
  for (const dir of sortedDirs) {
    await removeEmptyParentDirectories(dir, projectRoot);
  }
};