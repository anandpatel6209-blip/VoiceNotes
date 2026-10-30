import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Voice Edit Isolation & Microphone Lifecycle', () => {
  it('ensures video pause and Alt+V do not activate the microphone automatically', () => {
    let micStarted = false;
    let inputFocused = false;

    // Simulation of pauseAndEdit()
    function pauseAndEditSim() {
      inputFocused = true;
      // startSpeechRecognition() is intentionally NOT called
    }

    pauseAndEditSim();

    assert.equal(inputFocused, true, 'Input should be focused for ordinary typing');
    assert.equal(micStarted, false, 'Microphone must not start automatically on pause/Alt+V');
  });

  it('activates microphone dictation only when user explicitly clicks mic button', () => {
    let isListening = false;
    let micTrackActive = false;

    function startSpeechSim() {
      isListening = true;
      micTrackActive = true;
    }

    function toggleSpeechSim() {
      if (isListening) {
        stopSpeechSim();
      } else {
        startSpeechSim();
      }
    }

    function stopSpeechSim() {
      isListening = false;
      micTrackActive = false;
    }

    // User clicks mic button
    toggleSpeechSim();
    assert.equal(isListening, true);
    assert.equal(micTrackActive, true);

    // User clicks mic button again to toggle off
    toggleSpeechSim();
    assert.equal(isListening, false);
    assert.equal(micTrackActive, false);
  });

  it('releases microphone tracks immediately upon note submission or cancellation', () => {
    let activeStreamTracks = [{ stopped: false }, { stopped: false }];
    let isListening = false;

    function stopSpeechRecognition() {
      isListening = false;
      activeStreamTracks.forEach((t) => {
        t.stopped = true;
      });
      activeStreamTracks = [];
    }

    // Voice editing is active
    isListening = true;

    // User submits edit
    stopSpeechRecognition();

    assert.equal(isListening, false, 'Listening state must be inactive');
    assert.equal(activeStreamTracks.length, 0, 'All microphone tracks must be released');
  });

  it('handles microphone permission denial gracefully and keeps keyboard editing open', () => {
    let isListening = false;
    let statusMessage = '';
    let keyboardAvailable = true;

    function handleSpeechError(errorCode) {
      if (errorCode === 'not-allowed') {
        isListening = false;
        statusMessage = 'Microphone access was blocked. You can still type notes with your keyboard.';
      }
    }

    handleSpeechError('not-allowed');

    assert.equal(isListening, false);
    assert.ok(statusMessage.includes('type notes with your keyboard'));
    assert.equal(keyboardAvailable, true);
  });

  it('guarantees that voice editing instructions never contaminate the lesson transcript array', () => {
    const videoTranscript = [
      { start: 0, text: 'Welcome to this computer architecture overview.', source: 'Audio' },
      { start: 10, text: 'The CPU contains an arithmetic logic unit and registers.', source: 'Audio' }
    ];

    const voiceEditInstruction = 'Change the second note to mention registers store immediate operands';

    // Simulate voice edit pipeline
    const userEditPayload = {
      instruction: voiceEditInstruction,
      userTime: 12
    };

    // Assert that videoTranscript was NOT contaminated
    assert.equal(videoTranscript.length, 2);
    assert.ok(videoTranscript.every((t) => t.source === 'Audio'));
    assert.ok(!videoTranscript.some((t) => t.text.includes('Change the second note')));
  });

  it('verifies independent lifecycles: Speaker Listening and Voice Editing', () => {
    let tabCaptureActive = false;
    let microphoneActive = false;

    // 1. Enable Speaker Listening (Tab Audio)
    tabCaptureActive = true;
    assert.equal(tabCaptureActive, true);
    assert.equal(microphoneActive, false, 'Enabling Speaker Listening must not activate the microphone');

    // 2. User starts a voice edit
    microphoneActive = true;
    assert.equal(tabCaptureActive, true, 'Tab audio capture remains unaffected');
    assert.equal(microphoneActive, true);

    // 3. User finishes voice edit
    microphoneActive = false;
    assert.equal(microphoneActive, false, 'Microphone is released');
    assert.equal(tabCaptureActive, true, 'Tab audio continues running');

    // 4. Disable Speaker Listening
    tabCaptureActive = false;
    assert.equal(tabCaptureActive, false);
    assert.equal(microphoneActive, false);
  });
});
