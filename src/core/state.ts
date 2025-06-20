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
    // Read the pending state first to ensure we have the approved flag set correctly
    const pendingContent = await fs.readFile(pendingPath, 'utf8');
    const stateData = yaml.load(pendingContent) as StateFile;
    
    // Ensure approved flag is set to true
    const finalState: StateFile = { ...stateData, approved: true };
    const finalContent = yaml.dump(finalState);
    
    // Write directly to the committed path
    await fs.writeFile(committedPath, finalContent, 'utf8');
    
    // Then delete the pending file
    await fs.unlink(pendingPath);
  } catch (error) {
    // If an error occurs, try the old rename approach as fallback
    console.warn("Error in optimized commit process, falling back to rename:", error);
    try {
      await fs.rename(pendingPath, committedPath);
    } catch (renameError) {
      // If rename fails (e.g., across filesystems), fall back to copy+delete
      if (renameError instanceof Error && 'code' in renameError && renameError.code === 'EXDEV') {
        const content = await fs.readFile(pendingPath, 'utf8');
        await fs.writeFile(committedPath, content, 'utf8');
        await fs.unlink(pendingPath);
      } else {
        throw renameError;
      }
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