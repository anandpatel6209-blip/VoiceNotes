import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime,
  parseTime,
  unescapeHtml,
  validateNote,
  parseNotesResponse,
  sanitizeFilename
} from '../src/shared/validator.js';

describe('Validator Utilities', () => {
  it('formats seconds into mm:ss and hh:mm:ss', () => {
    assert.equal(formatTime(0), '00:00');
    assert.equal(formatTime(45), '00:45');
    assert.equal(formatTime(125), '02:05');
    assert.equal(formatTime(3665), '01:01:05');
  });

  it('parses mm:ss and hh:mm:ss strings to seconds', () => {
    assert.equal(parseTime('02:05'), 125);
    assert.equal(parseTime('01:01:05'), 3665);
    assert.equal(parseTime(90), 90);
    assert.equal(parseTime('invalid'), 0);
  });

  it('unescapes HTML entities correctly', () => {
    assert.equal(unescapeHtml('&lt;div&gt;Hello &amp; welcome &#39;world&#39;&quot;&lt;/div&gt;'), "<div>Hello & welcome 'world'\"</div>");
    assert.equal(unescapeHtml('Normal text'), 'Normal text');
  });

  it('validates note shape and sanitizes content', () => {
    const valid = validateNote({
      id: 'custom_1',
      time: 120,
      text: '   Explains useEffect dependency array   ',
      source: 'ai'
    });

    assert.equal(valid.id, 'custom_1');
    assert.equal(valid.time, 120);
    assert.equal(valid.text, 'Explains useEffect dependency array');
    assert.equal(valid.source, 'ai');
    assert.equal(valid.edited, false);
    assert.ok(valid.createdAt > 0);
  });

  it('rejects notes with empty or non-string text', () => {
    assert.equal(validateNote({ id: '1', time: 10, text: '' }), null);
    assert.equal(validateNote({ id: '2', time: 10, text: '   ' }), null);
    assert.equal(validateNote(null), null);
  });

  it('parses AI response with markdown code fences', () => {
    const raw = "```json\n[\n  {\"time\": 30, \"text\": \"First point\"},\n  {\"time\": 45, \"text\": \"Second point\"}\n]\n```";
    const notes = parseNotesResponse(raw, 30);
    assert.equal(notes.length, 2);
    assert.equal(notes[0].text, 'First point');
    assert.equal(notes[1].time, 45);
  });

  it('parses AI response wrapped in explanatory text', () => {
    const raw = "Here are the notes from the video:\n[{\"time\": 60, \"text\": \"Core insight\"}]\nHope this helps!";
    const notes = parseNotesResponse(raw, 60);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, 'Core insight');
  });

  it('sanitizes export filenames', () => {
    assert.equal(sanitizeFilename('React / TypeScript: Complete Guide *2026*?'), 'React_TypeScript_Complete_Guide_2026');
    assert.equal(sanitizeFilename(''), 'VoiceNotes_Export');
  });
});
