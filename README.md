# Relaycode: Your AI-Powered Coding Assistant

**Relaycode is a powerful developer assistant that bridges the gap between Large Language Models (LLMs) and your local development environment. It listens for code modification instructions copied to your clipboard, parses them, and applies them to your codebase in a safe, transactional, and interactive way.**

Think of it as an automated pair programmer. You ask your LLM to perform a task (e.g., "refactor this component," "add a new feature," "fix this bug"), copy its response, and `relaycode` handles the file operations, linting, and validation, giving you the final say before committing the changes.

![Relaycode Demo GIF (Conceptual)](https://user-images.githubusercontent.com/10x-engineer/relaycode/main/assets/relaycode-demo.gif)
*(Note: This is a conceptual animation)*

---

## Table of Contents

1.  [The Problem Relaycode Solves](#the-problem-relaycode-solves)
2.  [Core Concepts](#core-concepts)
3.  [Getting Started](#getting-started)
    *   [Prerequisites](#prerequisites)
    *   [Installation](#installation)
    *   [Initialization](#initialization)
    *   [Running the Watcher](#running-the-watcher)
4.  [Configuring Your LLM](#configuring-your-llm-critical-step)
    *   [The System Prompt](#the-system-prompt)
    *   [File Operation Syntax](#file-operation-syntax)
    *   [Patch Strategies: The Heart of Relaycode](#patch-strategies-the-heart-of-relaycode)
        *   [Strategy 1: `replace` (Default)](#strategy-1-replace-default)
        *   [Strategy 2: `new-unified` (Recommended for Edits)](#strategy-2-new-unified-recommended-for-edits)
        *   [Strategy 3: `multi-search-replace` (For Precision)](#strategy-3-multi-search-replace-for-precision)
    *   [Creating and Deleting Files](#creating-and-deleting-files)
    *   [The Final YAML Block](#the-final-yaml-block)
5.  [Command-Line Interface (CLI)](#command-line-interface-cli)
    *   [`relay init`](#relay-init)
    *   [`relay watch`](#relay-watch)
6.  [Configuration File (`relaycode.config.json`)](#configuration-file-relaycodeconfigjson)
7.  [How It Works: The Transaction Lifecycle](#how-it-works-the-transaction-lifecycle)
8.  [Best Practices & Advanced Usage](#best-practices--advanced-usage)
9.  [Troubleshooting](#troubleshooting)
10. [Contributing](#contributing)
11. [License](#license)

---

## The Problem Relaycode Solves

LLMs are incredibly proficient at generating code, but integrating that code into an existing project is often a tedious and error-prone process. Developers are stuck in a loop of:
1.  Pasting code from the LLM into their editor.
2.  Manually creating new files.
3.  Finding the correct location to insert or replace code.
4.  Deleting old files.
5.  Running linters and formatters to fix style issues.
6.  Running tests to ensure nothing broke.

This manual process is slow and distracting. Relaycode automates this entire workflow, allowing you to stay focused on the high-level task while your AI assistant handles the "grunt work" of file manipulation.

---

## Core Concepts

Relaycode is built around a few simple but powerful ideas:

*   **Clipboard-Driven Workflow**: The clipboard is the universal interface. Any text you copy is a potential command for Relaycode.
*   **Structured Format**: Relaycode expects the LLM's response to be in a specific format containing markdown code blocks and a final YAML block. This structure allows for unambiguous parsing of file operations.
*   **Transactional Integrity**: Every set of changes is treated as a single transaction. If any part of the process fails (e.g., a linter error, a failed command, or manual rejection), the entire set of changes is rolled back, leaving your codebase in its original state. Nothing is committed until it's approved.
*   **Safety First**: Relaycode creates a snapshot of all affected files before touching them. This guarantees a perfect rollback if anything goes wrong.
*   **Interactive Approval**: You are always in control. Relaycode can be configured to automatically apply changes that pass all checks, or it can prompt you for final approval before committing the transaction.

---

## Getting Started

### Prerequisites

*   **Node.js & Bun**: Relaycode is a Bun-based project. You'll need [Bun](https://bun.sh/) installed on your system.
*   **LLM Assistant**: Access to an LLM that supports custom instructions or system prompts (e.g., ChatGPT with GPT-4, Claude, etc.).

### Installation

Install Relaycode globally using Bun:

```bash
bun install -g relaycode
```

### Initialization

Navigate to the root directory of your project and run:

```bash
relay init
```

This command performs several crucial actions:
1.  **Identifies Project ID**: It determines a unique `projectId` for your project (usually from `package.json`'s `name` field or the directory name).
2.  **Creates `relaycode.config.json`**: It generates a configuration file with sensible defaults.
3.  **Creates `.relaycode` Directory**: This hidden directory is used to store state files for all transactions.
4.  **Updates `.gitignore`**: It ensures the `.relaycode` directory is ignored by Git.
5.  **Displays the System Prompt**: Most importantly, it prints a detailed system prompt that you **must** copy and paste into your LLM's custom instructions.

### Running the Watcher

Once initialized, start the Relaycode watcher in your terminal:

```bash
relay watch
```

Relaycode will now monitor your clipboard. When it detects content that matches its expected format, it will spring into action.

---

## Configuring Your LLM (Critical Step)

For Relaycode to work, your LLM must be instructed to format its responses correctly. The `relay init` command provides the necessary text. Paste this into the "System Prompt," "Custom Instructions," or equivalent configuration area of your AI assistant.

### The System Prompt

The system prompt teaches the LLM its new role as an AI programmer that interacts with your local file system via a structured text format. It defines the syntax for file paths, patch strategies, and the required final YAML block.

### File Operation Syntax

The core of the format is the markdown code block, which is overloaded with a file path and an optional patch strategy.

**Syntax:**
```typescript // {filePath} {patchStrategy}
... file content or diff ...
```

*   `filePath`: The relative path to the file from your project root. **If the path contains spaces, it MUST be enclosed in double quotes.**
*   `patchStrategy`: (Optional) Defines *how* the content should be applied. Can be `replace`, `new-unified`, or `multi-search-replace`. If omitted, it defaults to `replace`.

### Patch Strategies: The Heart of Relaycode

Choosing the right patch strategy is key to getting the best results from your LLM.

#### Strategy 1: `replace` (Default)

This is the simplest strategy. It completely replaces the entire content of the specified file with the content inside the code block.

*   **When to use it**:
    *   Creating a new file.
    *   Completely overwriting an existing file when the changes are extensive.
*   **Example (Creating a new file)**:
    ```typescript // src/components/Welcome.tsx
    import React from 'react';

    const Welcome = () => {
      return <h1>Hello, Relaycode!</h1>;
    };

    export default Welcome;
    ```

#### Strategy 2: `new-unified` (Recommended for Edits)

This strategy uses an advanced fuzzy diffing algorithm to apply changes. It's highly resilient to minor variations between the LLM's context and your actual file content (e.g., small bug fixes you made since you last copied the code).

The format is a standard unified diff.

*   **When to use it**:
    *   Refactoring code.
    *   Adding or removing functions, properties, or logic.
    *   Fixing bugs.
    *   Most day-to-day editing tasks.
*   **Diff Format**:
    *   Lines starting with `+` are added.
    *   Lines starting with `-` are removed.
    *   Lines starting with a space are for context and are essential for finding the correct location to apply the patch.
*   **Example (Adding a feature)**:
    ```diff // src/utils.ts new-unified
    --- src/utils.ts
    +++ src/utils.ts
    @@ ... @@
        function calculateTotal(items: number[]): number {
    -      return items.reduce((sum, item) => sum + item, 0);
    +      // Add 10% tax
    +      const total = items.reduce((sum, item) => sum + item, 0);
    +      return total * 1.1;
    +    }
    ```

#### Strategy 3: `multi-search-replace` (For Precision)

This strategy performs one or more exact search-and-replace operations within a file. It is powerful for surgical changes across multiple locations but requires the `SEARCH` block to be a perfect, character-for-character match of the text in the file.

*   **When to use it**:
    *   Renaming a variable in a few specific places.
    *   Updating import paths.
    *   When you need absolute precision and the `new-unified` diff is too broad.
*   **Diff Format**:
    Repeat this block for each replacement.
    ```diff
    <<<<<<< SEARCH
    // The exact string to find
    =======
    // The new string to replace it with
    >>>>>>> REPLACE
    ```
*   **Example (Renaming a function call)**:
    ```diff // src/app.ts multi-search-replace
    <<<<<<< SEARCH
    const result = oldCalculateFunction(data);
    =======
    const result = newCalculateFunction(data);
    >>>>>>> REPLACE
    ```

### Creating and Deleting Files

*   **Creating a File**: Use the default `replace` strategy. Just provide the file path and the full content.
*   **Deleting a File**: Use a special marker inside the code block.
    ```typescript // path/to/old-file.ts
    //TODO: delete this file
    ```

### The Final YAML Block

Every response from the LLM **must** end with a YAML block. This block acts as a control record for the transaction.

```yaml
projectId: your-project-name
uuid: (generate a random uuid)
changeSummary:
  - edit: src/main.ts
  - new: src/components/Button.tsx
  - delete: src/utils/old-helper.ts
```

*   `projectId`: Must match the `projectId` in your `relaycode.config.json`. This prevents accidentally applying a patch meant for another project.
*   `uuid`: A unique identifier for this transaction. Relaycode uses this to prevent re-processing the same patch. The LLM should generate a new UUID for every response.
*   `changeSummary`: A human-readable summary of the changes. (Currently for informational purposes).

---

## Command-Line Interface (CLI)

### `relay init`

Initializes Relaycode in the current project directory. See the [Initialization](#initialization) section for details.

### `relay watch`

Starts the clipboard watcher. It runs continuously, waiting for a valid Relaycode patch to appear on the clipboard. It takes no arguments and uses the `relaycode.config.json` file in the current directory.

---

## Configuration File (`relaycode.config.json`)

This file, created by `relay init`, controls the behavior of the `watch` command.

```json
{
  "projectId": "my-cool-app",
  "clipboardPollInterval": 2000,
  "approval": "yes",
  "approvalOnErrorCount": 0,
  "linter": "bun tsc --noEmit",
  "preCommand": "",
  "postCommand": "bunx prettier --write ."
}
```

*   `projectId` (string): A unique identifier for your project.
*   `clipboardPollInterval` (number): The frequency in milliseconds at which to check the clipboard for new content. Default: `2000`.
*   `approval` (enum: `"yes"` | `"no"`):
    *   `"yes"`: Relaycode will try to automatically approve transactions if the `linter` command passes (or returns an error count within the `approvalOnErrorCount` threshold).
    *   `"no"`: Relaycode will *always* ask for manual confirmation before committing changes, regardless of the linter result.
*   `approvalOnErrorCount` (number): If `approval` is `"yes"`, Relaycode will still auto-approve if the number of errors reported by the `linter` is less than or equal to this value. Default: `0`.
*   `linter` (string): The shell command to run to check for errors after applying the patch. Relaycode checks its exit code and tries to parse an error count from its output. An empty string (`""`) disables linting.
*   `preCommand` (string): A shell command to run *before* the transaction begins (e.g., `bun install` if the LLM might add a new dependency). If this command fails, the transaction is aborted.
*   `postCommand` (string): A shell command to run *after* the patch is applied but *before* the linter runs (e.g., a code formatter like `bunx prettier --write .`). If this command fails, the transaction is rolled back.

---

## How It Works: The Transaction Lifecycle

When you copy a valid patch, Relaycode executes the following sequence:

1.  **Detect & Parse**: The `watch` command detects new clipboard content and parses it, extracting the file operations and the control YAML.
2.  **Validate**: It checks if the `projectId` matches and if the `uuid` has been processed before.
3.  **Run `preCommand`**: Executes the pre-command, if defined.
4.  **Create Snapshot**: It reads the current content of all affected files and stores them in memory. This is the rollback point.
5.  **Write Pending State**: A `{uuid}.pending.yml` file is written to the `.relaycode` directory, recording the intended operations and the snapshot.
6.  **Apply Operations**: The file modifications (write, delete, patch) are executed on your file system.
7.  **Run `postCommand`**: Executes the post-command, if defined.
8.  **Run Linter**: Executes the linter command, if defined, and counts any errors.
9.  **Request Approval**: Based on the `approval` config and linter results, it either auto-approves or prompts for manual approval (`y/N`).
10. **Commit or Rollback**:
    *   **On Approval**: The `.pending.yml` file is renamed to `{uuid}.yml`, atomically committing the transaction. A success notification is sent.
    *   **On Rejection or Error**: The in-memory snapshot is used to restore all files to their original state. The `.pending.yml` file is deleted. A failure notification is sent.

---

## Best Practices & Advanced Usage

*   **Be Specific in Prompts**: The more context you give your LLM, the better the patch will be. Instead of "fix the button," say "In `src/components/Button.tsx`, the `onClick` handler is not working. Please fix it and add a `data-testid` attribute for testing. Use the `new-unified` patch strategy."
*   **Use `preCommand` for Dependencies**: If you ask an LLM to add a new library, you can set `"preCommand": "bun install"` to ensure the dependency is available before the code that uses it is written.
*   **Use `postCommand` for Formatting**: Keep your code clean by using a formatter in the post-command, like `"postCommand": "bunx prettier --write ."`. This ensures the LLM's output always matches your project's code style.
*   **Start Small**: Begin with small, targeted changes. As you get more comfortable, you can give the LLM larger, more complex tasks involving multiple files.

---

## Troubleshooting

*   **Patch Not Detected**:
    *   Ensure the `relay watch` command is running.
    *   Check that the YAML block is present at the very end of the copied text and is formatted correctly.
    *   Verify the `projectId` in the YAML matches your config file.
*   **Changes Applied Incorrectly**:
    *   The patch strategy may have been inappropriate. For edits, `new-unified` is usually best. If it fails, `replace` with the full file content is a reliable fallback.
    *   The context provided to the LLM might have been out of date. Try re-copying the latest version of the file into your prompt.
*   **Rollback Failed**: This is rare but could happen if file permissions change during a transaction. The original content is still available in the `.pending.yml` file in the `.relaycode` directory for manual recovery.

---

## Contributing

We welcome contributions! Please feel free to open an issue or submit a pull request.

### Development Setup
1. Clone the repository.
2. Install dependencies: `bun install`
3. Run the development server: `bun run dev`
4. Run tests: `bun test`

---

## License

This project is licensed under the MIT License.

npm install -g .