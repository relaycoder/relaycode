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
    const config = {
        projectId,
        clipboardPollInterval: 2000,
        approval: 'yes' as const,
        approvalOnErrorCount: 0,
        linter: 'bun tsc --noEmit',
        preCommand: '',
        postCommand: '',
        preferredStrategy: 'auto' as const,
    };
    
    // Ensure the schema defaults are applied, including for logLevel
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