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