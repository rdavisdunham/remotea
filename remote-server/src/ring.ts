/**
 * Bounded history of a session's output chunks, keyed by seq.
 *
 * Lets a client that missed only a little (a short sleep, a Wi-Fi blip)
 * catch up by replaying exactly the chunks after the last seq it applied,
 * instead of receiving a whole screen + scrollback snapshot.
 */
export class Ring {
  private items: Array<[number, string]> = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(seq: number, chunk: string): void {
    this.items.push([seq, chunk]);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.items.length > 1) {
      const dropped = this.items.shift()!;
      this.bytes -= dropped[1].length;
    }
  }

  /**
   * True when every chunk after `seq` is still held, given that `head` is the
   * newest seq produced. A client that is already at `head` is trivially covered.
   */
  coversAfter(seq: number, head: number): boolean {
    if (seq > head) return false;
    if (seq === head) return true;
    return this.items.length > 0 && this.items[0][0] <= seq + 1;
  }

  after(seq: number): Array<[number, string]> {
    let i = this.items.length;
    while (i > 0 && this.items[i - 1][0] > seq) i--;
    return this.items.slice(i);
  }

  get size(): number {
    return this.bytes;
  }
}
