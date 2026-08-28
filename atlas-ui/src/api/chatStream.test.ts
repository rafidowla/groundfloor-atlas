/**
 * chatStream.test.ts — unit tests for the PURE SSE frame parser.
 *
 * parseSseBuffer is the testable heart of the streaming reader: it turns a
 * growing string buffer (as produced by repeated TextDecoder.decode calls)
 * into parsed events plus the leftover partial frame to carry forward. These
 * cases pin the B3b contract: complete frames parse, split frames are held
 * until whole, multiple frames preserve order, the terminal `done` frame
 * surfaces fullText, and malformed/blank frames are skipped without throwing.
 */

import { describe, it, expect } from 'vitest';
import { parseSseBuffer } from './chatStream';

describe('parseSseBuffer', () => {
  it('parses a single complete token frame and leaves empty rest', () => {
    const { events, rest } = parseSseBuffer('data: {"token":"hello"}\n\n');
    expect(events).toEqual([{ token: 'hello' }]);
    expect(rest).toBe('');
  });

  it('holds a frame split across two buffers until it is complete', () => {
    // First chunk has no frame delimiter yet — no events, whole thing held.
    const first = parseSseBuffer('data: {"token":"par');
    expect(first.events).toEqual([]);
    expect(first.rest).toBe('data: {"token":"par');

    // Second chunk completes the frame once we prepend the carried rest.
    const second = parseSseBuffer(first.rest + 'tial"}\n\n');
    expect(second.events).toEqual([{ token: 'partial' }]);
    expect(second.rest).toBe('');
  });

  it('returns multiple frames in order and holds a trailing partial as rest', () => {
    const buffer =
      'data: {"token":"a"}\n\n' +
      'data: {"token":"b"}\n\n' +
      'data: {"token":"c"';
    const { events, rest } = parseSseBuffer(buffer);
    expect(events).toEqual([{ token: 'a' }, { token: 'b' }]);
    expect(rest).toBe('data: {"token":"c"');
  });

  it('parses a terminal done frame with done:true and fullText', () => {
    const buffer =
      'data: {"done":true,"fullText":"hello world","provider":"anthropic","model":"claude-haiku-4-5"}\n\n';
    const { events, rest } = parseSseBuffer(buffer);
    expect(events).toEqual([
      {
        done: true,
        fullText: 'hello world',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    ]);
    expect(rest).toBe('');
  });

  it('parses contextWithheld on the terminal done frame (issues 6/B3)', () => {
    const buffer =
      'data: {"done":true,"fullText":"generic answer","provider":"anthropic","model":"claude-haiku-4-5","contextWithheld":true}\n\n';
    const { events } = parseSseBuffer(buffer);
    expect(events[0]).toMatchObject({ done: true, contextWithheld: true });
  });

  it('skips a non-JSON or blank frame without throwing', () => {
    const buffer =
      'data: not-json-at-all\n\n' + // malformed payload
      '\n\n' + // blank frame
      ': this is an SSE comment\n\n' + // no data line
      'data: {"token":"ok"}\n\n'; // valid, should survive
    let result!: ReturnType<typeof parseSseBuffer>;
    expect(() => {
      result = parseSseBuffer(buffer);
    }).not.toThrow();
    expect(result.events).toEqual([{ token: 'ok' }]);
    expect(result.rest).toBe('');
  });
});
