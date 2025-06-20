import { exec } from 'child_process';
import path from 'path';

type ExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export const executeShellCommand = (command: string, cwd = process.cwd()): Promise<ExecutionResult> => {
  if (!command || command.trim() === '') {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  // Normalize path for Windows environments
  const normalizedCwd = path.resolve(cwd);

  return new Promise((resolve) => {
    // On Windows, make sure to use cmd.exe or PowerShell to execute command
    const isWindows = process.platform === 'win32';
    const finalCommand = isWindows 
      ? `powershell -Command "${command.replace(/"/g, '\\"')}"`
      : command;
      
    console.log(`Executing command: ${finalCommand} in directory: ${normalizedCwd}`);
    
    exec(finalCommand, { cwd: normalizedCwd }, (error, stdout, stderr) => {
      const exitCode = error ? error.code || 1 : 0;
      
      resolve({
        exitCode,
        stdout: stdout.toString().trim(),
        stderr: stderr.toString().trim(),
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