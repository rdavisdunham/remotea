import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClientMsg, ServerMsg, SessionRecord } from '../../src/shared/remote-host-protocol';
import { buildComposerWrites, sanitizeComposerText } from '../../src/shared/remote-input';
import { readClaudeSession, isCodexCli, codexThreadFromFds } from './agent-probe';
import { queuePaneMessage, type CodexPane } from './codex-pane-message';
import { readStat } from './proc';
import type { TermSession } from './session';

export type GlassfaceRequest = Extract<ClientMsg, { t: 'glassfaceInput' | 'glassfaceDaniInput' }>;
type Status = Extract<ServerMsg, { t: 'glassfaceReceipt' }>['status'];
export interface GlassfaceTarget {
  session: Pick<TermSession, 'pid' | 'state' | 'composerScreen' | 'write' | 'inputRevision'>;
  record: SessionRecord;
  firstPrompt?: string;
  nativeQueue?: CodexPane;
}

/** A shell with an agent descendant is unsafe: the descendant can exit back to a shell. */
export function foregroundAgent(pid: number, provider: string, conversation: string): boolean {
  const stat = readStat(pid);
  if (!stat || stat.pgrp !== pid || stat.tpgid !== pid) return false;
  try {
    if (provider === 'claude') {
      const bin = process.env.REMOTEA_GLASSFACE_CLAUDE_BIN ?? path.join(os.homedir(), '.local/bin/claude');
      const expected = fs.statSync(bin);
      const actual = fs.statSync(`/proc/${pid}/exe`);
      return actual.dev === expected.dev && actual.ino === expected.ino && readClaudeSession(pid) === conversation;
    }
    return provider === 'codex' && isCodexCli(pid) && codexThreadFromFds(pid) === conversation;
  } catch {
    return false;
  }
}

/** The normal Glass launcher starts one native process, directly, with this finite argument grammar. */
export function firstCodexProcess(pid: number, rec: SessionRecord): boolean {
  try {
    const st = readStat(pid);
    if (rec.agent || rec.turnSeq || st?.pgrp !== pid || st.tpgid !== pid || !isCodexCli(pid) ||
      rec.turnCursor || rec.eridani || rec.incarnation !== 1 || fs.realpathSync(rec.cwd) !== fs.readlinkSync(`/proc/${pid}/cwd`)) return false;
    const bin = process.env.REMOTEA_GLASSFACE_CODEX_BIN ?? path.join(os.homedir(), '.local/bin/codex');
    const expected = fs.statSync(bin);
    const actual = fs.statSync(`/proc/${pid}/exe`);
    if (expected.dev !== actual.dev || expected.ino !== actual.ino) return false;
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, -1);
    if (argv[0] !== bin || argv[1] !== '--model' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(argv[2] ?? '') ||
        argv[3] !== '-c' || argv[4] !== 'check_for_update_on_startup=false' ||
        !(argv.length === 5 || (argv.length === 7 && argv[5] === '-c' &&
          /^model_reasoning_effort="(?:none|minimal|low|medium|high|xhigh|max|ultra)"$/.test(argv[6])))) return false;
    fs.accessSync(`/proc/${pid}/fd`, fs.constants.R_OK | fs.constants.X_OK);
    return rec.cmd === 'exec ' + argv.map(s => "'" + s.replaceAll("'", "'\\''") + "'").join(' ') &&
      codexThreadFromFds(pid) === undefined;
  } catch { return false; }
}

export function promptIdentity(rec: SessionRecord, inputRevision: number): string {
  return JSON.stringify([rec.turnCursor?.opened ?? null, rec.turnCursor?.captured ?? null,
    rec.turnSeq ?? null, rec.agentState?.since ?? null, rec.chatAttention?.revision ?? null, inputRevision]);
}

/** Match the native text composer, including its boundaries. A menu, trust question,
 * previously typed text or an unfamiliar layout requires using the desktop. */
