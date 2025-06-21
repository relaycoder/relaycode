import { findConfig } from '../core/config';
import { createClipboardWatcher } from '../core/clipboard';
import { parseLLMResponse } from '../core/parser';
import { processPatch } from '../core/transaction';
import { logger } from '../utils/logger';
import { CONFIG_FILE_NAME } from '../utils/constants';
import { notifyPatchDetected } from '../utils/notifier';
import { Config } from '../types';

const getSystemPrompt = (projectId: string, preferredStrategy: Config['preferredStrategy']): string => {
    const header = `
✅ relaycode is watching for changes.

IMPORTANT: For relaycode to work, you must configure your AI assistant.
Copy the entire text below and paste it into your LLM's "System Prompt"
or "Custom Instructions" section.
---------------------------------------------------------------------------`;

    const intro = `You are an expert AI programmer. To modify a file, you MUST use a code block with a specified patch strategy.`;

    const syntaxAuto = `
**Syntax:**
\`\`\`typescript // filePath {patchStrategy}
... content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- \`patchStrategy\`: (Optional) One of \`new-unified\`, \`multi-search-replace\`. If omitted, the entire file is replaced (this is the \`replace\` strategy).

**Examples:**
\`\`\`typescript // src/components/Button.tsx
...
\`\`\`
\`\`\`typescript // "src/components/My Component.tsx" new-unified
...
\`\`\``;

    const syntaxReplace = `
**Syntax:**
\`\`\`typescript // filePath
... content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- Only the \`replace\` strategy is enabled. This means you must provide the ENTIRE file content for any change. This is suitable for creating new files or making changes to small files.`;

    const syntaxNewUnified = `
**Syntax:**
\`\`\`typescript // filePath new-unified
... diff content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- You must use the \`new-unified\` patch strategy for all modifications.`;

    const syntaxMultiSearchReplace = `
**Syntax:**
\`\`\`typescript // filePath multi-search-replace
... diff content ...
\`\`\`
- \`filePath\`: The path to the file. **If the path contains spaces, it MUST be enclosed in double quotes.**
- You must use the \`multi-search-replace\` patch strategy for all modifications.`;

    const sectionNewUnified = `---

### Strategy 1: Advanced Unified Diff (\`new-unified\`) - RECOMMENDED

Use for most changes, like refactoring, adding features, and fixing bugs. It's resilient to minor changes in the source file.

**Diff Format:**
1.  **File Headers**: Start with \`--- {filePath}\` and \`+++ {filePath}\`.
2.  **Hunk Header**: Use \`@@ ... @@\`. Exact line numbers are not needed.
3.  **Context Lines**: Include 2-3 unchanged lines before and after your change for context.
4.  **Changes**: Mark additions with \`+\` and removals with \`-\`. Maintain indentation.

**Example:**
\`\`\`diff
--- src/utils.ts
+++ src/utils.ts
@@ ... @@
    function calculateTotal(items: number[]): number {
-      return items.reduce((sum, item) => {
-        return sum + item;
-      }, 0);
+      const total = items.reduce((sum, item) => {
+        return sum + item * 1.1;  // Add 10% markup
+      }, 0);
+      return Math.round(total * 100) / 100;  // Round to 2 decimal places
+    }
\`\`\`
`;

    const sectionMultiSearchReplace = `---

### Strategy 2: Multi-Search-Replace (\`multi-search-replace\`)

Use for precise, surgical replacements. The \`SEARCH\` block must be an exact match of the content in the file.

**Diff Format:**
Repeat this block for each replacement.
\`\`\`diff
<<<<<<< SEARCH
:start_line: (optional)
:end_line: (optional)
-------
[exact content to find including whitespace]
=======
[new content to replace with]
>>>>>>> REPLACE
\`\`\`
`;

    const otherOps = `---

### Other Operations

-   **Creating a file**: Use the default \`replace\` strategy (omit the strategy name) and provide the full file content.
-   **Deleting a file**:
    \`\`\`typescript // path/to/file.ts
    //TODO: delete this file
    \`\`\`
    \`\`\`typescript // "path/to/My Old Component.ts"
    //TODO: delete this file
    \`\`\`
`;

    const finalSteps = `---

### Final Steps

1.  Add your step-by-step reasoning in plain text before each code block.
2.  ALWAYS add the following YAML block at the very end of your response. Use the exact projectId shown here. Generate a new random uuid for each response.

    \`\`\`yaml
    projectId: ${projectId}
    uuid: (generate a random uuid)
    changeSummary:
      - edit: src/main.ts
      - new: src/components/Button.tsx
      - delete: src/utils/old-helper.ts
    \`\`\`
`;
    
    const footer = `---------------------------------------------------------------------------`;

    let syntax = '';
    let strategyDetails = '';

    switch (preferredStrategy) {
        case 'replace':
            syntax = syntaxReplace;
            strategyDetails = ''; // Covered in 'otherOps'
            break;
        case 'new-unified':
            syntax = syntaxNewUnified;
            strategyDetails = sectionNewUnified;
            break;
        case 'multi-search-replace':
            syntax = syntaxMultiSearchReplace;
            strategyDetails = sectionMultiSearchReplace;
            break;
        case 'auto':
        default:
            syntax = syntaxAuto;
            strategyDetails = `${sectionNewUnified}\n${sectionMultiSearchReplace}`;
            break;
    }

    return [header, intro, syntax, strategyDetails, otherOps, finalSteps, footer].filter(Boolean).join('\n');
}

export const watchCommand = async (): Promise<void> => {
  const config = await findConfig();

  if (!config) {
    logger.error(`Configuration file '${CONFIG_FILE_NAME}' not found.`);
    logger.info("Please run 'relay init' to create one.");
    process.exit(1);
  }
  
  logger.setLevel(config.logLevel);
  logger.success('Configuration loaded. Starting relaycode watch...');
  logger.debug(`Log level set to: ${config.logLevel}`);
  logger.debug(`Preferred strategy set to: ${config.preferredStrategy}`);

  // Display the system prompt
  logger.log(getSystemPrompt(config.projectId, config.preferredStrategy));

  createClipboardWatcher(config.clipboardPollInterval, async (content) => {
    logger.info('New clipboard content detected. Attempting to parse...');
    const parsedResponse = parseLLMResponse(content);

    if (!parsedResponse) {
      logger.warn('Clipboard content is not a valid relaycode patch. Ignoring.');
      return;
    }
    
    notifyPatchDetected(config.projectId);
    logger.success('Valid patch format detected. Processing...');
    await processPatch(config, parsedResponse);
    logger.info('--------------------------------------------------');
    logger.info('Watching for next patch...');
  });
};