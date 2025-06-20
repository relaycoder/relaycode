import clipboardy from 'clipboardy';
import { logger } from '../utils/logger';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

type ClipboardCallback = (content: string) => void;
type ClipboardReader = () => Promise<string>;

// Custom clipboard reader that falls back to our local executable
const createFallbackClipboardReader = (): ClipboardReader => {
  return async () => {
    try {
      // Try the clipboardy module first
      return await clipboardy.read();
    } catch (error) {
      logger.warn('Clipboardy module failed, trying fallback executable');
      
      // Fall back to our local executable
      try {
        const localExePath = path.join(process.cwd(), 'fallbacks', 'windows', 'clipboard_x86_64.exe');
        if (fs.existsSync(localExePath)) {
          const result = execSync(`"${localExePath}" --paste`, { encoding: 'utf8' });
          return result;
        }
      } catch (fallbackError) {
        throw new Error(`Clipboard read failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      }
      
      // If we got here, both methods failed
      throw error;
    }
  };
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
      logger.warn('Error ensuring clipboard executable: ' + (error instanceof Error ? error.message : String(error)));
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
  
  // Use our fallback reader if on Windows, otherwise use the provided reader or clipboardy
  const clipboardReader = process.platform === 'win32' ? 
    createFallbackClipboardReader() : 
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
      logger.warn('Could not read from clipboard: ' + (error instanceof Error ? error.message : String(error)));
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