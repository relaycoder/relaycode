Of course, I can help with that. Here are the changes to prepare your project for publishing to npm, making it both a usable CLI tool and an importable library.

I've structured the project to have a clear separation between the library and the command-line interface. This includes creating a new entry point for programmatic usage, updating your build configuration, and enriching your `package.json` for publishing.

Here are the code modifications:

```typescript // package.json
{
  "name": "relaycode",
  "version": "1.0.1",
  "description": "A developer assistant that automates applying code changes from LLMs.",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "relay": "./dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "clean": "rm -rf dist",
    "build": "bun run clean && bun tsc",
    "test": "bun test",
    "dev": "bun run src/cli.ts",
    "prepublishOnly": "bun run build"
  },
  "dependencies": {
    "chalk": "^5.3.0",
    "clipboardy": "^4.0.0",
    "commander": "^12.0.0",
    "diff-apply": "^1.0.0",
    "js-yaml": "^4.1.0",
    "toasted-notifier": "^10.1.0",
    "uuid": "^9.0.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "@types/js-yaml": "^4.0.9",
    "@types/uuid": "^9.0.8",
    "typescript": "^5.0.0"
  },
  "keywords": [
    "ai",
    "llm",
    "automation",
    "codegen",
    "developer-tool",
    "cli"
  ],
  "author": "Relay Code",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/relay-code/relay-code.git"
  },
  "homepage": "https://relay.code"
}
```

```typescript // src/cli.ts
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
```

```typescript // src/index.ts
// Core logic
export { createClipboardWatcher } from './core/clipboard';
export { findConfig, createConfig, getProjectId, ensureStateDirExists } from './core/config';
export { 
    applyOperations, 
    createSnapshot, 
    deleteFile, 
    readFileContent, 
    restoreSnapshot, 
    writeFileContent 
} from './core/executor';
export { parseLLMResponse } from './core/parser';
export { 
    commitState,
    deletePendingState,
    hasBeenProcessed,
    writePendingState
} from './core/state';
export { processPatch } from './core/transaction';

// Types
export * from './types';

// Utils
export { executeShellCommand, getErrorCount } from './utils/shell';
export { logger } from './utils/logger';
export { getConfirmation } from './utils/prompt';
```

```typescript // tsconfig.json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "esnext",
    "lib": ["esnext"],
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noUncheckedIndexedAccess": true,
    "allowJs": true,
    "checkJs": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test", "**/*.test.ts"]
}
```