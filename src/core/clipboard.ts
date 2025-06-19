import clipboardy from 'clipboardy';
import { logger } from '../utils/logger';

type ClipboardCallback = (content: string) => void;

export const createClipboardWatcher = (pollInterval: number, callback: ClipboardCallback) => {
  let lastContent = '';

  const checkClipboard = async () => {
    try {
      const currentContent = await clipboardy.read();
      if (currentContent && currentContent !== lastContent) {
        lastContent = currentContent;
        callback(currentContent);
      }
    } catch (error) {
      // It's common for clipboard access to fail occasionally (e.g., on VM focus change)
      // So we log a warning but don't stop the watcher.
      logger.warn('Could not read from clipboard.');
    }
  };

  const start = () => {
    logger.info(`Watching clipboard every ${pollInterval}ms...`);
    // The setInterval itself will keep the process alive.
    setInterval(checkClipboard, pollInterval);
  };

  return { start };
};