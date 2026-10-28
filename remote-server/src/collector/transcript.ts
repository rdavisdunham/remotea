/** What the ledger keeps of one session, not the whole conversation (collector.py `Transcript`). */
import { clip, pyStrip } from './redact';

export const NOISE = ['<local-command', '<system-reminder>', 'Caveat: The messages below', '[Request interrupted'];
/** Voice-delegated ChatGPT desktop prompts arrive wrapped in these tags. */
export const WRAPPERS = /<\/?(?:realtime_delegation|input)>/g;

export class Transcript {
  firstPrompt = '';
  /** At most the last 3 prompts (a deque with maxlen 3). */
  recent: string[] = [];
  turns = 0;
  reply = '';

  prompt(text: string | null | undefined): void {
    const t = pyStrip((text || '').replace(WRAPPERS, ''));
    if (!t || NOISE.some((n) => t.startsWith(n))) return;
    this.firstPrompt = this.firstPrompt || t;
    this.append(t);
    this.turns += 1;
  }

  append(t: string): void {
    this.recent.push(t);
    if (this.recent.length > 3) this.recent.shift();
  }

  /** deque.appendleft on a full deque drops from the right. */
  appendLeft(t: string): void {
    this.recent.unshift(t);
    if (this.recent.length > 3) this.recent.pop();
  }

  excerpt(): string {
    const prompts = this.recent.map((p) => '- ' + clip(p, 1200)).join('\n');
    const reply = clip(this.reply, 2500);
    return 'Recent prompts:\n' + prompts + (reply ? '\n\nLast reply:\n' + reply : '');
  }
}
