import type { Transcript } from './transcript';
import type { SessionTool } from '../../../src/shared/eridani-link-protocol';

/** One session as a reader found it (collector.py's dict before `payload()`). */
export interface FoundSession {
  tool: SessionTool;
  session_id: string;
  environment: string;
  cwd: string;
  repo: string;
  branch: string;
  title: string;
  transcript: Transcript;
  pr_urls: string[];
  started_at: string | null;
  last_active_at: string | null;
  resume: Record<string, unknown>;
}

/** One entry of a session store: a Claude transcript file or a Codex thread row. */
export interface Source {
  /** Unique key: the file path, or `<state db>#<thread id>`. */
  source: string;
  /** Changes whenever the session may have changed (mtime:size, or updated_at). */
  version: string;
  /** Last modified, epoch seconds. */
  modified: number;
  read: () => Promise<FoundSession | null>;
}
