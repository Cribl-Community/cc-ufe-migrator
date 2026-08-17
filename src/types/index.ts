export interface Profile {
  id: string;
  name: string;
  org?: string;
  notes?: string;
  createdAt: number;
}

export interface Stanza {
  header: string;
  settings: string[];
  commentedOut: boolean;
}

export interface AppInputs {
  default: string | null;
  local: string | null;
}

/** appName → { default, local } */
export type InputsMap = Record<string, AppInputs>;

/** stanza header → migration label e.g. "Migrated via Copy" */
export type MigrationMap = Record<string, string>;

/** stanza header → exclusion reason */
export type ExclusionMap = Record<string, string>;