type ComposerScreen = NonNullable<Awaited<ReturnType<TermSession['composerScreen']>>>;
export function composerShows(provider: string, screen: ComposerScreen, text: string): boolean {
  const rows = screen.lines.map(line => line.trimEnd());
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  if (provider === 'claude') {
    const border = (line: string) => /^\s*[─━]{8,}\s*$/u.test(line);
    let bottom = rows.length - 1;
    while (bottom >= 0 && !border(rows[bottom])) bottom--;
    if (bottom < 2 || rows.length - bottom > 4) return false;
    const footer = rows.slice(bottom + 1).join(' ');
    if (!/(?:\? for shortcuts|(?:auto mode|accept edits|plan mode|default mode|bypass permissions) on \(shift\+tab to cycle\))/i.test(footer)
      || /\b(confirm|cancel|approve|esc to|enter to select)\b/i.test(footer)) return false;
    let top = bottom - 1;
    while (top >= 0 && !border(rows[top])) top--;
    if (top < 0 || screen.cursorRow <= top || screen.cursorRow >= bottom || !/^\s*❯(?:\s|$)/u.test(rows[top + 1])) return false;
    if (text === '' && screen.suggestionRow === top + 1 && bottom === top + 2) return true;
    const content = rows.slice(top + 1, bottom);
    content[0] = content[0].replace(/^\s*❯[ \u00a0]?/u, '');
    return content.join('').trimEnd() === text || content.map(s => s.trim()).join(' ').trim() === text;
  }
  if (provider === 'codex') {
    // Direct native Codex with an empty prompt/echo and its context footer.
    let marker = screen.cursorRow;
    while (marker >= 0 && !/^\s*›(?:\s|$)/u.test(rows[marker])) marker--;
    if (marker < 0 || screen.cursorRow >= rows.length - 1 || rows.length - screen.cursorRow > 4) return false;
    const footer = rows.slice(screen.cursorRow + 1).map(s => s.trim()).filter(Boolean);
    const oldFooter = footer.length > 0 && footer.every(s => /\b\d+%\s+(?:context\s+)?left\b/i.test(s));
    const shortcuts = /^(?:← for agents · \? for shortcuts)?(?:\s*⚠ \d+ warnings? · f2 to view)?$/u;
    const codexFooter = footer.length > 0 && footer.length <= 2 &&
      /^GPT-[\w.-]+(?: (?:default|none|minimal|low|medium|high|xhigh|max|ultra))? · (?:~|\/)/iu.test(footer[0]) &&
      (footer.length === 1 || shortcuts.test(footer[1]));
    if (!oldFooter && !codexFooter) return false;
    if (!text && marker === screen.cursorRow && screen.suggestionRow === marker) return true;
    const echoed = rows.slice(marker, screen.cursorRow + 1);
    echoed[0] = echoed[0].replace(/^\s*› ?/u, '');
    return echoed.join('').trimEnd() === text || echoed.map(s => s.trim()).join(' ').trim() === text;
  }
  return false;
}

export class GlassfaceInput {
  private readonly busy = new Set<string>();
  private readonly receipts = new Map<string, { signature: string; status: Status; providerMessageId?: string }>();

  constructor(private readonly enqueue = queuePaneMessage) {}

  providerReceipt(operation: string): string | undefined {
    return this.receipts.get(operation)?.providerMessageId;
  }

