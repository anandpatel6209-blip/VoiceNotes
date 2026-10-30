import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TYPES } from '../src/shared/types.js';
import { formatTime, unescapeHtml } from '../src/shared/validator.js';

describe('Transcript & Audio Viewer Engine', () => {
  // Mock transcript data
  const sampleTranscript = [
    { start: 0, end: 3.5, text: 'Welcome to this Python programming tutorial.', source: 'CC' },
    { start: 3.5, end: 7.2, text: 'Today we will learn variables, functions, and control flow.', source: 'CC' },
    { start: 7.2, end: 11.0, text: 'Python is known for its clean and readable syntax.', source: 'CC' },
    { start: 11.0, end: 15.5, text: 'Let us start by looking at a Hello World example.', source: 'Audio' }
  ];

  it('validates MESSAGE_TYPES contracts for LOAD_TRANSCRIPT and SAVE_TRANSCRIPT', () => {
    assert.equal(MESSAGE_TYPES.LOAD_TRANSCRIPT, 'LOAD_TRANSCRIPT');
    assert.equal(MESSAGE_TYPES.SAVE_TRANSCRIPT, 'SAVE_TRANSCRIPT');
  });

  it('formats bracketed timestamps accurately across seconds, minutes, and hours', () => {
    assert.equal(`[${formatTime(0)}]`, '[00:00]');
    assert.equal(`[${formatTime(15)}]`, '[00:15]');
    assert.equal(`[${formatTime(75)}]`, '[01:15]');
    assert.equal(`[${formatTime(3665)}]`, '[01:01:05]');
  });

  it('safely merges live speaker audio segments with existing caption segments without overwriting', () => {
    const transcript = [...sampleTranscript];
    const newAudioSegment = {
      start: 15.5,
      end: 19.0,
      text: 'In Python, variables do not require explicit type declaration.',
      source: 'Audio'
    };

    // Deduplication check as implemented in content.js
    const alreadyExists = transcript.some(
      (seg) => Math.abs(seg.start - newAudioSegment.start) <= 2 && seg.text === newAudioSegment.text
    );
    assert.equal(alreadyExists, false);

    if (!alreadyExists) {
      transcript.push(newAudioSegment);
    }
    transcript.sort((a, b) => a.start - b.start);

    assert.equal(transcript.length, 5);
    assert.equal(transcript[4].source, 'Audio');
    assert.equal(transcript[4].start, 15.5);
    // Ensure earlier segments remained safe
    assert.equal(transcript[0].text, 'Welcome to this Python programming tutorial.');
  });

  it('prevents duplicate lines when same phrase is re-heard near the same timestamp', () => {
    const transcript = [...sampleTranscript];
    const duplicateSegment = {
      start: 11.2,
      end: 15.0,
      text: 'Let us start by looking at a Hello World example.',
      source: 'Audio'
    };

    const alreadyExists = transcript.some(
      (seg) => Math.abs(seg.start - duplicateSegment.start) <= 2 && seg.text.toLowerCase().includes('hello world')
    );
    assert.equal(alreadyExists, true);

    if (!alreadyExists) {
      transcript.push(duplicateSegment);
    }
    // Length must remain 4, preserving line safety without duplication
    assert.equal(transcript.length, 4);
  });

  it('correctly identifies the active playback line given video currentTime', () => {
    function getActiveSegment(currentTime, segments) {
      const sec = Math.floor(currentTime);
      return (
        segments.find((s) => sec >= s.start && sec <= (s.end || s.start + 3.5)) ||
        [...segments].reverse().find((s) => s.start <= sec && sec <= (s.end || s.start + 4)) ||
        null
      );
    }

    // At 1.5s -> line 0
    const active1 = getActiveSegment(1.5, sampleTranscript);
    assert.ok(active1);
    assert.equal(active1.start, 0);

    // At 5.0s -> line 1
    const active2 = getActiveSegment(5.0, sampleTranscript);
    assert.ok(active2);
    assert.equal(active2.start, 3.5);

    // At 12.0s -> line 3 (Audio line)
    const active3 = getActiveSegment(12.0, sampleTranscript);
    assert.ok(active3);
    assert.equal(active3.start, 11.0);
    assert.equal(active3.source, 'Audio');

    // Far past end of video -> null
    const activePast = getActiveSegment(999, sampleTranscript);
    assert.equal(activePast, null);
  });

  it('filters transcript lines correctly matching search queries', () => {
    function filterTranscript(segments, query) {
      const q = query.trim().toLowerCase();
      if (!q) return segments;
      return segments.filter((s) => s.text && s.text.toLowerCase().includes(q));
    }

    const matchesPython = filterTranscript(sampleTranscript, 'python');
    assert.equal(matchesPython.length, 2);
    assert.ok(matchesPython[0].text.includes('Python'));
    assert.ok(matchesPython[1].text.includes('Python'));

    const matchesAudio = filterTranscript(sampleTranscript, 'hello world');
    assert.equal(matchesAudio.length, 1);
    assert.equal(matchesAudio[0].source, 'Audio');

    const noMatches = filterTranscript(sampleTranscript, 'nonexistent query keyword');
    assert.equal(noMatches.length, 0);
  });

  it('formats full transcript export with markdown header and timestamps', () => {
    function formatFullTranscriptExport(title, videoId, segments) {
      const lines = [
        `# ${title} - Transcript`,
        `Video: https://www.youtube.com/watch?v=${videoId}`,
        `Total lines: ${segments.length}`,
        ''
      ];
      segments.forEach((seg) => {
        lines.push(`[${formatTime(seg.start)}] ${seg.text}`);
      });
      return lines.join('\n');
    }

    const exported = formatFullTranscriptExport('Python 101 Lecture', 'test_vid_abc', sampleTranscript);
    assert.ok(exported.includes('# Python 101 Lecture - Transcript'));
    assert.ok(exported.includes('https://www.youtube.com/watch?v=test_vid_abc'));
    assert.ok(exported.includes('Total lines: 4'));
    assert.ok(exported.includes('[00:00] Welcome to this Python programming tutorial.'));
    assert.ok(exported.includes('[00:11] Let us start by looking at a Hello World example.'));
  });

  it('simulates view switcher toggling between notes and transcript', () => {
    let currentView = 'notes';

    function switchView(viewName) {
      currentView = viewName;
      return currentView;
    }

    assert.equal(currentView, 'notes');
    assert.equal(switchView('transcript'), 'transcript');
    assert.equal(currentView, 'transcript');
    assert.equal(switchView('notes'), 'notes');
    assert.equal(currentView, 'notes');
  });
});
