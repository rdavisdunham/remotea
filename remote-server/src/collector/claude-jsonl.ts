/**
 * Claude Code transcripts (`~/.claude/projects/<folder>/<session>.jsonl`),
 * ported from collector.py `claude_session` / `claude_sources`. Read as a
 * stream: a long session's transcript runs to tens of megabytes.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Transcript } from './transcript';
import { clip, pyStrip } from './redact';
import { environmentOf, shlexQuote } from './paths';
import { pyIso } from './iso';
import type { RepoLookup } from './git';
import type { FoundSession, Source } from './types';

type Entry = Record<string, any>;

function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c) && c.type === 'text')
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .join('\n');
  }
  return typeof content === 'string' ? content : '';
}

/** What a human typed in one user entry, or '' for meta, sidechain, system and tool-result entries. */
export function claudeText(entry: Entry): string {
  if (entry.isMeta || entry.isSidechain || entry.promptSource === 'system') return '';
  const kind = (entry.origin || {}).kind;
  if (kind !== undefined && kind !== null && kind !== 'human') return '';
  const text = textOf((entry.message || {}).content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const command = /^\s*<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (!command) return text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  return pyStrip(command[1] + ' ' + (args ? args[1] : ''));
}

export function claudeReply(entry: Entry): string {
  return textOf((entry.message || {}).content);
}

export async function claudeSession(file: string, side: 'wsl' | 'windows', repoOf: RepoLookup): Promise<FoundSession | null> {
  const t = new Transcript();
  const info = { cwd: '', branch: '', ai_title: '', custom_title: '', entry: '', prs: [] as string[], first: null as unknown, last: null as unknown };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    let d: Entry;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    const kind = d.type;
    if (d.timestamp) {
      info.first = info.first || d.timestamp;
      info.last = d.timestamp;
    }
    if (kind === 'custom-title') info.custom_title = d.customTitle || info.custom_title;
    else if (kind === 'ai-title') info.ai_title = d.aiTitle || info.ai_title;
    else if (kind === 'pr-link' && d.prUrl) info.prs.push(d.prUrl);
    else if ((kind === 'user' || kind === 'assistant') && !d.isSidechain) {
      info.cwd = d.cwd || info.cwd;
      info.branch = d.gitBranch || info.branch;
      info.entry = info.entry || d.entrypoint || '';
      if (kind === 'user') t.prompt(claudeText(d));
      else {
        const text = pyStrip(claudeReply(d));
        if (text) t.reply = text;
      }
    }
  }
  if (!t.turns) return null;
  let tool: FoundSession['tool'];
  let environment: string;
  if (side === 'windows') {
    tool = 'claude_desktop';
    environment = path.basename(path.dirname(file)).startsWith('ssh-') ? 'ssh' : environmentOf(info.cwd, 'windows');
  } else {
    tool = info.entry === 'claude-desktop' ? 'claude_desktop' : 'claude_code';
    environment = 'wsl';
  }
  const sid = path.basename(file, '.jsonl');
  const cwd = info.cwd;
  const title = info.custom_title || info.ai_title;
  const resume: Record<string, unknown> = environment === 'wsl' && cwd ? { cmd: `cd ${shlexQuote(cwd)} && claude --resume ${sid}` } : {};
  if (tool === 'claude_desktop') resume.hint = clip('Claude Desktop → Code → ' + (title || 'this session'), 200);
  return {
    tool,
    session_id: sid,
    environment,
    cwd,
    repo: environment === 'wsl' ? repoOf(cwd) : '',
    branch: info.branch === 'HEAD' ? '' : info.branch,
    title,
    transcript: t,
    pr_urls: [...new Set(info.prs)].slice(0, 20),
    started_at: pyIso(info.first),
    last_active_at: pyIso(info.last),
    resume,
  };
}

function visible(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  } catch {
    return [];
  }
}

function isDirent(dir: string, e: fs.Dirent, wantDir: boolean): boolean {
  if (e.isSymbolicLink()) {
    try {
      return fs.statSync(path.join(dir, e.name)).isDirectory() === wantDir;
    } catch {
      return false;
    }
  }
  return wantDir ? e.isDirectory() : e.isFile();
}

/** glob(root/*\/*.jsonl): one level of project folders; subagent transcripts (deeper) are skipped. */
export function claudeSources(root: string, side: 'wsl' | 'windows', repoOf: RepoLookup): Source[] {
  const out: Source[] = [];
  for (const d of visible(root)) {
    if (!isDirent(root, d, true)) continue;
    const dir = path.join(root, d.name);
    for (const f of visible(dir)) {
      if (!f.name.endsWith('.jsonl') || !isDirent(dir, f, false)) continue;
      const file = path.join(dir, f.name);
      let st: fs.BigIntStats;
      try {
        st = fs.statSync(file, { bigint: true });
      } catch {
        continue;
      }
      out.push({
        source: file,
        version: `${st.mtimeNs}:${st.size}`,
        modified: Number(st.mtimeNs) / 1e9,
        read: () => claudeSession(file, side, repoOf),
      });
    }
  }
  return out;
}

/** The transcript of one Claude session id, wherever its project folder is (for scanOne). */
export function claudeSourceFor(root: string, sessionId: string, side: 'wsl' | 'windows', repoOf: RepoLookup): Source | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  return claudeSources(root, side, repoOf).find((s) => path.basename(s.source) === `${sessionId}.jsonl`) ?? null;
}