  async send(m: GlassfaceRequest, bootId: string, authorized: () => boolean,
    target: () => GlassfaceTarget | null, foreground: typeof foregroundAgent,
    human: (data: string) => void,
    questionCurrent?: (rec: SessionRecord, revision: number, turn: string) => boolean, device = ''): Promise<Status> {
    if (!authorized() || m.bootId !== bootId || !m.text.trim() || m.text !== m.text.trim()
      || sanitizeComposerText(m.text) !== m.text || /[\n\t\r]/.test(m.text) || /^[!/]/.test(m.text)
      || Buffer.byteLength(m.text) > 4000) return 'refused';
    const signature = createHash('sha256').update(JSON.stringify([device, m.id, m.bootId, m.incarnation,
      m.provider, m.conversation, m.expectedPrompt, m.text, m.t, m.t === 'glassfaceDaniInput' ? m.turn : null])).digest('hex');
    const previous = this.receipts.get(m.operationId);
    if (previous) return previous.signature === signature ? previous.status : 'refused';
    // Keep the whole boot's replay fence. At capacity require a new gateway/host boot.
    if (this.receipts.size >= 65536 || this.busy.has(m.id)) return 'refused';
    const original = target();
    if (!original) return 'refused';
    const session = original.session;
    const revision = session.inputRevision;
    const group = original.record.groupId;
    const queue = original.nativeQueue;
    const sameProvider = (current: GlassfaceTarget) => queue
      ? current.nativeQueue?.pid === queue.pid && current.nativeQueue.fileKey === queue.fileKey
      : !!session.pid && foreground(session.pid, m.provider, m.conversation);
    const valid = (pasted: boolean) => {
      const current = target();
      const rec = current?.record;
      return authorized() && current?.session === session && session.state === 'live' && !!session.pid &&
        rec?.state === 'live' && rec.bootId === bootId && rec.groupId === group && rec.incarnation === m.incarnation && !rec.eridani &&
        ((rec.agent?.provider === m.provider && rec.agent.sessionId === m.conversation && sameProvider(current))
          || (!rec.agent && m.t === 'glassfaceInput' && m.provider === 'codex' && revision === 0 &&
            !!current.firstPrompt && current.firstPrompt === m.conversation)) &&
        (!rec.agentState || rec.agentState.state === 'idle') && !rec.agentState?.trouble &&
        (m.t !== 'glassfaceDaniInput' || questionCurrent?.(rec, revision, m.turn) === true) &&
        session.inputRevision === revision + Number(pasted) && promptIdentity(rec, revision) === m.expectedPrompt;
    };
    const receipt: { signature: string; status: Status; providerMessageId?: string } = { signature, status: 'uncertain' };
    this.receipts.set(m.operationId, receipt);
    this.busy.add(m.id);
    try {
      if (!valid(false)) return receipt.status = 'refused';
      const before = await session.composerScreen();
      if (!before?.bracketed || !composerShows(m.provider, before, '') || !valid(false))
        return receipt.status = 'refused';
      if (queue) {
        // Reserve the reviewed prompt before the asynchronous provider call. An
        // ambiguous launch burns this operation; a second request cannot replay it.
        session.inputRevision++;
        const ack = await this.enqueue(queue, m.conversation, m.text);
        if (!ack) return receipt.status;
        receipt.providerMessageId = ack;
        receipt.status = 'queued';
        human('\r');
        return receipt.status;
      }
      const [paste, enter] = buildComposerWrites(m.text, { bracketed: true, submit: true });
      human(paste);
      session.write(paste);
      receipt.status = 'partial';
      // A busy TUI can repaint after the 40 ms paste/Enter separation. Only
      // its positive echo of the complete reviewed text permits the submit.
      // A new Codex can briefly offer to queue the text during startup. Wait for
      // the ordinary composer to echo it without submitting to the queue.
      const attempts = original.firstPrompt ? 150 : 12;
      for (let attempt = 0; attempt < attempts; attempt++) {
        await delay(40);
        if (!valid(true)) return 'partial';
        const after = await session.composerScreen();
        if (!valid(true)) return 'partial';
        if (!after && original.firstPrompt) continue; // A startup repaint can still be draining.
        if (!after?.bracketed) return 'partial';
        if (!composerShows(m.provider, after, m.text)) continue;
        human(enter);
        receipt.status = 'uncertain'; // an exception during the write has ambiguous effects
        session.write(enter);
        return receipt.status = 'submitted';
      }
      return 'partial';
    } catch {
      return receipt.status;
    } finally {
      this.busy.delete(m.id);
    }
  }
}
