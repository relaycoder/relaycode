#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init';
import { watchCommand } from './commands/watch';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import fs from 'node:fs';

// Default version in case we can't find the package.json
let version = '0.0.0';

try {
  // Try multiple strategies to find the package.json
  const require = createRequire(import.meta.url);
  let pkg;
  
  // Strategy 1: Try to find package.json relative to the current file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // Try different possible locations
  const possiblePaths = [
    join(__dirname, 'package.json'),
    join(__dirname, '..', 'package.json'),
    join(__dirname, '..', '..', 'package.json'),
    resolve(process.cwd(), 'package.json')
  ];
  
  let foundPath = null;
  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      foundPath = path;
      pkg = require(path);
      break;
    }
  }
  
  // Strategy 2: If we still don't have it, try to get it from the npm package name
  if (!pkg) {
    try {
      pkg = require('relaycode/package.json');
    } catch (e) {
      // Ignore this error
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
  .name('relay')
  .version(version)
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