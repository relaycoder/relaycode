import chalk from 'chalk';
import { LogLevelName } from '../types';

const LogLevels = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
} as const;

let currentLogLevel: LogLevelName = 'info'; // Default level

export const logger = {
  setLevel: (level: LogLevelName) => {
    if (level in LogLevels) {
      currentLogLevel = level;
    }
  },
  info: (message: string) => {
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(chalk.blue(message));
    }
  },
  success: (message: string) => {
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(chalk.green(message));
    }
  },
  warn: (message: string) => {
    if (LogLevels.warn <= LogLevels[currentLogLevel]) {
      console.log(chalk.yellow(message));
    }
  },
  error: (message: string) => {
    if (LogLevels.error <= LogLevels[currentLogLevel]) {
      console.log(chalk.red(message));
    }
  },
  debug: (message: string) => {
    if (LogLevels.debug <= LogLevels[currentLogLevel]) {
      console.log(chalk.gray(message));
    }
  },
  log: (message: string) => {
    // General log, treat as info
    if (LogLevels.info <= LogLevels[currentLogLevel]) {
      console.log(message);
    }
  },
  prompt: (message: string) => {
    // Prompts are special and should be shown unless silent
    if (currentLogLevel !== 'silent') {
      console.log(chalk.cyan(message));
    }
  },
};