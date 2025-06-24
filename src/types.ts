import { z } from 'zod';

export const LogLevelNameSchema = z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('info');
export type LogLevelName = z.infer<typeof LogLevelNameSchema>;

// Schema for relaycode.config.json
const CoreConfigSchema = z.object({
  logLevel: LogLevelNameSchema,
  enableNotifications: z.boolean().default(true),
  watchConfig: z.boolean().default(true),
});

const WatcherConfigSchema = z.object({
  clipboardPollInterval: z.number().int().positive().default(2000),
  preferredStrategy: z.enum(['auto', 'replace', 'new-unified', 'multi-search-replace']).default('auto'),
});

const PatchConfigSchema = z.object({
  approvalMode: z.enum(['auto', 'manual']).default('auto'),
  approvalOnErrorCount: z.number().int().min(0).default(0),
  linter: z.string().default('bun tsc --noEmit'),
  preCommand: z.string().default(''),
  postCommand: z.string().default(''),
});

const GitConfigSchema = z.object({
  autoGitBranch: z.boolean().default(false),
  gitBranchPrefix: z.string().default('relay/'),
  gitBranchTemplate: z.enum(['uuid', 'gitCommitMsg']).default('gitCommitMsg'),
});

export const ConfigSchema = z.object({
  projectId: z.string().min(1),
  core: CoreConfigSchema.default({}),
  watcher: WatcherConfigSchema.default({}),
  patch: PatchConfigSchema.default({}),
  git: GitConfigSchema.default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

export type RelayCodeConfigInput = z.input<typeof ConfigSchema>;
export const defineConfig = (config: RelayCodeConfigInput): RelayCodeConfigInput => config;

export const PatchStrategySchema = z.enum([
  'replace',
  'new-unified',
  'multi-search-replace',
  'unified',
]).default('replace');
export type PatchStrategy = z.infer<typeof PatchStrategySchema>;

// Schema for operations parsed from code blocks
export const FileOperationSchema = z.union([
  z.object({
    type: z.literal('write'),
    path: z.string(),
    content: z.string(),
    patchStrategy: PatchStrategySchema,
  }),
  z.object({
    type: z.literal('delete'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('rename'),
    from: z.string(),
    to: z.string(),
  }),
]);
export type FileOperation = z.infer<typeof FileOperationSchema>;

// Schema for the control YAML block at the end of the LLM response
export const ControlYamlSchema = z.object({
  projectId: z.string(),
  uuid: z.string().uuid(),
  changeSummary: z.array(z.record(z.string())).optional(), // Not strictly used, but good to parse
  gitCommitMsg: z.string().optional(),
  promptSummary: z.string().optional(),
});
export type ControlYaml = z.infer<typeof ControlYamlSchema>;

// The fully parsed response from the clipboard
export const ParsedLLMResponseSchema = z.object({
  control: ControlYamlSchema,
  operations: z.array(FileOperationSchema),
  reasoning: z.array(z.string()),
});
export type ParsedLLMResponse = z.infer<typeof ParsedLLMResponseSchema>;

// Schema for the snapshot of original files
export const FileSnapshotSchema = z.record(z.string(), z.string().nullable()); // path -> content | null (if file didn't exist)
export type FileSnapshot = z.infer<typeof FileSnapshotSchema>;

// Schema for the state file (.relaycode/{uuid}.yml or .pending.yml)
export const StateFileSchema = z.object({
  uuid: z.string().uuid(),
  projectId: z.string(),
  createdAt: z.string().datetime(),
  gitCommitMsg: z.string().optional(),
  promptSummary: z.string().optional(),
  reasoning: z.array(z.string()),
  operations: z.array(FileOperationSchema),
  snapshot: FileSnapshotSchema,
  approved: z.boolean(),
});
export type StateFile = z.infer<typeof StateFileSchema>;

// Shell command execution result
export const ShellCommandResultSchema = z.object({
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().nullable(),
});
export type ShellCommandResult = z.infer<typeof ShellCommandResultSchema>;