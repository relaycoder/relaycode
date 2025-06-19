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
  for (const filePath of filePaths) {
    try {
      const absolutePath = path.resolve(cwd, filePath);
      try {
        const content = await fs.readFile(absolutePath, 'utf-8');
        snapshot[filePath] = content;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          snapshot[filePath] = null; // File doesn't exist, which is fine.
        } else {
          throw error;
        }
      }
    } catch (error) {
      console.error(`Error creating snapshot for ${filePath}:`, error);
      throw error;
    }
  }
  return snapshot;
};

export const applyOperations = async (operations: FileOperation[], cwd: string = process.cwd()): Promise<void> => {
  for (const op of operations) {
    if (op.type === 'delete') {
      await deleteFile(op.path, cwd);
    } else { // op.type === 'write'
      await writeFileContent(op.path, op.content, cwd);
    }
  }
};

export const restoreSnapshot = async (snapshot: FileSnapshot, cwd: string = process.cwd()): Promise<void> => {
  const projectRoot = path.resolve(cwd);

  for (const [filePath, content] of Object.entries(snapshot)) {
    const fullPath = path.resolve(cwd, filePath);
    try {
      if (content === null) {
        // If the file didn't exist in the snapshot, make sure it doesn't exist after restore
        try {
          await fs.unlink(fullPath);
          // After deleting a file that was newly created, try to clean up empty parent directories.
          let parentDir = path.dirname(fullPath);
          // Keep traversing up until we hit the project root or a non-empty directory
          while (parentDir.startsWith(projectRoot) && parentDir !== projectRoot) {
            const files = await fs.readdir(parentDir);
            if (files.length === 0) {
              await fs.rmdir(parentDir);
              parentDir = path.dirname(parentDir);
            } else {
              break; // Stop if directory is not empty
            }
          }
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
};