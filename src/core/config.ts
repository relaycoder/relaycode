import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { build } from 'esbuild';
import os from 'os';
import { createRequire } from 'module';
import { Config, ConfigSchema, RelayCodeConfigInput } from '../types';
import { CONFIG_FILE_NAMES, STATE_DIRECTORY_NAME, CONFIG_FILE_NAME_TS } from '../utils/constants';
import { logger, isEnoentError } from '../utils/logger';
import chalk from 'chalk';

export const findConfigPath = async (cwd: string = process.cwd()): Promise<string | null> => {
  for (const fileName of CONFIG_FILE_NAMES) {
    const configPath = path.join(cwd, fileName);
    try {
      await fs.access(configPath);
      return configPath;
    } catch (error) {
      if (!isEnoentError(error)) {
        // ignore other errors for now to keep searching
      }
    }
  }
  return null;
};

interface ConfigModule {
  default: RelayCodeConfigInput;
}

const loadModuleConfig = async (configPath: string): Promise<RelayCodeConfigInput> => {
  let importPath = configPath;
  let tempDir: string | null = null;

  if (configPath.endsWith('.ts')) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relaycode-'));
    const tempFile = path.join(tempDir, 'relaycode.config.mjs');

    const buildOptions: Parameters<typeof build>[0] = {
      entryPoints: [configPath],
      outfile: tempFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
    };

    // To handle `import { ... } from 'relaycode'` in user configs, we need to tell esbuild where to find it.
    // When running in dev, we point it to our local `src/index.ts`.
    // When running as an installed package, we use `require.resolve` to find the installed package's entry point.
    // This ensures esbuild bundles our library into the temporary config file, making it self-contained.
    if (import.meta.url.includes('/src/')) {
        buildOptions.alias = {
            'relaycode': path.resolve(process.cwd(), 'src/index.ts')
        }
    } else {
        const require = createRequire(import.meta.url);
        try {
            const resolvedPath = require.resolve('relaycode');
            buildOptions.alias = { 'relaycode': resolvedPath };
        } catch (e) {
            // This is a fallback in case resolution fails, though it's unlikely.
            // Revert to the previous behavior that caused the bug, but warn the user.
            logger.warn("Could not resolve the 'relaycode' package. The config file may fail to load.");
            buildOptions.external = ['relaycode'];
        }
    }
    
    await build(buildOptions);
    importPath = tempFile;
  }

  try {
    // Dynamically import the module. The cache-busting `?t=` is important for reloads.
    const module: ConfigModule = await import(`${importPath}?t=${Date.now()}`);
    return module.default;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
};

export const findConfig = async (cwd: string = process.cwd()): Promise<Config | null> => {
  const configPath = await findConfigPath(cwd);
  if (!configPath) {
    return null;
  }
  try {
    let configJson: RelayCodeConfigInput;
    if (configPath.endsWith('.json')) { // Handle JSON config
      const fileContent = await fs.readFile(configPath, 'utf-8');
      configJson = JSON.parse(fileContent);
    } else { // Handle .ts or .js config
      configJson = await loadModuleConfig(configPath);
    }
    return ConfigSchema.parse(configJson);
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid configuration in ${path.basename(configPath)}: ${error.message}`);
    }
    throw error;
  }
};

export const loadConfigOrExit = async (cwd: string = process.cwd()): Promise<Config> => {
  const config = await findConfig(cwd);
  if (!config) {
    logger.error(`Configuration file ('${chalk.cyan('relaycode.config.ts')}', '.js', or '.json') not found.`);
    logger.info(`Please run ${chalk.magenta("'relay init'")} to create one.`);
    process.exit(1);
  }
  return config;
};

export const createConfig = async (projectId: string, cwd: string = process.cwd()): Promise<Config> => {
  const config: RelayCodeConfigInput = { projectId };

  // Ensure the schema defaults are applied for nested objects
  const validatedConfig = ConfigSchema.parse(config);

  const tsConfigContent = `import { defineConfig } from 'relaycode';

export default defineConfig(${JSON.stringify({ projectId }, null, 2)});
`;

  const configPath = path.join(cwd, CONFIG_FILE_NAME_TS);
  await fs.writeFile(configPath, tsConfigContent);

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
