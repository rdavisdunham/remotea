import fs from 'node:fs';
import { open, readdir, readlink } from 'node:fs/promises';
import { codexThreadFromPath } from './agent-probe';
import { claudeReply } from './collector/claude-jsonl';
import { claudeTranscriptPath, defaultClaudeConfigDir } from './dispatch';
import { rolloutFinalAnswer } from './turn-capture';
import type { GlassfaceReaderView, SessionRecord } from '../../src/shared/remote-host-protocol';

const tailBytes = 2 * 1024 * 1024;
const maximumBytes = 384 * 1024;
const maxReplies = 8;

function modelLabel(value: unknown): string | undefined {
  // A family alias or <synthetic> would misidentify the model behind a reply.
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d._-]{1,79}$/i.test(value) || !/\d/.test(value)) return;
  const claude = /^claude-(\w+)-(\d+)(?:[.-](\d{1,2}))?(?:-\d{8})?$/i.exec(value);
  if (claude) return claude[1][0].toUpperCase() + claude[1].slice(1) + ' ' + claude[2] + (claude[3] ? '.' + claude[3] : '');
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(sol|astra|terra|luna))?$/i.exec(value);
  if (gpt) return gpt[1] + (gpt[2] ? ' ' + gpt[2][0].toUpperCase() + gpt[2].slice(1) : '');
  return value;
}

/** Fill the wire budget newest-first, preserving whole replies whenever they fit. */
export function fitReader(reader: GlassfaceReaderView, maxBytes: number): GlassfaceReaderView {
  const view: GlassfaceReaderView = { ...reader, replies: [] };
  let left = maxBytes - Buffer.byteLength(JSON.stringify(view));
  for (let i = reader.replies.length - 1; i >= 0; i--) {
    const reply = reader.replies[i];
    const size = Buffer.byteLength(JSON.stringify(reply)) + (view.replies.length ? 1 : 0);
    if (size <= left) {
      view.replies.unshift(reply);
      left -= size;
    } else {
      if (!view.replies.length) {
        const marker = '\n[Reply shortened on Glass]';
        const fixed = Buffer.byteLength(JSON.stringify({ id: reply.id, text: marker }));
        if (left < fixed) break;
        let lo = 0, hi = Math.min(reply.text.length, left - fixed);
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          const bytes = Buffer.byteLength(JSON.stringify(reply.text.slice(0, mid))) - 2;
          if (fixed + bytes <= left) lo = mid;
          else hi = mid - 1;
        }
        if (lo && /[\uD800-\uDBFF]/.test(reply.text[lo - 1])) lo--;
        view.replies.push({ id: reply.id, text: reply.text.slice(0, lo) + marker });
      }
      break;
    }
  }
  return view;
}

export function parseReplies(provider: string, conversation: string, tail: string): GlassfaceReaderView {
  const replies = new Map<string, string>();
  const seen = new Set<string>();
  let model: string | undefined;
  let turn: string | undefined;
  for (const line of tail.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    let id: unknown, text: string | null;
    if (provider === 'claude') {
      if (row.type !== 'assistant' || row.sessionId !== conversation || row.isSidechain || row.isMeta || row.isApiErrorMessage) continue;
      const msg = row.message;
      if (!msg || typeof msg !== 'object') continue;
      const reported = modelLabel(msg.model);
      if (reported) model = reported;
      if (msg.stop_reason !== 'end_turn' && msg.stop_reason !== 'max_tokens' && msg.stop_reason !== 'stop_sequence') continue;
      if (typeof row.uuid !== 'string' || seen.has(row.uuid)) continue;
      seen.add(row.uuid);
      id = msg.id || row.uuid;
      text = claudeReply(row);
      if (typeof id === 'string' && text && replies.has(id)) text = replies.get(id) + '\n' + text;
    } else if (provider === 'codex') {
      const p = row.payload;
      if (!p || typeof p !== 'object') continue;
      if (row.type === 'turn_context') model = modelLabel(p.model) ?? model;
      if (typeof p.turn_id === 'string') turn = p.turn_id;
      if (row.type !== 'event_msg' || !turn) continue;
      id = turn;
      // The pinned Remotea extractor understands both legacy and current final-answer events.
      text = rolloutFinalAnswer(line, turn);
    } else continue;
    if (typeof id !== 'string' || !id || id.length > 160 || !text?.trim()) continue;
    replies.set(id, text);
    if (replies.size > maxReplies) replies.delete(replies.keys().next().value!);
  }
  return fitReader({ replies: [...replies].map(([id, text]) => ({ id, text })), ...(model ? { model } : {}) }, maximumBytes);
}

/** Reads a bounded window of one proven foreground conversation on a Glass request only. */
export class GlassfaceReader {
  private cache = new Map<string, { stamp: string; reader: GlassfaceReaderView }>();

  async read(pid: number, record: SessionRecord, resumeFile?: string): Promise<GlassfaceReaderView | null> {
    const agent = record.agent;
    if (!agent) return null;
    try {
      let file: string | null = null;
      if (agent.provider === 'claude') {
        file = claudeTranscriptPath(defaultClaudeConfigDir(), record.cwd, agent.sessionId);
      } else if (agent.provider === 'codex' && resumeFile && codexThreadFromPath(resumeFile) === agent.sessionId) {
        file = resumeFile;
      } else if (agent.provider === 'codex') {
        // The caller verifies codexThreadFromFds (one root, excluding subagents).
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
          if (codexThreadFromPath(target) === agent.sessionId) { file = target; break; }
        }
      }
      if (!file) return null;
      const fd = await open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      try {
        const stat = await fd.stat();
        if (!stat.isFile()) return null;
        const stamp = [stat.dev, stat.ino, stat.mtimeMs, stat.size].join(':');
        const previous = this.cache.get(file);
        if (previous?.stamp === stamp) return previous.reader;
        const start = Math.max(0, stat.size - tailBytes);
        const buffer = Buffer.alloc(stat.size - start);
        let pos = 0;
        while (pos < buffer.length) {
          const {bytesRead} = await fd.read(buffer, pos, buffer.length - pos, start + pos);
          if (!bytesRead) break;
          pos += bytesRead;
        }
        const data = buffer.subarray(0, pos);
        // Skip a partial record at each window edge. The next poll picks up a completed append.
        const first = start ? data.indexOf(10) : -1;
        const end = data.lastIndexOf(10);
        const reader = parseReplies(agent.provider, agent.sessionId,
          (start && first < 0) || end < 0 ? '' : data.toString('utf8', first + 1, end));
        this.cache.delete(file);
        this.cache.set(file, { stamp, reader });
        if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!);
        return reader;
      } finally { await fd.close(); }
    } catch { return null; }
  }
}
