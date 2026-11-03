import { describe, expect, it } from 'vitest';
import { ManagedTranscript, transcriptText, TRANSCRIPT_TOOL_LIMIT } from '../src/managed-transcript';

function fixture() { const chunks: string[] = []; const transcript = new ManagedTranscript(text => chunks.push(text)); return { transcript, chunks, text: () => chunks.join('') }; }

describe('readable managed transcript', () => {
  it('separates Codex user, assistant and bounded tool output without printing provider JSON or private reasoning', () => {
    const f = fixture(); f.transcript.user('Review the tests.');
    f.transcript.event({ method: 'item/started', params: { item: { id: 'reasoning', type: 'reasoning', text: 'PRIVATE REASONING' } } });
    f.transcript.event({ method: 'item/agentMessage/delta', params: { itemId: 'commentary', delta: 'I will inspect the tests.\n' } });
    f.transcript.event({ method: 'item/completed', params: { item: { id: 'commentary', type: 'agentMessage', text: 'I will inspect the tests.\n' } } });
    f.transcript.event({ method: 'item/started', params: { item: { id: 'test', type: 'commandExecution', command: 'npm test' } } });
    f.transcript.event({ method: 'item/commandExecution/outputDelta', params: { itemId: 'test', delta: '\u001b[32m3 tests passed\u001b[0m\n' } });
    f.transcript.event({ method: 'item/completed', params: { item: { id: 'test', type: 'commandExecution', exitCode: 0 } } });
    f.transcript.event({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'All tests pass.' } });
    f.transcript.event({ method: 'item/completed', params: { item: { id: 'answer', type: 'agentMessage', text: 'All tests pass.' } } });
    f.transcript.event({ method: 'turn/completed', params: {} });
    expect(f.text()).toContain('── User · Turn 1 ──\nReview the tests.\n');
    expect(f.text()).toContain('── Assistant ──\nI will inspect the tests.\n');
    expect(f.text()).toContain('── Tool · Command ──\n  npm test\n  │ 3 tests passed\n  [Exit 0]');
    expect(f.text()).toContain('── Assistant ──\nAll tests pass.\n');
    expect(f.text().match(/All tests pass\./g)).toHaveLength(1); expect(f.text()).not.toContain('PRIVATE REASONING'); expect(f.text()).not.toContain('"method"'); expect(f.text()).not.toContain('\u001b');
  });
  it('supports Claude stream and final-only messages, deduplicates full text and shows tool result summaries', () => {
    const f = fixture(); f.transcript.user('Inspect a file.');
    f.transcript.event({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
    f.transcript.event({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Reading the file.\n' } } });
    f.transcript.event({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'read', name: 'Read', input: {} } } });
    f.transcript.event({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Reading the file.\n' }, { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/repo/README.md' } }] } });
    f.transcript.event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: '{"status":"ok","content":"LOTS OF RAW JSON"}' }] } });
    f.transcript.event({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'The file describes the project.' }] } });
    f.transcript.event({ type: 'result', result: 'The file describes the project.' });
    expect(f.text().match(/Reading the file\./g)).toHaveLength(1); expect(f.text().match(/The file describes the project\./g)).toHaveLength(1);
    expect(f.text().match(/── Tool · Read ──/g)).toHaveLength(1); expect(f.text()).toContain('/repo/README.md'); expect(f.text()).toContain('Structured result · 2 fields'); expect(f.text()).not.toContain('LOTS OF RAW JSON');
  });
  it('redacts secrets split over provider chunks and strips split terminal escape sequences', () => {
    const f = fixture(); f.transcript.user('Show a safe result.');
    f.transcript.assistantDelta('\u001b]52;c;'); f.transcript.assistantDelta('clipboard-content\u0007Safe\n');
    f.transcript.assistantDelta('Credential: sk-proj-'); f.transcript.assistantDelta('A'.repeat(40) + '\n');
    f.transcript.assistantDelta('-----BEGIN PRIVATE KEY-----\n'); f.transcript.assistantDelta('HIDDEN_KEY_BODY\n'); f.transcript.assistantDelta('-----END PRIVATE KEY-----\n'); f.transcript.endTurn();
    expect(f.text()).toContain('Safe'); expect(f.text()).toContain('[redacted]');
    for (const chunk of f.chunks) { expect(chunk).not.toContain('A'.repeat(20)); expect(chunk).not.toContain('HIDDEN_KEY_BODY'); expect(chunk).not.toContain('clipboard-content'); expect(chunk).not.toContain('\u001b'); }
    expect(transcriptText('one\r\ntwo\rthree\u009b2J\u0000')).toBe('one\ntwo\nthree');
  });
  it('caps noisy tool logs and clearly marks omitted output', () => {
    const f = fixture(); f.transcript.toolStart('build', 'Command', { command: 'npm test' }); f.transcript.toolOutput('build', ('a long test log line\n').repeat(1_000)); f.transcript.toolEnd('build', 'Exit 1');
    expect(f.text()).toContain('Further tool output hidden'); expect(f.text()).toContain('[Exit 1]'); expect(f.text().length).toBeLessThan(TRANSCRIPT_TOOL_LIMIT + 500); expect(f.text().split('\n').length).toBeLessThan(50);
  });
  it('keeps turns and status notices distinct even when text has no trailing newline', () => {
    const f = fixture(); f.transcript.user('First'); f.transcript.assistantDelta('First reply'); f.transcript.endTurn(); f.transcript.notice('Waiting for approval'); f.transcript.user('Second'); f.transcript.assistantComplete('Second reply'); f.transcript.endTurn();
    expect(f.text()).toContain('First reply\n\n'); expect(f.text()).toContain('── Status ──\nWaiting for approval\n'); expect(f.text()).toContain('── User · Turn 2 ──\nSecond\n'); expect(f.text()).not.toContain('First replySecond');
  });
  it('formats a recovered final-only response without inventing a user turn or leaking raw payloads', () => {
    const f = fixture(); f.transcript.event({ method: 'unknown/debug', params: { raw: { internal: 'DO NOT DUMP' } } }); f.transcript.event({ type: 'result', result: 'Recovered final response.' });
    expect(f.text()).toContain('── Assistant ──\nRecovered final response.\n'); expect(f.text()).not.toContain('User'); expect(f.text()).not.toContain('DO NOT DUMP');
  });
});
