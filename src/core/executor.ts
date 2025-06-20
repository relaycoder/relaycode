import { promises as fs } from 'fs';
import path from 'path';
import { FileOperation, FileSnapshot } from '../types';

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
  // Apply operations in parallel
  await Promise.all(operations.map(op => {
    if (op.type === 'delete') {
      return deleteFile(op.path, cwd);
    } else { // op.type === 'write'
      return writeFileContent(op.path, op.content, cwd);
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