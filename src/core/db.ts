import { konro } from 'konro';
import type { FileOperation, FileSnapshot, StateFile } from '../types';
import path from 'path';
import { getStateDirectory } from './config';
import type { OnDemandDbContext } from 'konro';

export const relaySchema = konro.createSchema({
  tables: {
    transactions: {
      id: konro.id(),
      uuid: konro.string({ unique: true }),
      projectId: konro.string(),
      createdAt: konro.string(), // store as ISO string
      linesAdded: konro.number({ optional: true }),
      linesRemoved: konro.number({ optional: true }),
      gitCommitMsg: konro.string({ optional: true }),
      promptSummary: konro.string({ optional: true }),
      reasoning: konro.object<string[]>(),
      operations: konro.object<FileOperation[]>(),
      snapshot: konro.object<FileSnapshot>(),
      approved: konro.boolean(),
      status: konro.string(), // 'pending', 'committed', 'undone'
    },
  },
  relations: () => ({}),
});

export type RelaySchema = typeof relaySchema;
// This is the type inferred by konro for a base record.
export type TransactionRecord = RelaySchema['base']['transactions'];

// We need to convert between TransactionRecord and StateFile because StateFile is a Zod-validated type
// and TransactionRecord is konro's inferred type. They should be structurally identical.
// This function also handles type casting for complex object types.
export function toStateFile(record: TransactionRecord): StateFile {
  return record as unknown as StateFile;
}

export function fromStateFile(stateFile: StateFile): Omit<TransactionRecord, 'id' | 'status'> {
  const { ...rest } = stateFile;
  // status will be added separately
  return rest;
}

let dbInstance: OnDemandDbContext<RelaySchema> | undefined;

export function getDb(cwd: string): OnDemandDbContext<RelaySchema> {
  if (dbInstance) {
    return dbInstance;
  }

  const dbDir = path.join(getStateDirectory(cwd), 'db');

  const adapter = konro.createFileAdapter({
    format: 'json',
    perRecord: { dir: dbDir },
    mode: 'on-demand',
  });

  const db = konro.createDatabase({ schema: relaySchema, adapter });
  dbInstance = db as OnDemandDbContext<RelaySchema>; // cast because createDatabase returns a generic DbContext
  return dbInstance;
}