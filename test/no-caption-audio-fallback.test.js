import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_STATES, SourceStateMachine, normalizeTranscriptItem, isDuplicateSegment } from '../src/shared/source-manager.js';
import { TranscriptChunker } from '../src/shared/chunker.js';
import { parseNotesResponse } from '../src/shared/validator.js';
import { formatNotesToMarkdown } from '../src/shared/exporter.js';

describe('No-Caption Video Speaker Audio Fallback & Note Generation', () => {
  it('transitions cleanly to AUDIO_FALLBACK when no captions or transcripts are found', () => {
    const transitions = [];
    const sm = new SourceStateMachine((evt) => transitions.push(evt.state));

    assert.equal(sm.getState(), SOURCE_STATES.INITIALIZING);

    // 1. Extension begins detecting sources on YouTube video load
    sm.transitionTo(SOURCE_STATES.DETECTING_SOURCES);
    assert.equal(sm.getState(), SOURCE_STATES.DETECTING_SOURCES);

    // 2. Both TimedText and native transcript panel return 0 tracks -> Immediate fallback
    sm.transitionTo(SOURCE_STATES.AUDIO_FALLBACK, 'Listening to speaker audio');
    assert.equal(sm.getState(), SOURCE_STATES.AUDIO_FALLBACK);
    assert.equal(sm.getStatusMessage(), 'Listening to speaker audio');

    assert.deepEqual(transitions, [
      SOURCE_STATES.DETECTING_SOURCES,
      SOURCE_STATES.AUDIO_FALLBACK
    ]);
  });

  it('collects, normalizes, and filters speaker audio transcript segments without gibberish', () => {
    const transcript = [];

    // Helper simulating audio recognition onresult
    function handleAudioResult(currentTime, rawText) {
      // Filter out breath/click noise
      const isNoise = /^(g+h+|ggh|ghh|h+g+|uh+|um+|mm+|ah+|eh+|shh|tsk|zzz)$/i.test(rawText.trim().toLowerCase());
      if (isNoise || rawText.trim().length < 3) return;

      const candidate = normalizeTranscriptItem({
        videoId: 'no_cc_video_101',
        start: currentTime,
        end: currentTime + 3,
        text: rawText,
        source: 'Audio'
      });

      if (!isDuplicateSegment(transcript, candidate, 4)) {
        transcript.push(candidate);
      }
    }

    // 1. Noise/clicks occur (should be ignored)
    handleAudioResult(2, 'ggh');
    handleAudioResult(4, 'shh');
    assert.equal(transcript.length, 0);

    // 2. Real speaker begins explaining concept at 8s
    handleAudioResult(8, 'Welcome to this recorded lecture.');
    handleAudioResult(15, 'There are no subtitles on this video.');
    handleAudioResult(24, 'We will explain neural network weights and biases.');

    // 3. Duplicate spoken phrase near 25s
    handleAudioResult(25, 'neural network weights and biases');

    assert.equal(transcript.length, 3);
    assert.equal(transcript[0].source, 'Audio');
    assert.equal(transcript[0].text, 'Welcome to this recorded lecture.');
    assert.equal(transcript[1].start, 15);
    assert.equal(transcript[2].start, 24);
  });

  it('chunks speaker audio transcript every ~30s and synthesizes notes', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'no_cc_video_101' });

    const speakerTranscript = [
      { start: 5, end: 9, text: 'Machine learning models learn patterns from training data.' },
      { start: 14, end: 19, text: 'Supervised learning requires labeled input-output pairs.' },
      { start: 22, end: 28, text: 'Loss functions measure how far predictions are from ground truth.' },
      { start: 34, end: 40, text: 'Gradient descent iteratively updates weights to minimize loss.' },
      { start: 45, end: 52, text: 'Learning rate controls the step size in each iteration.' }
    ];

    chunker.setTranscript(speakerTranscript);

    // At 30s: first interval [0 - 30] is eligible
    const chunk1 = chunker.onTimeUpdate(30);
    assert.ok(chunk1);
    assert.equal(chunk1.chunkStartTime, 0);
    assert.equal(chunk1.chunkEndTime, 30);
    assert.ok(chunk1.chunkText.includes('Machine learning models learn patterns'));
    assert.ok(chunk1.chunkText.includes('Loss functions measure'));

    // Simulate AI response for chunk 1
    const rawAiOutput1 = JSON.stringify([
      { time: 5, text: 'Machine learning discovers patterns from training data.' },
      { time: 22, text: 'Loss functions quantify prediction errors against ground truth.' }
    ]);
    const notes1 = parseNotesResponse(rawAiOutput1, 0);
    assert.equal(notes1.length, 2);
    chunker.commitInterval(chunk1.intervalKey);

    // At 60s: second interval [30 - 60] is eligible
    const chunk2 = chunker.onTimeUpdate(60);
    assert.ok(chunk2);
    assert.equal(chunk2.chunkStartTime, 30);
    assert.equal(chunk2.chunkEndTime, 60);
    assert.ok(chunk2.chunkText.includes('Gradient descent iteratively updates'));
    assert.ok(chunk2.chunkText.includes('Learning rate controls the step size'));

    const rawAiOutput2 = JSON.stringify([
      { time: 34, text: 'Gradient descent minimizes loss by updating parameters iteratively.' },
      { time: 45, text: 'Learning rate dictates the magnitude of parameter updates.' }
    ]);
    const notes2 = parseNotesResponse(rawAiOutput2, 30);
    assert.equal(notes2.length, 2);
    chunker.commitInterval(chunk2.intervalKey);

    const allNotes = [...notes1, ...notes2];
    assert.equal(allNotes.length, 4);
    assert.equal(allNotes[0].time, 5);
    assert.equal(allNotes[3].time, 45);
  });

  it('flushes final speaker audio chunk when video reaches end', () => {
    const chunker = new TranscriptChunker({ chunkInterval: 30, videoId: 'no_cc_video_101' });

    chunker.setTranscript([
      { start: 10, end: 15, text: 'Point in first chunk' },
      { start: 35, end: 42, text: 'In conclusion, practice gradient descent with different rates.' }
    ]);

    chunker.onTimeUpdate(30);
    chunker.commitInterval('0-30');

    // Video is 48s long and ends
    const finalChunk = chunker.onTimeUpdate(48, false, true);
    assert.ok(finalChunk);
    assert.equal(finalChunk.chunkStartTime, 30);
    assert.equal(finalChunk.chunkEndTime, 48);
    assert.ok(finalChunk.chunkText.includes('In conclusion'));
  });

  it('exports combined notes with timestamp jump links and full speaker audio transcript', () => {
    const notes = [
      { id: 'n1', time: 5, text: 'Supervised learning requires labeled training data.', source: 'ai' },
      { id: 'n2', time: 34, text: 'Gradient descent minimizes prediction loss.', source: 'ai' }
    ];

    const markdown = formatNotesToMarkdown({
      title: 'Machine Learning Lecture Without Captions',
      videoId: 'no_cc_video_101',
      videoUrl: 'https://www.youtube.com/watch?v=no_cc_video_101',
      notes
    });

    assert.ok(markdown.includes('# Machine Learning Lecture Without Captions'));
    assert.ok(markdown.includes('[00:05](https://www.youtube.com/watch?v=no_cc_video_101&t=5s)'));
    assert.ok(markdown.includes('[00:34](https://www.youtube.com/watch?v=no_cc_video_101&t=34s)'));
    assert.ok(markdown.includes('Supervised learning requires labeled training data.'));
    assert.ok(markdown.includes('Gradient descent minimizes prediction loss.'));
  });
});

