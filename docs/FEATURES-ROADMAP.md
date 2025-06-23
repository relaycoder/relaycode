#### ✅ DONE: some cli aliases just doesnt work like relaycode -v etc
#### ✅ DONE: do not show reasoning in relay log cli command. replace by showing promptSummary

#### this field in .relaycode log should be placed below created date
gitCommitMsg:
promptSummary:

#### all-or-nothing vs
#### DONE: do not fire notification on skipped uuid

Starting clipboard watcher (polling every 2000ms)
New clipboard content detected. Attempting to parse...
Valid patch detected for project 'relaycode'. Processing...
Skipping patch: uuid 'a6311de1-b844-4861-9c8e-a9d70de792f4' has already been processed.


#### ✅ DONE: relay git commit
#### VERIFY: make sure clipboard is working in linux
#### ✅ DONE: should be abble to parse yaml without codefence
#### ✅ DONE: user prompt summary in yaml for .relaycode log
#### words level chalk

#### Automated Correction Prompting (The "Feedback Loop")

*   **Problem:** When a patch fails the linter or tests, the developer must manually copy the error message, switch back to the LLM, and construct a new prompt to ask for a fix. This is a slow and repetitive part of the workflow.
*   **Proposal:**
    1.  When a transaction fails (`postCommand` error, linter failure), `relaycode` doesn't just roll back. It enters a "correction" state.
    2.  It automatically captures the `stdout` and `stderr` from the failed command.
    3.  It then constructs a new, optimized prompt and copies it to the clipboard for the user.
        *   The prompt would be structured like: "The following patch was attempted but failed. **Reasoning:** `{original reasoning}`. **Patch:** `{original patch}`. **Error:** `{captured error log}`. Please analyze the error and provide a corrected patch."
    4.  The developer's next action is simply to paste this perfectly-formed correction prompt into the LLM.
*   **Benefit:** This closes the feedback loop between the tool and the LLM, making the process of fixing faulty patches nearly instantaneous and removing tedious manual work for the developer.

#### Analytics & Project Insights (`relay stats`)

*   **Problem:** The transaction history in the `.relaycode` directory is a rich dataset of the project's evolution via AI, but it's currently unused.
*   **Proposal:** Create a `relay stats` command that analyzes the transaction log to provide insights.
    1.  **Code Hotspots:** Identify which files are most frequently modified by the LLM. This can indicate areas of the codebase that are complex, brittle, or ripe for a major refactor.
    2.  **AI Reliability Score:** Calculate metrics like:
        *   Transaction success rate (committed vs. rolled back).
        *   Approval rate (manual approvals vs. rejections).
        *   Average error count post-apply.
    3.  **Strategy Effectiveness:** Show which patch strategies (`replace`, `new-unified`, etc.) are most commonly used and which ones lead to the most successful commits.
    *   **Output:** This could generate a simple terminal report or even a `stats.html` file with charts, giving the team a dashboard to understand how AI is impacting their codebase.

#### Plugin Architecture
*   **Problem:** All functionality is currently hard-coded. Adding new features or a different diffing engine requires modifying the core.
*   **Proposal:**
    *   Refactor the core logic to emit events (e.g., `onPatchReceived`, `beforeApply`, `afterCommit`, `onRollback`).
    *   Create a plugin system where a user can install a package (e.g., `relay-plugin-slack`) and add it to their config.
    *   The plugin would register listeners for these events. The Slack plugin could listen for `afterCommit` and `onRollback` to send notifications. A custom diffing plugin could register a new patch strategy.

#### Intelligent Pre-Command Execution
*   **Problem:** The `preCommand` runs for every transaction, which might be unnecessary.
*   **Proposal:**
    *   Allow the `preCommand` in the config to be an object that maps file extensions to commands.
        ```json
        "preCommand": {
          "*.ts": "bun check",
          "*.py": "python -m mypy ."
        }
        ```
    *   Before running a transaction, `relaycode` would inspect the file extensions of the affected files and only run the relevant commands.

