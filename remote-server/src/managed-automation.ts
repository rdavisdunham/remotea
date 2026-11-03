import fs from 'fs';
import path from 'path';
import { writePrivate } from './eridani-mcp';
export interface AutomationState { generation: number; held: boolean; revision: number }
/** Run-scoped and durable before any terminal exists. No worker interruption or permission changes. */
export class ManagedAutomation {
  private holds: Record<string, AutomationState> = {};
  private file: string | null;
  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, 'managed-automation.json') : null;
    if (this.file) try { this.holds = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('automation hold state unreadable; refusing delivery'); }
  }
  get(run: string): AutomationState { return this.holds[run] ?? { generation: 0, held: false, revision: 0 }; }
  set(run: string, generation: number, held: boolean, revision: number): string | null {
    const current = this.get(run);
    if (generation < current.generation || revision < current.revision) return 'stale automation hold revision';
    if (revision === current.revision && held !== current.held) return 'conflicting automation hold revision';
    const next = { ...this.holds, [run]: { generation, held, revision } };
    if (this.file) { writePrivate(this.file, JSON.stringify(next)); const fd = fs.openSync(this.file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } const parent = fs.openSync(path.dirname(this.file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
    this.holds = next; return null;
  }
  blocked(run: string, origin?: string, revision?: number): boolean { const state = this.get(run); return origin === 'automation' && (state.held || revision !== undefined && revision < state.revision); }
}
