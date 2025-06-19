import { ShellCommandResult } from '../types';

export const executeShellCommand = async (command: string): Promise<ShellCommandResult> => {
  if (!command) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  
  const parts = command.split(' ');
  const proc = Bun.spawn(parts, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exitCode,
  ]);
  
  return { stdout, stderr, exitCode };
};

export const getErrorCount = async (linterCommand: string): Promise<number> => {
    if (!linterCommand) return 0;
    try {
        const { stderr, stdout } = await executeShellCommand(linterCommand);
        // A simple way to count errors. This could be made more sophisticated.
        // For `tsc --noEmit`, errors are usually on stderr.
        const output = stderr || stdout;
        const errorLines = output.split('\n').filter(line => line.includes('error TS')).length;
        return errorLines;
    } catch (e) {
        // If the command itself fails to run, treat as a high number of errors.
        return 999;
    }
};