#### Interactive Log and Enhanced Undo/Redo
*   **Problem:** `undo` only reverts the very last transaction. The `log` command is read-only.
*   **Proposal:**
    1.  **Interactive `log`:** Enhance the `log` command to show a numbered list of recent transactions.
    2.  **Targeted `undo`:** Allow `undo` to take a transaction UUID or the number from the interactive log (`relay undo <uuid>` or `relay undo 3`).
    3.  **`redo` Command:** Since the `undo` command cleverly moves the undone transaction to a `undone/` directory, you can easily implement a `redo` command. It would find the latest file in `undone/`, move it back to the main state directory, and re-apply the snapshot from *before* that transaction (which is stored in its `snapshot` property).


#### Partial Patch Application
*   **Problem:** Sometimes an LLM response contains multiple, independent changes in different files. One change might be good, while another has a bug. Currently, it's all-or-nothing.
*   **Proposal:** In manual approval mode, allow the user to select which file operations from a patch to apply.
    *   When approval is requested, list each file operation with a checkbox (using a library like `inquirer`).
    *   The user can select the operations they want.
    *   The transaction is then processed with only the approved operations, and the state file is saved accordingly.

#### Improve Windows Clipboard Handling
*   **Problem:** The `src/core/clipboard.ts` file contains custom logic to copy a Windows executable to a local `fallbacks` directory. This can be fragile, might be flagged by antivirus software, and adds complexity.
*   **Proposal:**
    *   Investigate if newer versions of `clipboardy` or alternative cross-platform clipboard libraries have improved native Windows support, potentially removing the need for the bundled `.exe`.
    *   If the executable is still necessary, consider adding it to the `files` array in `package.json` and using a more robust method to locate it within the `node_modules` directory rather than copying it.

#### ✅ DONE: add version to relay
#### ✅ DONE: Transaction rolleed back still not really making all affected files to original state especially the failed file.
#### ✅ DONE: shorhands commands not working, also commands without -- not working.
#### ✅ DONE: ms took should be shown before asking approval
#### ✅ DONE: system notification should fired on matched project id, not on valid patch format
#### ✅ DONE: it still asking for approval on approval off in config setup
#### ✅ DONE uuid that has already in undone should not be reprocess


#### ✅ DONE : Undo Last Transaction (`relay undo`)
-   **What:** A new CLI command, `relay undo`, that reverts the last successfully committed transaction.
-   **Why:** Provides a critical safety net. If a developer accepts a change and only later realizes it was a mistake, this offers a one-command escape hatch without needing to manually revert files or rely on Git.
-   **Implementation:** The command would find the most recent `.yml` file in the `.relaycode` directory, read its `snapshot` data, and call the existing `restoreSnapshot` function. The corresponding `.yml` file would then be deleted or moved to an `undone/` subdirectory.

#### ✅ Apply Patch from File (`relay apply <path-to-patch-file>`)
-   **What:** A new command to process a patch saved in a local file instead of watching the clipboard.
-   **Why:**
    1.  **Decouples from Clipboard:** Enables use cases where copying/pasting is inconvenient (e.g., long-term storage of patches, scripted automation).
    2.  **Testability:** Makes it vastly easier to write reliable end-to-end tests for the entire transaction pipeline.
    3.  **Offline Use:** Allows developers to save an LLM response and apply it later.

#### ✅ DONE: History and Targeted Revert (`relay log` & `relay revert <uuid>`)
-   **What:**
    -   `relay log`: A command to list all committed transactions from the `.relaycode` directory, showing UUID, timestamp, and reasoning/change summary.
    -   `relay revert <uuid>`: An extension of `undo` that allows reverting a *specific* past transaction by its UUID.
-   **Why:** Provides a complete audit trail of AI-driven changes made via Relaycode, functioning as a lightweight, operation-specific version control system. This is crucial for tracking how a codebase evolved and for surgically undoing specific changes without affecting subsequent ones.


