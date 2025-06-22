#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { watchCommand } from './commands/watch';
import { logCommand } from './commands/log';
import { COMMAND_NAME } from './utils/constants';
import { undoCommand } from './commands/undo';
import { revertCommand } from './commands/revert';
import { applyCommand } from './commands/apply';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Default version in case we can't find the package.json
let version = '0.0.0';

try {
  const require = createRequire(import.meta.url);
  let pkg;
  try {
    // This works when installed as a package
    pkg = require('relaycode/package.json');
  } catch (e) {
    // Fallback for local development
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      pkg = require(join(__dirname, '..', 'package.json'));
    } catch (e2) {
      // ignore
    }
  }
  
  if (pkg && pkg.version) {
    version = pkg.version;
  }
} catch (error) {
  // Fallback to default version if we can't find the package.json
  console.error('Warning: Could not determine package version', error);
}

const program = new Command();

program
  .name(COMMAND_NAME)
  .version(version)
  .description('A developer assistant that automates applying code changes from LLMs.');

const commands = [
  { name: 'init', alias: 'i', description: 'Initializes relaycode in the current project.', action: initCommand },
  { name: 'watch', alias: 'w', description: 'Starts watching the clipboard for code changes to apply.', action: () => { watchCommand(); } },
  { name: 'apply', alias: 'a', description: 'Applies a patch from a specified file.', args: { syntax: '<filePath>', description: 'The path to the file containing the patch.' }, action: applyCommand },
  { name: 'log', alias: 'l', description: 'Displays a log of all committed transactions.', action: logCommand },
  { name: 'undo', alias: 'u', description: 'Reverts the last successfully committed transaction.', action: undoCommand },
  { name: 'revert', alias: 'r', description: 'Reverts a committed transaction by its UUID.', args: { syntax: '<uuid>', description: 'The UUID of the transaction to revert.' }, action: revertCommand },
];

commands.forEach(cmdInfo => {
  const command = program
    .command(cmdInfo.name)
    .alias(cmdInfo.alias)
    .description(cmdInfo.description);

  if (cmdInfo.args) {
    command.argument(cmdInfo.args.syntax, cmdInfo.args.description);
  }

  command.action(cmdInfo.action);
});

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}