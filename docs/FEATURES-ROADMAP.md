#### Undo Last Transaction (`relay undo`)
-   **What:** A new CLI command, `relay undo`, that reverts the last successfully committed transaction.
-   **Why:** Provides a critical safety net. If a developer accepts a change and only later realizes it was a mistake, this offers a one-command escape hatch without needing to manually revert files or rely on Git.
-   **Implementation:** The command would find the most recent `.yml` file in the `.relaycode` directory, read its `snapshot` data, and call the existing `restoreSnapshot` function. The corresponding `.yml` file would then be deleted or moved to an `undone/` subdirectory.

#### Apply Patch from File (`relay apply <path-to-patch-file>`)
-   **What:** A new command to process a patch saved in a local file instead of watching the clipboard.
-   **Why:**
    1.  **Decouples from Clipboard:** Enables use cases where copying/pasting is inconvenient (e.g., long-term storage of patches, scripted automation).
    2.  **Testability:** Makes it vastly easier to write reliable end-to-end tests for the entire transaction pipeline.
    3.  **Offline Use:** Allows developers to save an LLM response and apply it later.

#### History and Targeted Revert (`relay log` & `relay revert <uuid>`)
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


#### New Operation: File Rename/Move
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


#### System-Level Notifications
-   **What:** Use a cross-platform library (like `node-notifier`) to send system notifications at key moments.
-   **Why:** The `watch` command requires the developer to keep an eye on the terminal. System notifications provide crucial feedback even when the terminal is not in focus.
    -   **On new patch detected:** "Relaycode: New patch detected for project `my-app`."
    -   **On manual approval required:** "Relaycode: Action required to approve changes for `my-app`."
    -   **On success/failure:** "Relaycode: Patch `uuid` applied successfully." or "Relaycode: Patch `uuid` failed and was rolled back."


#### Automatic Patch Strategy Detection
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