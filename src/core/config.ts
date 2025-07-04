import { z } from 'zod';
import path from 'path';
import { promises as fs } from 'fs';
import { build } from 'esbuild';
import os from 'os';
import { createRequire } from 'module';
import { Config, ConfigSchema, RelayCodeConfigInput } from '../types';
import { CONFIG_FILE_NAMES, STATE_DIRECTORY_NAME, CONFIG_FILE_NAME_TS, TRANSACTIONS_DIRECTORY_NAME } from '../utils/constants';
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
    const tempFile = path.join(tempDir, 'relay.config.mjs');

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
            // This is a fallback in case resolution fails. With the package.json `exports` fix,
            // this is much less likely to be hit. We are removing the `external` option to prevent a crash.
            // If the user's config *does* import from 'relaycode', esbuild will now fail with a
            // clearer error message instead of the cryptic runtime error.
            logger.warn(`Could not resolve the 'relaycode' package. The config file may fail to load if it uses relaycode imports.`);
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
    logger.error(`Configuration file ('${chalk.cyan(CONFIG_FILE_NAME_TS)}', '.js', or '.json') not found.`);
    logger.info(`Please run ${chalk.magenta("'relay init'")} to create one.`);
    process.exit(1);
  }
  return config;
};

export const createConfig = async (projectId: string, cwd: string = process.cwd()): Promise<Config> => {
  const config: RelayCodeConfigInput = { projectId };

  // Ensure the schema defaults are applied for nested objects
  const validatedConfig = ConfigSchema.parse(config);

  const defaultConfig = ConfigSchema.parse({ projectId });

  const tsConfigContent = `import { defineConfig } from 'relaycode';

export default defineConfig({
  projectId: '${projectId}',
  core: {
    logLevel: '${defaultConfig.core.logLevel}',
    enableNotifications: ${defaultConfig.core.enableNotifications},
    watchConfig: ${defaultConfig.core.watchConfig},
  },
  watcher: {
    clipboardPollInterval: ${defaultConfig.watcher.clipboardPollInterval},
    preferredStrategy: '${defaultConfig.watcher.preferredStrategy}',
  },
  patch: {
    approvalMode: '${defaultConfig.patch.approvalMode}',
    approvalOnErrorCount: ${defaultConfig.patch.approvalOnErrorCount},
    linter: '${defaultConfig.patch.linter}',
    preCommand: '${defaultConfig.patch.preCommand}',
    postCommand: '${defaultConfig.patch.postCommand}',
    minFileChanges: ${defaultConfig.patch.minFileChanges}, // 0 means no minimum
    // maxFileChanges: 20, // Uncomment to set a maximum
  },
  git: {
    autoGitBranch: ${defaultConfig.git.autoGitBranch},
    gitBranchPrefix: '${defaultConfig.git.gitBranchPrefix}',
    gitBranchTemplate: '${defaultConfig.git.gitBranchTemplate}',
  },
});
`;

  const configPath = path.join(cwd, CONFIG_FILE_NAME_TS);
  await fs.writeFile(configPath, tsConfigContent);

  return validatedConfig;
};

export const ensureStateDirExists = async (cwd: string = process.cwd()): Promise<void> => {
  const stateDirPath = path.join(cwd, STATE_DIRECTORY_NAME);
  await fs.mkdir(stateDirPath, { recursive: true });
  
  // Also create the transactions subdirectory
  const transactionsDirPath = path.join(stateDirPath, TRANSACTIONS_DIRECTORY_NAME);
  await fs.mkdir(transactionsDirPath, { recursive: true });
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