#### New Operation: Shell Command Execution
-   **What:** Introduce a new code block type for executing arbitrary shell commands as part of a transaction.
-   **Why:** Unlocks a new class of automation. The LLM could not only provide code but also perform related setup tasks, such as installing a dependency (`npm install new-package`), running a database migration, or scaffolding a new component with a CLI.
-   **Syntax Idea:**
    ```sh // {run-command}
    npm install zod
    ```
-   **Implementation:** This would require careful security considerations. It should be off by default and enabled via a config flag (`allowShellCommands: true`) with a prominent warning. The snapshot/rollback logic would need to handle this new operation type (e.g., by attempting to run a corresponding "undo" command if provided).


#### ✅ DONE: New Operation: File Rename/Move
-   **What:** Add a dedicated `rename` operation.
-   **Why:** While a rename can be accomplished with a `delete` and a `write`, a dedicated operation is cleaner and more explicit. It allows the state management and snapshot system to track file identity more accurately, leading to more robust rollbacks.
-   **Syntax Idea:**
    ```json // {rename-file}
    {
      "from": "src/old-name.ts",
      "to": "src/new-name.ts"
    }
    ```


#### First-Class Git Integration
-   **What:** Introduce a configuration option to enable Git-aware operations. When enabled, each transaction would automatically create a new branch.
    -   `gitBranchPrefix`: A config option (e.g., `"relay/patch-"`).
    -   **On start of transaction:** `git checkout -b relay/patch-2a8b-short-uuid`.
    -   **On approval:** The code is committed. The commit message can be auto-generated from the LLM's reasoning and `changeSummary`. The branch is then left for the user to review, merge, or delete.
    -   **On rollback:** The changes are reverted, and the newly created branch is forcefully deleted (`git checkout -; git branch -D relay/patch-...`).
-   **Why:** This is a transformative feature. It aligns Relaycode's atomic transactions with Git's atomic commits, making history management clean and idiomatic. It eliminates any risk of dirtying the main working branch and allows for easy review of changes using standard `git` and platform tools (GitHub PRs, etc.).


#### ✅ DONE: System-Level Notifications
-   **What:** Use a cross-platform library (like `node-notifier`) to send system notifications at key moments.
-   **Why:** The `watch` command requires the developer to keep an eye on the terminal. System notifications provide crucial feedback even when the terminal is not in focus.
    -   **On new patch detected:** "Relaycode: New patch detected for project `my-app`."
    -   **On manual approval required:** "Relaycode: Action required to approve changes for `my-app`."
    -   **On success/failure:** "Relaycode: Patch `uuid` applied successfully." or "Relaycode: Patch `uuid` failed and was rolled back."


#### ✅ DONE Automatic Patch Strategy Detection
-   **What:** If a patch strategy is omitted in a code block, Relaycode could inspect its content to infer the strategy.
-   **Why:** Reduces the verbosity and "brittleness" of the LLM prompt. The LLM can focus on generating the correct content, not just the correct syntax.
-   **Heuristics:**
    -   If the content starts with `--- a/` and `+++ b/` and contains `@@ ... @@`, treat it as `new-unified`.
    -   If it contains `<<<<<<< SEARCH`, treat it as `multi-search-replace`.
    -   Otherwise, default to `replace`.


#### Per-Directory Configuration Overrides
-   **What:** Allow specifying configuration overrides for certain file paths or globs within `relaycode.config.json`.
-   **Why:** A single global configuration is often insufficient for a large monorepo. A team might want a stricter `linter` and `approval: 'no'` for core library code (`packages/core/**`) but a more lenient policy for documentation (`docs/**`).
-   **Syntax Idea:**
    ```json
    {
      "projectId": "my-monorepo",
      "linter": "bun test",
      "overrides": [
        {
          "include": ["packages/core/**/*.ts"],
          "linter": "bun tsc --noEmit --strictest",
          "approval": "no"
        },
        {
          "include": ["docs/**/*.md"],
          "linter": ""
        }
      ]
    }
    ```
