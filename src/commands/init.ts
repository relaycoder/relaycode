import { promises as fs } from 'fs';
import path from 'path';
import { findConfig, createConfig, ensureStateDirExists, getProjectId } from '../core/config';
import { logger, getErrorMessage } from '../utils/logger';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../utils/constants';

const getInitMessage = (projectId: string): string => `
✅ relaycode has been initialized for this project.

Configuration file created: ${CONFIG_FILE_NAME}

Project ID: ${projectId}

Next steps:
1. (Optional) Open ${CONFIG_FILE_NAME} to customize settings like 'preferredStrategy' to control how the AI generates code patches.
   - 'auto' (default): The AI can choose the best patch strategy.
   - 'new-unified': Forces the AI to use diffs, great for most changes.
   - 'replace': Forces the AI to replace entire files, good for new files or small changes.
   - 'multi-search-replace': Forces the AI to perform precise search and replace operations.

2. Run 'relay watch' in your terminal. This will start the service and display the system prompt tailored to your configuration.

3. Copy the system prompt provided by 'relay watch' and paste it into your AI assistant's "System Prompt" or "Custom Instructions".
`;


const updateGitignore = async (cwd: string): Promise<void> => {
    const gitignorePath = path.join(cwd, GITIGNORE_FILE_NAME);
    const entry = `\n# relaycode state\n/${STATE_DIRECTORY_NAME}/\n`;

    try {
        let content = await fs.readFile(gitignorePath, 'utf-8');
        if (!content.includes(STATE_DIRECTORY_NAME)) {
            content += entry;
            await fs.writeFile(gitignorePath, content);
            logger.info(`Updated ${GITIGNORE_FILE_NAME} to ignore ${STATE_DIRECTORY_NAME}/`);
        }
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            await fs.writeFile(gitignorePath, entry.trim());
            logger.info(`Created ${GITIGNORE_FILE_NAME} and added ${STATE_DIRECTORY_NAME}/`);
        } else {
            logger.error(`Failed to update ${GITIGNORE_FILE_NAME}: ${getErrorMessage(error)}`);
        }
    }
};

export const initCommand = async (cwd: string = process.cwd()): Promise<void> => {
    logger.info('Initializing relaycode in this project...');

    const config = await findConfig(cwd);
    if (config) {
        logger.warn(`${CONFIG_FILE_NAME} already exists. Initialization skipped.`);
        logger.log(`
To use relaycode, please run 'relay watch'.
It will display a system prompt to copy into your LLM assistant.
You can review your configuration in ${CONFIG_FILE_NAME}.
`);
        return;
    }
    
    const projectId = await getProjectId(cwd);
    await createConfig(projectId, cwd);
    logger.success(`Created configuration file: ${CONFIG_FILE_NAME}`);
    
    await ensureStateDirExists(cwd);
    logger.success(`Created state directory: ${STATE_DIRECTORY_NAME}/`);

    await updateGitignore(cwd);

    logger.log(getInitMessage(projectId));
};