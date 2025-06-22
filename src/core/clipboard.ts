import clipboardy from 'clipboardy';
import { logger, getErrorMessage } from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

type ClipboardCallback = (content: string) => void;
type ClipboardReader = () => Promise<string>;


// Direct Windows clipboard reader that uses the executable directly
const createDirectWindowsClipboardReader = (): ClipboardReader => {
  return () => new Promise((resolve) => {
    try {
      const localExePath = path.join(process.cwd(), 'fallbacks', 'windows', 'clipboard_x86_64.exe');
      if (!fs.existsSync(localExePath)) {
        logger.error('Windows clipboard executable not found. Cannot watch clipboard on Windows.');
        // Resolve with empty string to avoid stopping the watcher loop, but log an error.
        return resolve('');
      }
      
      const command = `"${localExePath}" --paste`;
      
      exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          // It's common for the clipboard executable to fail if the clipboard is empty
          // or contains non-text data (e.g., an image). We can treat this as "no content".
          // We don't log this as an error to avoid spamming the console during normal use.
          logger.debug(`Windows clipboard read command failed (this is often normal): ${stderr.trim()}`);
          resolve('');
        } else {
          resolve(stdout);
        }
      });
    } catch (syncError) {
      // Catch synchronous errors during setup (e.g., path issues).
      logger.error(`A synchronous error occurred while setting up clipboard reader: ${getErrorMessage(syncError)}`);
      resolve('');
    }
  });
};

// Check if the clipboard executable exists and fix path issues on Windows
const ensureClipboardExecutable = () => {
  if (process.platform === 'win32') {
    try {
      // Try to find clipboard executables in common locations
      const possiblePaths = [
        // Global installation path
        path.join(process.env.HOME || '', '.bun', 'install', 'global', 'node_modules', 'relaycode', 'fallbacks', 'windows'),
        // Local installation paths
        path.join(process.cwd(), 'node_modules', 'clipboardy', 'fallbacks', 'windows'),
        path.join(process.cwd(), 'fallbacks', 'windows')
      ];
      
      // Create fallbacks directory in the current project if it doesn't exist
      const localFallbacksDir = path.join(process.cwd(), 'fallbacks', 'windows');
      if (!fs.existsSync(localFallbacksDir)) {
        fs.mkdirSync(localFallbacksDir, { recursive: true });
      }
      
      // Find an existing executable
      let sourceExePath = null;
      for (const dir of possiblePaths) {
        const exePath = path.join(dir, 'clipboard_x86_64.exe');
        if (fs.existsSync(exePath)) {
          sourceExePath = exePath;
          break;
        }
      }
      
      // Copy the executable to the local fallbacks directory if found
      if (sourceExePath && sourceExePath !== path.join(localFallbacksDir, 'clipboard_x86_64.exe')) {
        fs.copyFileSync(sourceExePath, path.join(localFallbacksDir, 'clipboard_x86_64.exe'));
        logger.info('Copied Windows clipboard executable to local fallbacks directory');
      } else if (!sourceExePath) {
        logger.error('Windows clipboard executable not found in any location');
      }
    } catch (error) {
      logger.warn('Error ensuring clipboard executable: ' + getErrorMessage(error));
    }
  }
};

export const createClipboardWatcher = (
  pollInterval: number,
  callback: ClipboardCallback,
  reader?: ClipboardReader,
) => {
  // Ensure clipboard executable exists before starting
  ensureClipboardExecutable();
  
  // On Windows, use the direct Windows reader
  // Otherwise use the provided reader or clipboardy
  const clipboardReader = process.platform === 'win32' ? 
    createDirectWindowsClipboardReader() : 
    reader || clipboardy.read;
  
  let lastContent = '';
  let intervalId: NodeJS.Timeout | null = null;

  const checkClipboard = async () => {
    try {
      const content = await clipboardReader();
      if (content && content !== lastContent) {
        lastContent = content;
        callback(content);
      }
    } catch (error) {
      // It's common for clipboard access to fail occasionally (e.g., on VM focus change)
      // So we log a warning but don't stop the watcher.
      logger.warn('Could not read from clipboard: ' + getErrorMessage(error));
    }
  };

  const start = () => {
    if (intervalId) {
      return;
    }
    logger.info(`Starting clipboard watcher (polling every ${pollInterval}ms)`);
    // Immediately check once, then start the interval
    checkClipboard();
    intervalId = setInterval(checkClipboard, pollInterval);
  };

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
      logger.info('Clipboard watcher stopped.');
    }
  };

  start();
  
  return { stop };
};