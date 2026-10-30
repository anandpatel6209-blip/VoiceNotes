import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptChunker } from '../src/shared/chunker.js';

describe('TranscriptChunker', () => {
  const sampleTranscript = [
    { start: 0, end: 10, text: 'Welcome to this comprehensive tutorial.' },
    { start: 10, end: 25, text: 'Today we will explore React hooks and lifecycle.' },
    { start: 25, end: 35, text: 'Specifically we cover useState and useEffect.' },
    { start: 35, end: 60, text: 'Let us begin with an example component.' },
    { start: 60, end: 90, text: 'Notice how state persists across re-renders.' }
  ];

  it('generates a chunk when video advances past chunkInterval', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'vid123' });
    chunker.setTranscript(sampleTranscript);

    // Initial tick at 10s -> not enough elapsed time
    const tick1 = chunker.onTimeUpdate(10);
    assert.equal(tick1, null);

    // Advance to 30s -> eligible chunk [0 - 30]
    const chunk = chunker.onTimeUpdate(30);
    assert.ok(chunk);
    assert.equal(chunk.chunkStartTime, 0);
    assert.equal(chunk.chunkEndTime, 30);
    assert.ok(chunk.chunkText.includes('Welcome to this comprehensive tutorial'));
    assert.ok(chunk.chunkText.includes('useState'));
  });

  it('prevents duplicate processing of the same interval', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'vid123' });
    chunker.setTranscript(sampleTranscript);

    const chunk1 = chunker.onTimeUpdate(30);
    assert.ok(chunk1);
    chunker.commitInterval(chunk1.intervalKey);

    // Call onTimeUpdate again at 30s
    const tickAgain = chunker.onTimeUpdate(30);
    assert.equal(tickAgain, null);
  });

  it('handles seeking backwards safely without crash or duplicate bursts', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'vid123' });
    chunker.setTranscript(sampleTranscript);

    // Play to 60s
    chunker.onTimeUpdate(30);
    chunker.commitInterval('0-30');
    chunker.onTimeUpdate(60);
    chunker.commitInterval('30-60');

    // Seek back to 15s
    const seekTick = chunker.onTimeUpdate(15, true);
    assert.equal(seekTick, null);

    // Advancing 5s after seek
    const tick2 = chunker.onTimeUpdate(20);
    assert.equal(tick2, null);
  });

  it('flushes final segment at end of video', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'vid123' });
    chunker.setTranscript(sampleTranscript);

    chunker.onTimeUpdate(30);
    chunker.commitInterval('0-30');
    chunker.onTimeUpdate(60);
    chunker.commitInterval('30-60');

    // At 75s (less than 30s after 60s), video ends
    const finalChunk = chunker.onTimeUpdate(75, false, true);
    assert.ok(finalChunk);
    assert.equal(finalChunk.chunkStartTime, 60);
    assert.equal(finalChunk.chunkEndTime, 75);
    assert.ok(finalChunk.chunkText.includes('state persists'));
  });

  it('allows retrying interval when job fails', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'vid123' });
    chunker.setTranscript(sampleTranscript);

    const chunk = chunker.onTimeUpdate(30);
    assert.ok(chunk);

    // Simulate failure
    chunker.failInterval(chunk.intervalKey);
    assert.equal(chunker.pendingIntervals.has(chunk.intervalKey), false);
    assert.equal(chunker.processedIntervals.has(chunk.intervalKey), false);
  });
});
