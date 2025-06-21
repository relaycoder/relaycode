import { promises as fs } from 'fs';
import path from 'path';
import { findConfig } from '../core/config';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME } from '../utils/constants';

export const applyCommand = async (filePath: string): Promise<void> => {
    const cwd = process.cwd();

    const config = await findConfig(cwd);
    if (!config) {
        logger.error(`Configuration file '${CONFIG_FILE_NAME}' not found.`);
        logger.info("Please run 'relay init' to create one.");
        process.exit(1);
    }
    
    logger.setLevel(config.logLevel);

    let content: string;
    const absoluteFilePath = path.resolve(cwd, filePath);
    try {
        content = await fs.readFile(absoluteFilePath, 'utf-8');
        logger.info(`Reading patch from file: ${absoluteFilePath}`);
    } catch (error) {
        logger.error(`Failed to read patch file at '${absoluteFilePath}': ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    logger.info('Attempting to parse patch file...');
    const parsedResponse = parseLLMResponse(content);

    if (!parsedResponse) {
        logger.error('The content of the file is not a valid relaycode patch. Aborting.');
        return;
    }

    logger.success('Valid patch format detected. Processing...');
    await processPatch(config, parsedResponse, { cwd });
    logger.info('--------------------------------------------------');
};