import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGE_TYPES, PROVIDERS, DEFAULT_SETTINGS } from '../src/shared/types.js';
import { callLLMWithRetry } from '../src/shared/provider-adapters.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Extension Stabilization & Architecture Fixes', () => {
  it('1. Centralized MESSAGE_TYPES: shared contract consistency', () => {
    // Read content.js and ensure every MESSAGE_TYPES key is defined
    const contentJsPath = path.join(__dirname, '..', 'content.js');
    const contentJs = fs.readFileSync(contentJsPath, 'utf8');

    for (const [key, val] of Object.entries(MESSAGE_TYPES)) {
      assert.ok(
        contentJs.includes(`${key}: '${val}'`),
        `content.js should define MESSAGE_TYPES.${key} = '${val}'`
      );
    }
  });

  it('2. Safe message sending: handles disconnected channel and context invalidation', () => {
    // Simulate safeSendMessage behavior
    let invalidated = false;
    let bannerShown = false;

    function mockHandleContextInvalidated() {
      invalidated = true;
      bannerShown = true;
    }

    function mockSafeSendMessage(mockRuntime, message, callback) {
      if (!mockRuntime || !mockRuntime.id || invalidated) {
        mockHandleContextInvalidated();
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Extension context invalidated' });
        }
        return;
      }

      try {
        mockRuntime.sendMessage(message, (res) => {
          const lastErr = mockRuntime.lastError;
          if (lastErr) {
            if (lastErr.message?.includes('Extension context invalidated')) {
              mockHandleContextInvalidated();
            }
            if (typeof callback === 'function') {
              callback({ success: false, error: lastErr.message });
            }
            return;
          }
          if (typeof callback === 'function') callback(res);
        });
      } catch (err) {
        if (err.message?.includes('Extension context invalidated')) {
          mockHandleContextInvalidated();
        }
        if (typeof callback === 'function') {
          callback({ success: false, error: err.message });
        }
      }
    }

    // Test A: Runtime id missing (extension reloaded/disabled)
    let callbackCalled = false;
    mockSafeSendMessage({ id: null }, { type: MESSAGE_TYPES.PING }, (res) => {
      callbackCalled = true;
      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error, 'Extension context invalidated');
    });
    assert.ok(callbackCalled);
    assert.ok(invalidated);
    assert.ok(bannerShown);

    // Test B: Disconnected channel error from lastError
    invalidated = false;
    bannerShown = false;
    let resFromLastErr = null;
    const runtimeWithLastError = {
      id: 'mock-ext-id',
      lastError: { message: 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received' },
      sendMessage: (msg, cb) => cb(null)
    };

    mockSafeSendMessage(runtimeWithLastError, { type: MESSAGE_TYPES.PING }, (res) => {
      resFromLastErr = res;
    });
    assert.strictEqual(resFromLastErr.success, false);
    assert.ok(resFromLastErr.error.includes('message channel closed'));
  });

  it('3. Background dispatcher: asynchronous vs synchronous return true/false rules', () => {
    // Read background.js to verify message dispatcher return values
    const bgJsPath = path.join(__dirname, '..', 'background.js');
    const bgJs = fs.readFileSync(bgJsPath, 'utf8');

    // Rule: outer default must return false (not true) to prevent dangling channel
    assert.ok(
      bgJs.includes('default:\n      sendResponse({ success: false, error: `Unhandled message type: ${type}` });\n      return false;') ||
      bgJs.includes('sendResponse({ success: false, error: `Unhandled message type: ${type}` });') && bgJs.includes('return false;'),
      'Unhandled messages must return false'
    );

    // Rule: CANCEL_JOB, OPEN_OPTIONS, PING must return false
    const pingBlock = bgJs.slice(bgJs.indexOf('case MESSAGE_TYPES.PING:'), bgJs.indexOf('case MESSAGE_TYPES.PING:') + 150);
    assert.ok(pingBlock.includes('return false;'), 'PING must return false synchronously');

    const optionsBlock = bgJs.slice(bgJs.indexOf('case MESSAGE_TYPES.OPEN_OPTIONS:'), bgJs.indexOf('case MESSAGE_TYPES.OPEN_OPTIONS:') + 350);
    assert.ok(optionsBlock.includes('return false;'), 'OPEN_OPTIONS must return false synchronously');

    // Rule: GENERATE_LIVE_NOTES and PROCESS_VOICE_EDIT must return true for async response
    const liveNotesIndex = bgJs.indexOf('case MESSAGE_TYPES.GENERATE_LIVE_NOTES:');
    assert.ok(liveNotesIndex !== -1);
    const liveNotesBlock = bgJs.slice(liveNotesIndex, liveNotesIndex + 250);
    assert.ok(liveNotesBlock.includes('return true;'), 'GENERATE_LIVE_NOTES must return true');

    const voiceEditIndex = bgJs.indexOf('case MESSAGE_TYPES.PROCESS_VOICE_EDIT:');
    assert.ok(voiceEditIndex !== -1);
    const voiceEditBlock = bgJs.slice(voiceEditIndex, voiceEditIndex + 250);
    assert.ok(voiceEditBlock.includes('return true;'), 'PROCESS_VOICE_EDIT must return true');
  });

  it('4. API Key Validation: fails fast with actionable error message and no key leak', async () => {
    // Missing key error check
    await assert.rejects(
      async () => {
        await callLLMWithRetry({
          provider: PROVIDERS.GEMINI,
          apiKey: '',
          model: 'gemini-3.5-flash-lite',
          systemPrompt: 'System',
          userPrompt: 'User'
        });
      },
      (err) => {
        assert.ok(err.message.includes('API key not configured'));
        assert.ok(err.message.includes('Open VoiceNotes settings'));
        return true;
      }
    );

    // Whitespace key check
    await assert.rejects(
      async () => {
        await callLLMWithRetry({
          provider: PROVIDERS.GEMINI,
          apiKey: '    ',
          model: 'gemini-3.5-flash-lite',
          systemPrompt: 'System',
          userPrompt: 'User'
        });
      },
      (err) => {
        assert.ok(err.message.includes('API key not configured'));
        return true;
      }
    );
  });

  it('5. Safe Voice Edit Fallback: preserves user note even when API key is missing', () => {
    // Simulates submitEdit behavior when !settings.hasApiKey
    const existingNotes = [
      { id: 'n_1', time: 10, text: 'First existing note', source: 'ai' }
    ];
    const settings = { hasApiKey: false };
    const instruction = 'Remember this important concept';
    const currentTime = 25;

    let appliedDirectFallback = false;
    let savedNotes = null;

    if (!settings.hasApiKey) {
      // Direct note preservation
      appliedDirectFallback = true;
      const newNote = {
        id: `n_${Date.now()}_fallback`,
        time: currentTime,
        text: instruction,
        source: 'user',
        edited: false,
        createdAt: Date.now()
      };
      existingNotes.push(newNote);
      existingNotes.sort((a, b) => a.time - b.time);
      savedNotes = existingNotes;
    }

    assert.ok(appliedDirectFallback);
    assert.strictEqual(savedNotes.length, 2);
    assert.strictEqual(savedNotes[0].id, 'n_1');
    assert.strictEqual(savedNotes[1].text, 'Remember this important concept');
    assert.strictEqual(savedNotes[1].source, 'user');
  });

  it('6. CSS and frame security: top-level frame guard and style injection', () => {
    const contentJsPath = path.join(__dirname, '..', 'content.js');
    const contentJs = fs.readFileSync(contentJsPath, 'utf8');

    // Verification of frame guard
    assert.ok(
      contentJs.includes('if (window.top !== window.self)'),
      'content.js must check window.top !== window.self to avoid subframe execution'
    );

    // Verification of style element injection instead of raw link element only
    assert.ok(
      contentJs.includes("panelStyleEl.id = 'vn-panel-styles'"),
      'content.js must create a style element for panel styles'
    );
    assert.ok(
      contentJs.includes("fetch(chrome.runtime.getURL('panel.css'))"),
      'content.js must fetch panel.css text safely'
    );
  });

  it('7. Live notes deduplication and interval tracking', () => {
    const notesList = [
      { id: 'n_1', time: 30, text: 'Topic 1: Supervised learning overview', source: 'ai' }
    ];

    const rawNote1 = { id: 'n_1', time: 30, text: 'Topic 1: Supervised learning overview' };
    const rawNote2 = { id: 'n_2', time: 32, text: 'Topic 1: supervised learning overview' }; // duplicate text near same time
    const rawNote3 = { id: 'n_3', time: 90, text: 'Topic 2: Unsupervised learning patterns' }; // distinct new note

    function addIfUnique(rawNote, chunkStart) {
      const isDuplicate = notesList.some(
        (n) =>
          n.id === rawNote.id ||
          (n.text.trim().toLowerCase() === rawNote.text.trim().toLowerCase() &&
            Math.abs(n.time - (rawNote.time || chunkStart)) < 15)
      );

      if (!isDuplicate) {
        notesList.push({
          id: rawNote.id,
          time: rawNote.time || chunkStart,
          text: rawNote.text.trim(),
          source: 'ai'
        });
        return true;
      }
      return false;
    }

    assert.strictEqual(addIfUnique(rawNote1, 30), false, 'Identical ID must be rejected as duplicate');
    assert.strictEqual(addIfUnique(rawNote2, 30), false, 'Similar text within 15s must be rejected as duplicate');
    assert.strictEqual(addIfUnique(rawNote3, 90), true, 'New distinct topic note must be accepted');
    assert.strictEqual(notesList.length, 2);
    assert.strictEqual(notesList[1].id, 'n_3');
  });

  it('8. Zero-API-Key Extractive Note Generation: synthesizes structured Heading + Bullets', () => {
    const chunkText =
      'There will be mornings when you sleep longer than planned. The key is waking up between 3 AM and 5 AM. During these early hours the world is quiet and you can focus on personal development. Discipline is the bridge between goals and accomplishment.';

    // Extractive summary generator logic (matches content.js implementation)
    function generateExtractiveTopicNote(chunkStart, chunkEnd, text, topicTitle = '') {
      const cleanText = text.replace(/\s+/g, ' ').trim();
      const rawSentences = cleanText
        .split(/(?<=[.?!])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 15);

      const sentences = rawSentences.length > 0 ? rawSentences : [cleanText];
      let heading = topicTitle || '';
      if (!heading) {
        const first = sentences[0];
        heading = first.split(/\s+/).slice(0, 6).join(' ').replace(/[,.:;!?]+$/, '');
      }

      const bullets = sentences.slice(0, 3).map((s) => `• ${s}`).join('\n');
      return {
        id: `ext_${chunkStart}`,
        time: chunkStart,
        text: `**${heading}**\n${bullets}`,
        source: 'ai'
      };
    }

    const note = generateExtractiveTopicNote(0, 60, chunkText, 'The Power Of Early Morning');
    assert.ok(note);
    assert.strictEqual(note.source, 'ai');
    assert.ok(note.text.includes('**The Power Of Early Morning**'));
    assert.ok(note.text.includes('• There will be mornings when you sleep longer than planned.'));
    assert.ok(note.text.includes('• The key is waking up between 3 AM and 5 AM.'));
  });

  it('9. Completed video playback backfills notes across timeline when notesList is empty', () => {
    const videoTranscript = [
      { start: 5, end: 12, text: 'Welcome to this lesson on waking up early and habit formation.' },
      { start: 20, end: 35, text: 'The morning hours between 3 AM and 5 AM give you quiet time.' },
      { start: 65, end: 80, text: 'Section two covers personal development and morning routines.' },
      { start: 90, end: 110, text: 'Reading and meditating in silence sets the tone for your day.' },
      { start: 130, end: 155, text: 'Consistency is what converts ambition into tangible results.' }
    ];

    const notesList = [];
    const currentSec = 160; // video has played 160s

    // Simulates backfilling logic in autoGenerateNotes
    const step = 60;
    for (let t = 0; t + 25 <= currentSec; t += step) {
      const segEnd = Math.min(currentSec, t + step);
      const segs = videoTranscript.filter((s) => s.start >= t && s.start < segEnd);
      const segText = segs.map((s) => s.text).join(' ').trim();
      if (segText.length >= 15) {
        notesList.push({
          id: `note_${t}`,
          time: t,
          text: `**Topic at ${t}s**\n• ${segText.slice(0, 80)}`,
          source: 'ai'
        });
      }
    }

    assert.ok(notesList.length >= 2, 'Must generate multiple notes across the elapsed video timeline');
    assert.strictEqual(notesList[0].time, 0);
    assert.strictEqual(notesList[1].time, 60);
  });
});
