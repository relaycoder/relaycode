#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { watchCommand } from './commands/watch';

const program = new Command();

program
  .name('relay')
  .description('A developer assistant that automates applying code changes from LLMs.');

program
  .command('init')
  .description('Initializes relaycode in the current project.')
  .action(initCommand);

program
  .command('watch')
  .description('Starts watching the clipboard for code changes to apply.')
  .action(watchCommand);

program.parse(process.argv);

if (!process.argv.slice(2).length) {
    program.outputHelp();
}