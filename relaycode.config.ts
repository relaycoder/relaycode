import { defineConfig } from './src/types';

export default defineConfig({
  projectId: 'relaycode',
  core: {
    logLevel: 'info',
    enableNotifications: true,
    watchConfig: true,
  },
  watcher: {
    clipboardPollInterval: 2000,
    preferredStrategy: 'auto',
  },
  patch: {
    approvalMode: 'auto',
    approvalOnErrorCount: 0,
    linter: 'bun tsc -b --noEmit',
    preCommand: '',
    postCommand: '',
  },
  git: {
    autoGitBranch: false,
    gitBranchPrefix: 'relay/',
    gitBranchTemplate: 'gitCommitMsg',
  },
});