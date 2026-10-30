import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_STATES,
  STATUS_MESSAGES,
  SourceStateMachine,
  normalizeTranscriptItem,
  isDuplicateSegment
} from '../src/shared/source-manager.js';

describe('Source Manager & State Machine', () => {
  it('initializes in INITIALIZING state with correct message', () => {
    const sm = new SourceStateMachine();
    assert.equal(sm.getState(), SOURCE_STATES.INITIALIZING);
    assert.equal(sm.getStatusMessage(), STATUS_MESSAGES[SOURCE_STATES.INITIALIZING]);
  });

  it('transitions through source discovery states and emits events', () => {
    const events = [];
    const sm = new SourceStateMachine((evt) => events.push(evt));

    sm.transitionTo(SOURCE_STATES.DETECTING_SOURCES);
    assert.equal(sm.getState(), SOURCE_STATES.DETECTING_SOURCES);
    assert.equal(sm.getStatusMessage(), 'Detecting captions...');

    sm.transitionTo(SOURCE_STATES.AUDIO_FALLBACK);
    assert.equal(sm.getState(), SOURCE_STATES.AUDIO_FALLBACK);
    assert.equal(sm.getStatusMessage(), 'Waiting for captions');

    sm.transitionTo(SOURCE_STATES.PAUSED_AD);
    assert.equal(sm.getState(), SOURCE_STATES.PAUSED_AD);
    assert.equal(sm.getStatusMessage(), 'Ad detected — note-taking paused');

    assert.equal(events.length, 3);
    assert.equal(events[0].previousState, SOURCE_STATES.INITIALIZING);
    assert.equal(events[1].previousState, SOURCE_STATES.DETECTING_SOURCES);
    assert.equal(events[2].previousState, SOURCE_STATES.AUDIO_FALLBACK);
  });

  it('supports custom status messages on transition', () => {
    const sm = new SourceStateMachine();
    sm.transitionTo(SOURCE_STATES.AUDIO_FALLBACK, 'Microphone permission active');
    assert.equal(sm.getStatusMessage(), 'Microphone permission active');
  });

  it('normalizes transcript items cleanly', () => {
    const item = normalizeTranscriptItem({
      videoId: 'v123',
      sessionId: 's456',
      start: 12.8,
      end: 15.2,
      text: '&quot;Hello &amp; welcome&quot;',
      source: 'Audio'
    });

    assert.equal(item.start, 12);
    assert.equal(item.end, 15);
    assert.equal(item.text, '"Hello & welcome"');
    assert.equal(item.source, 'Audio');
    assert.ok(item.id.startsWith('t_12_'));
  });

  it('detects duplicate segments within time window', () => {
    const existing = [
      { start: 10, end: 14, text: 'The React component lifecycle' },
      { start: 25, end: 28, text: 'Next concept: state updates' }
    ];

    // Near timestamp 11 with matching text -> duplicate
    const candidate1 = { start: 11, text: 'React component lifecycle' };
    assert.equal(isDuplicateSegment(existing, candidate1, 4), true);

    // Completely new phrase at timestamp 11 -> not duplicate
    const candidate2 = { start: 11, text: 'A brand new explanation' };
    assert.equal(isDuplicateSegment(existing, candidate2, 4), false);

    // Matching text but 30 seconds later -> not duplicate
    const candidate3 = { start: 50, text: 'The React component lifecycle' };
    assert.equal(isDuplicateSegment(existing, candidate3, 4), false);
  });
});

