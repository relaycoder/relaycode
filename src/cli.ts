#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { watchCommand } from './commands/watch';
import { createRequire } from 'node:module';

// Use createRequire to safely import JSON in an ES module context
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const program = new Command();

program
  .name('relay')
  .version(pkg.version) // Add version from package.json
  .description('A developer assistant that automates applying code changes from LLMs.');

program
  .command('init')
  .description('Initializes relaycode in the current project.')
  .action(() => initCommand());

program
  .command('watch')
  .description('Starts watching the clipboard for code changes to apply.')
  .action(watchCommand);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}