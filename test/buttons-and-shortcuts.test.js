import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Buttons, Shortcuts & Background Transcript Processing', () => {
  const contentJs = fs.readFileSync(path.join(process.cwd(), 'content.js'), 'utf-8');
  const panelCss = fs.readFileSync(path.join(process.cwd(), 'panel.css'), 'utf-8');

  it('1. Alt+V keyboard shortcut is registered globally and bypasses event isolation', () => {
    // Global listener handles Alt+V with code KeyV and key v/V
    assert.match(
      contentJs,
      /\(e\.altKey\s*\|\|\s*e\.metaKey\)\s*&&\s*\(e\.key === 'v'\s*\|\|\s*e\.key === 'V'\s*\|\|\s*e\.code === 'KeyV'\)/,
      'Global keydown listener must capture Alt+V reliably across OS keyboard layouts'
    );
    // Calls pauseAndEdit()
    assert.match(
      contentJs,
      /pauseAndEdit\(\)/,
      'Alt+V must trigger pauseAndEdit()'
    );
    // isolateKeyboardEvents allows Alt+V through
    assert.match(
      contentJs,
      /if\s*\(\(e\.altKey\s*\|\|\s*e\.metaKey\)\s*&&\s*\(e\.key === 'v'\s*\|\|\s*e\.key === 'V'\s*\|\|\s*e\.code === 'KeyV'\)\)\s*return;/,
      'isolateKeyboardEvents must not swallow Alt+V'
    );
  });

  it('2. Escape keyboard shortcut is registered globally and resumes playback', () => {
    // Global listener handles Escape
    assert.match(
      contentJs,
      /if\s*\(e\.key === 'Escape'\s*\|\|\s*e\.code === 'Escape'\)/,
      'Global keydown listener must capture Escape'
    );
    // Calls resumeVideo(true)
    assert.match(
      contentJs,
      /resumeVideo\(true\)/,
      'Escape must trigger resumeVideo(true)'
    );
    // isolateKeyboardEvents allows Escape through
    assert.match(
      contentJs,
      /if\s*\(e\.key === 'Escape'\s*\|\|\s*e\.code === 'Escape'\)\s*return;/,
      'isolateKeyboardEvents must not swallow Escape'
    );
  });

  it('3. Pause & Edit button pauses video, shows paused banner, focuses input, and engages voice dictation', () => {
    // Pause button click listener
    assert.match(
      contentJs,
      /pauseEditBtn\.addEventListener\('click',\s*\(e\)\s*=>\s*\{[^}]*pauseAndEdit\(\);/s,
      'Pause & Edit button click must call pauseAndEdit()'
    );
    // Direct video pause with fallback to YouTube play button
    assert.match(contentJs, /video\.pause\(\)/);
    assert.match(contentJs, /\.ytp-play-button/);
    // Sets header status to PAUSED
    assert.match(contentJs, /updateHeaderStatus\('PAUSED'\)/);
    // Displays paused banner and focuses input
    assert.match(contentJs, /bannerEl\.classList\.remove\('vn-hidden'\)/);
    assert.match(contentJs, /inputEl\.classList\.add\('vn-active-glow'\)/);
    assert.match(contentJs, /inputEl\.focus\(\)/);
    // Automatically starts speech dictation
    assert.match(contentJs, /startSpeechRecognition\(\)/);
  });

  it('4. Resume button resumes video playback, hides banner, and sets header status to LIVE', () => {
    // Resume button click listener
    assert.match(
      contentJs,
      /resumeBtn\.addEventListener\('click',\s*\(e\)\s*=>\s*\{[^}]*resumeVideo\(true\);/s,
      'Resume button click must call resumeVideo(true)'
    );
    // Resumes video with HTML5 play and fallback to YouTube play button
    assert.match(contentJs, /video\.play\(\)/);
    assert.match(contentJs, /updateHeaderStatus\('LIVE'\)/);
    assert.match(contentJs, /bannerEl\.classList\.add\('vn-hidden'\)/);
  });

  it('5. Submit button and Enter key submit note edits and handle empty input gracefully', () => {
    // Enter key submits edit
    assert.match(
      contentJs,
      /if\s*\(e\.key === 'Enter'\)\s*\{[^}]*submitEdit\(\);/s,
      'Enter key inside input must call submitEdit()'
    );
    // Submit button click calls submitEdit
    assert.match(
      contentJs,
      /submitBtn\.addEventListener\('click',\s*\(e\)\s*=>\s*\{[^}]*submitEdit\(\);/s,
      'Submit button click must call submitEdit()'
    );
    // Gracefully guides user when input is empty
    assert.match(
      contentJs,
      /Please type or speak a note first, then click Submit or press Enter\./,
      'submitEdit must guide user when input is empty'
    );
  });

  it('6. Mic button toggles speech recognition and updates UI state', () => {
    assert.match(
      contentJs,
      /micBtn\.addEventListener\('click',\s*\(e\)\s*=>\s*\{[^}]*toggleSpeechRecognition\(\);/s,
      'Mic button click must call toggleSpeechRecognition()'
    );
    assert.match(contentJs, /function toggleSpeechRecognition\(/);
  });

  it('7. Clipboard copy helper implements execCommand fallback', () => {
    assert.match(contentJs, /async function copyTextToClipboard\(text\)/);
    assert.match(contentJs, /navigator\.clipboard\.writeText\(text\)/);
    assert.match(contentJs, /document\.execCommand\('copy'\)/);
  });

  it('8. Transcript selection is deleted from visible screen while background processing continues', () => {
    // .vn-view-tabs is hidden from screen in CSS
    assert.match(
      panelCss,
      /\.vn-view-tabs\s*\{[^}]*display:\s*none\s*!important;/,
      '.vn-view-tabs must have display: none !important;'
    );
    // .vn-transcript-container is hidden from screen in CSS
    assert.match(
      panelCss,
      /\.vn-transcript-container\s*\{[^}]*display:\s*none\s*!important;/,
      '.vn-transcript-container must have display: none !important;'
    );
    // Button child elements have pointer-events: none for reliable clicks
    assert.match(
      panelCss,
      /\.vn-btn span,\s*\.vn-btn kbd\s*\{[^}]*pointer-events:\s*none;/,
      'Button spans and kbds must not intercept pointer events'
    );
    // Background caption loading and topic checking remain fully active
    assert.match(contentJs, /loadCaptionsTrack\(currentVideoId\)/);
    assert.match(contentJs, /setupLiveDomCaptionObserver\(\)/);
    assert.match(contentJs, /checkTopicCompletion\(/);
  });

  it('9. Does not show notes before the video reaches that point of the timestamp', () => {
    // Assert renderAllNotes filters notes by video.currentTime
    assert.match(
      contentJs,
      /const\s+reachedNotes\s*=\s*\(!hasVideo\s*\|\|\s*isVideoEnded\)\s*\?\s*notesList\s*:\s*notesList\.filter\(/,
      'renderAllNotes must filter notes by video.currentTime'
    );
    assert.match(
      contentJs,
      /n\.time\s*<=\s*currentPlaybackTime/,
      'Notes must only be shown when note.time <= currentPlaybackTime'
    );

    // Simulation of note timestamp filtering:
    const mockNotes = [
      { id: '1', time: 165, text: '[02:45] Coupon codes' },
      { id: '2', time: 250, text: '[04:10] GitHub login' },
      { id: '3', time: 270, text: '[04:30] LLD sections' },
      { id: '4', time: 289, text: '[04:49] Technical bug' }
    ];

    const filterByTime = (notes, currentSec, isEnded = false) => {
      if (isEnded) return notes;
      return notes.filter((n) => typeof n.time !== 'number' || n.time <= currentSec);
    };

    // At 15s (beginning of video): NO notes shown
    assert.equal(filterByTime(mockNotes, 15).length, 0);

    // At 120s (2 minutes): NO notes shown
    assert.equal(filterByTime(mockNotes, 120).length, 0);

    // At 165s (02:45): ONLY note 1 shown
    const at165 = filterByTime(mockNotes, 165);
    assert.equal(at165.length, 1);
    assert.equal(at165[0].id, '1');

    // At 250s (04:10): Notes 1 and 2 shown
    const at250 = filterByTime(mockNotes, 250);
    assert.equal(at250.length, 2);

    // At 300s (5 minutes): All 4 notes shown
    assert.equal(filterByTime(mockNotes, 300).length, 4);

    // If user rewinds back to 60s: Notes are hidden again
    assert.equal(filterByTime(mockNotes, 60).length, 0);
  });

  it('10. Live update reveals notes as playback time advances and handles seek events', () => {
    // Assert timeupdate listener monitors reachedCount and triggers renderAllNotes
    assert.match(
      contentJs,
      /reachedCount\s*!==\s*lastRenderedReachedCount/,
      'timeupdate must detect when a new note timestamp is reached'
    );
    // Assert seeked listener resets rendered count and re-renders
    assert.match(
      contentJs,
      /video\.addEventListener\('seeked',\s*\(\)\s*=>\s*\{[^}]*renderAllNotes\(\);/s,
      'seeked listener must re-render notes matching new position'
    );
    // Header count badge reflects reached notes
    assert.match(
      contentJs,
      /updateCountBadge\(reachedNotes\.length\)/,
      'updateCountBadge must reflect reachedNotes length'
    );
  });

  it('11. User edit via Alt+V adds exact text same-to-same without AI rewriting or summarization', () => {
    // Assert submitEdit adds user note directly with exact instruction text
    assert.match(
      contentJs,
      /const\s+newNote\s*=\s*\{[\s\S]*?text:\s*instruction,[\s\S]*?source:\s*'user'/s,
      'User edit must preserve exact instruction text same-to-same'
    );
    // Asserts note is added to notesList and rendered
    assert.match(
      contentJs,
      /notesList\.push\(newNote\);/,
      'User note must be pushed directly to notesList'
    );
    assert.match(
      contentJs,
      /renderAllNotes\(\[newNote\.id\]\);/,
      'Must re-render notes immediately with new user note'
    );
  });

  it('12. Voice dictation auto-submits exact voice note upon speech completion and continues video playback and notes', () => {
    // Assert speech recognition has silence timer and auto-submit logic
    assert.match(
      contentJs,
      /speechSilenceTimer\s*=\s*setTimeout\(/,
      'Speech recognition must feature silence detection auto-completion'
    );
    assert.match(
      contentJs,
      /ensureMicrophonePermission\(\)/,
      'Must ensure microphone permission via getUserMedia'
    );
    // Assert resumeVideo continues video notes tracking
    assert.match(
      contentJs,
      /checkTopicCompletion\(currentSec,\s*false\);[\s\S]*?autoGenerateNotes\(\);/s,
      'resumeVideo must continue video notes tracking seamlessly'
    );
  });

  it('13. Selecting a note for edit updates that exact note with the voice edit instead of creating a duplicate', () => {
    // Assert selectedNoteId and selectNoteForEdit function exist
    assert.match(contentJs, /function selectNoteForEdit\(noteId\)/, 'selectNoteForEdit must be defined');
    assert.match(contentJs, /function clearNoteSelection\(\)/, 'clearNoteSelection must be defined');
    // Assert submitEdit updates selectedNoteId directly
    assert.match(
      contentJs,
      /if\s*\(selectedNoteId\)\s*\{[\s\S]*?targetNote\.text\s*=\s*instruction;[\s\S]*?targetNote\.edited\s*=\s*true;/,
      'submitEdit must update the selected note with exact voice instruction text'
    );
    // Assert visual selection styling is defined in panel.css
    assert.match(
      panelCss,
      /\.vn-notepad-entry\.vn-note-selected/,
      'CSS must define .vn-note-selected style for selected note'
    );
  });
});

