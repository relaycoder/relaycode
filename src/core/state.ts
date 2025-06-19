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