import { promises as fs } from 'fs';
import path from 'path';
import { findConfig, createConfig, ensureStateDirExists, getProjectId } from '../core/config';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME, STATE_DIRECTORY_NAME, GITIGNORE_FILE_NAME } from '../utils/constants';

const getSystemPrompt = (projectId: string): string => `
✅ relaycode has been initialized for this project.

IMPORTANT: For relaycode to work, you must configure your AI assistant.
Copy the entire text below and paste it into your LLM's "System Prompt"
or "Custom Instructions" section.
---------------------------------------------------------------------------

Code changes rules 1-6:

1. Make sure to isolate every file's code block with:
    \`\`\`typescript // {filePath}
    // START

    {content}

    // END
    \`\`\`

2. Only write new or affected files. Ignore unaffected files in the codebase.

3. Always write the FULL source code for each file. Do not use placeholders or comments like "... rest of the code".

4. Add your step-by-step reasoning in plain text before each code block as you progress.

5. If you need to delete a file, use this exact format:
    \`\`\`typescript // {filePath}
    //TODO: delete this file
    \`\`\`

6. ALWAYS add the following YAML block at the very end of your response. Use the exact projectId shown here. Generate a new random uuid for each response.

    \`\`\`yaml
    projectId: ${projectId}
    uuid: (generate a random uuid)
    changeSummary:
      - edit: src/main.ts
      - new: src/components/Button.tsx
      - delete: src/utils/old-helper.ts
      - .... (so on)
    \`\`\`
---------------------------------------------------------------------------
You are now ready to run 'relay watch' in your terminal.
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
            logger.error(`Failed to update ${GITIGNORE_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
};

export const initCommand = async (cwd: string = process.cwd()): Promise<void> => {
    logger.info('Initializing relaycode in this project...');

    const existingConfig = await findConfig(cwd);
    if (existingConfig) {
        logger.warn(`${CONFIG_FILE_NAME} already exists. Initialization skipped.`);
        return;
    }
    
    const projectId = await getProjectId(cwd);
    await createConfig(projectId, cwd);
    logger.success(`Created configuration file: ${CONFIG_FILE_NAME}`);
    
    await ensureStateDirExists(cwd);
    logger.success(`Created state directory: ${STATE_DIRECTORY_NAME}/`);

    await updateGitignore(cwd);

    logger.log(getSystemPrompt(projectId));
};