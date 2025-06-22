import { spawn } from 'child_process';
import path from 'path';
import { logger } from './logger';

type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const executeShellCommand = (command: string, cwd = process.cwd()): Promise<ExecutionResult> => {
  if (!command || command.trim() === '') {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  const normalizedCwd = path.resolve(cwd);

  return new Promise((resolve) => {
    logger.debug(`Executing command: ${command} in directory: ${normalizedCwd}`);
    
    const child = spawn(command, {
      cwd: normalizedCwd,
      shell: true, // Use shell to interpret the command (e.g., cmd.exe on Windows, /bin/sh on Linux)
      stdio: ['ignore', 'pipe', 'pipe'], // stdin, stdout, stderr
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });

    child.on('error', (err) => {
      // e.g., command not found
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
      });
    });
  });
};

export const getErrorCount = async (linterCommand: string, cwd = process.cwd()): Promise<number> => {
  if (!linterCommand || linterCommand.trim() === '') {
    return 0;
  }
  
  const { exitCode, stderr } = await executeShellCommand(linterCommand, cwd);
  if (exitCode === 0) return 0;

  // Try to extract a number of errors from stderr or assume 1 if non-zero exit code
  const errorMatches = stderr.match(/(\d+) error/i);
  if (errorMatches && errorMatches[1]) {
    return parseInt(errorMatches[1], 10);
  }
  return exitCode === 0 ? 0 : 1;
};