```typescript // specification.md
# Relaycode Specification

## 1. Introduction

Relaycode is a command-line developer assistant designed to automate the process of applying code changes suggested by Large Language Models (LLMs). It operates by monitoring the system clipboard for specially formatted text, which it then parses and applies to the local filesystem in a safe, transactional manner. This allows developers to seamlessly integrate AI-generated code patches into their workflow with confidence.

## 2. Core Features

-   **Clipboard-Driven Workflow**: Relaycode watches for code patches copied to the clipboard, making it model-agnostic and easy to integrate with any LLM interface.
-   **Transactional File Patching**: Changes are applied on an all-or-nothing basis. If any part of the process fails or is rejected, the entire set of changes is rolled back, leaving the project in its original state.
-   **Multiple Patch Strategies**: Supports various methods for applying changes, from full file replacement to precise, context-aware diffs.
-   **Built-in Validation and Approval**: Includes a configurable validation and approval flow, incorporating linters and manual confirmation steps to ensure code quality and developer control.
-   **Extensible Hooks**: Allows running custom shell commands before and after applying changes, enabling integration with build tools, test runners, and other scripts.

## 3. CLI Commands

### `relay init`

Initializes Relaycode in the current project directory.

-   **Action**:
    1.  Checks if a configuration file already exists. If so, it skips initialization and displays the system prompt.
    2.  Creates a `relaycode.config.json` file with sensible defaults.
    3.  Determines the `projectId` by reading the `name` field from `package.json`. If not found, it uses the current directory's name.
    4.  Creates a `.relaycode/` directory for storing transaction state.
    5.  Appends `/.relaycode/` to the project's `.gitignore` file, creating the file if it doesn't exist.
    6.  Outputs a detailed "System Prompt" for the user to copy into their LLM's custom instructions, explaining how to format code patches for Relaycode.

### `relay watch`

Starts the main watcher process.

-   **Action**:
    1.  Loads the `relaycode.config.json` configuration. Exits if not found.
    2.  Begins polling the system clipboard at the interval specified by `clipboardPollInterval`.
    3.  When new clipboard content is detected, it attempts to parse it as a Relaycode patch.
    4.  If the content is a valid patch, it initiates the transactional workflow to apply the changes.
    5.  Ignores any clipboard content that doesn't conform to the expected format.

## 4. LLM Response Format

For Relaycode to process a patch, the LLM's response must follow a specific structure.

### General Structure

A valid response consists of three parts in order:

1.  **Reasoning**: Plain text explaining the "why" and "how" of the changes.
2.  **Code Blocks**: One or more specially formatted code blocks, each representing a file operation.
3.  **Control Block**: A final YAML block containing metadata for the transaction.

### Code Blocks

Code blocks are used to specify file creations, modifications, or deletions.

**Syntax**:
```
`​`​`[language] // {[filePath]} [patchStrategy]
// START (optional)

... content ...

// END (optional)
`​`​`
```

-   `[language]`: The language of the code (e.g., `typescript`, `diff`).
-   `{filePath}`: The relative path to the file from the project root.
-   `[patchStrategy]`: (Optional) The strategy to use for applying the change. If omitted, the default `replace` strategy is used.

#### Patch Strategies

1.  **`replace` (Default)**
    -   **Usage**: Omit the strategy or explicitly state `replace`.
    -   **Action**: The entire content of the target file is replaced with the content inside the code block. If the file does not exist, it is created.
    -   **Content**: The full, final content of the file.

2.  **`new-unified`**
    -   **Usage**: For applying complex changes, refactoring, or adding features. It is resilient to minor line number differences.
    -   **Action**: Applies a patch using a unified diff format.
    -   **Content**: A diff in the unified format.
        ```diff
        --- a/src/utils.ts
        +++ b/src/utils.ts
        @@ ... @@
        -  return a + b;
        +  return (a + b) * 2;
        ```

3.  **`multi-search-replace`**
    -   **Usage**: For making multiple, precise, non-contiguous changes within a single file.
    -   **Action**: Searches for exact text blocks and replaces them. The operation will fail if any `SEARCH` block is not found.
    -   **Content**: A series of `SEARCH`/`REPLACE` blocks.
        ```diff
        <<<<<<< SEARCH
        -------
        port: 3000,
        =======
        port: 8080,
        >>>>>>> REPLACE
        ```

#### File Deletion

To delete a file, provide a code block with a special marker as its content.

**Syntax**:
```
`​`​`[language] // {[filePath]}
//TODO: delete this file
`​`​`
```

### Control Block

The response **must** end with a YAML block containing transaction metadata.

**Syntax**:
```yaml
`​`​`yaml
projectId: [string]
uuid: [string]
changeSummary:
  - edit: path/to/file.ts
  - new: path/to/new-file.ts
  - delete: path/to/old-file.ts
`​`​`
```

-   `projectId`: The project identifier. **Must match** the `projectId` in `relaycode.config.json`.
-   `uuid`: A unique UUID (v4) for this specific transaction, generated by the LLM. This prevents re-processing the same patch.
-   `changeSummary`: (Optional) A human-readable summary of the operations.

## 5. Transactional Workflow

When `relay watch` detects a valid patch, it executes the following atomic process:

1.  **Validation**:
    -   Verifies that the `projectId` in the patch matches the local configuration.
    -   Checks if the `uuid` has already been processed by looking for a corresponding `.yml` file in the `.relaycode` directory.

2.  **Pre-Command & Snapshot**:
    -   If `preCommand` is defined in the config, it is executed. The transaction is aborted if the command fails (exits with a non-zero code).
    -   A `snapshot` of the original content of all affected files is created in memory. Files that do not exist are recorded as `null`. This snapshot is used for rollback.

3.  **Execution & Staging**:
    -   A state file named `{uuid}.pending.yml` is written to the `.relaycode` directory, containing all transaction details.
    -   The file operations (write, delete, patch) are applied to the filesystem.
    -   If any operation fails (e.g., due to file permissions or a failing patch), the entire transaction is immediately rolled back using the snapshot, and the pending state file is deleted.

4.  **Verification**:
    -   If `postCommand` is defined, it is executed. If the command fails, it forces a rollback.
    -   If `linter` is defined, it is executed to check the new code for errors. The number of errors is recorded.

5.  **Approval Logic**:
    -   The change is **automatically approved** if:
        -   `approval` is set to `"yes"`.
        -   The number of linter errors is less than or equal to `approvalOnErrorCount`.
    -   Otherwise, the user is **prompted for manual confirmation** (y/N).
    -   A failed `postCommand` or manual rejection triggers a rollback.

6.  **Commit or Rollback**:
    -   **On Approval**: The `approved` flag in the pending state is set to `true`, and the file is atomically renamed from `{uuid}.pending.yml` to `{uuid}.yml`. This completes the transaction.
    -   **On Rejection/Failure**: The filesystem is restored to its original state from the snapshot. This includes recreating deleted files, reverting modified files, and deleting newly created files (and any empty parent directories created along with them). The `{uuid}.pending.yml` file is deleted.

## 6. Configuration (`relaycode.config.json`)

All configuration is managed in this file at the project root.

| Key                     | Type     | Default                  | Description                                                                                       |
| ----------------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `projectId`             | `string` | *(generated)*            | A unique identifier for the project.                                                              |
| `clipboardPollInterval` | `number` | `2000`                   | The interval in milliseconds at which to poll the clipboard for changes.                          |
| `approval`              | `string` | `"yes"`                  | Approval mode: `"yes"` for auto-approval on success, `"no"` to always require manual confirmation.  |
| `approvalOnErrorCount`  | `number` | `0`                      | The maximum number of linter errors allowed for auto-approval to pass.                            |
| `linter`                | `string` | `"bun tsc --noEmit"`     | The shell command to run as a linter after applying changes.                                      |
| `preCommand`            | `string` | `""`                     | A shell command to run *before* taking a snapshot and applying changes.                           |
| `postCommand`           | `string` | `""`                     | A shell command to run *after* applying changes but *before* the final approval step.             |

## 7. State Management (`.relaycode/`)

This directory is used to track the history and state of all transactions.

-   **Purpose**: To prevent reprocessing of patches and to provide an audit trail of all applied changes.
-   **`.pending.yml` files**: Represent a transaction that is currently in progress. These are temporary and should not persist.
-   **`.yml` files**: Represent a successfully applied and committed transaction. The presence of a `{uuid}.yml` file is the source of truth for whether a patch has been processed.

A state file contains the complete context of a transaction, including: `uuid`, `projectId`, `createdAt`, `reasoning`, `operations`, the `snapshot` of original files, and the final `approved` status.
```