import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatNotesToMarkdown, generateExportFilename } from '../src/shared/exporter.js';

describe('Exporter Formatter', () => {
  const sampleNotes = [
    { id: '1', time: 15, text: 'First AI takeaway', source: 'ai' },
    { id: '2', time: 75, text: 'My own correction on hooks', source: 'user' },
    { id: '3', time: 130, text: 'Final conclusion', source: 'ai' }
  ];

  it('formats markdown with YouTube jump links and user badges', () => {
    const md = formatNotesToMarkdown({
      title: 'React Tutorial 2026',
      videoId: 'abc123xyz89',
      notes: sampleNotes,
      exportDate: new Date('2026-10-27T10:00:00Z')
    });

    assert.ok(md.includes('# React Tutorial 2026'));
    assert.ok(md.includes('- **Exported:** 2026-10-27'));
    assert.ok(md.includes('[Watch Video](https://www.youtube.com/watch?v=abc123xyz89)'));
    assert.ok(md.includes('- [00:15](https://www.youtube.com/watch?v=abc123xyz89&t=15s) First AI takeaway'));
    assert.ok(md.includes('- [01:15](https://www.youtube.com/watch?v=abc123xyz89&t=75s) **[YOU]** My own correction on hooks'));
    assert.ok(md.includes('- [02:10](https://www.youtube.com/watch?v=abc123xyz89&t=130s) Final conclusion'));
  });

  it('generates a clean sanitized export filename', () => {
    const filename = generateExportFilename('How to Code in JS / TS: 101', new Date('2026-10-27'));
    assert.equal(filename, 'VoiceNotes_How_to_Code_in_JS_TS_101_2026-10-27.md');
  });
});
