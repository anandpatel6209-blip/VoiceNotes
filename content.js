/**
 * VoiceNotes - Content Script
 * Injected on YouTube pages within a closed Shadow DOM.
 *
 * Responsibilities:
 * - Detects YouTube video lifecycle & SPA navigation
 * - Extracts caption tracks & timed transcript (json3/xml)
 * - Tracks video playback time & generates live AI notes every ~30s
 * - Handles Pause & Edit (Alt+V), text & voice typing (Web Speech API)
 * - Synthesizes spoken edits into notes via background AI
 * - Provides 2-second highlight feedback and non-destructive Undo
 * - Note management: search filter, clickable timestamps, inline edit, delete
 * - Markdown export with timestamp links to clipboard & download
 */

(() => {
  const TAG = '[VoiceNotes:content]';
  console.log(`${TAG} Initializing VoiceNotes content script.`);

  // DOM references (Shadow DOM encapsulated)
  let hostElement = null;
  let shadowRoot = null;
  let panelRoot = null;
  let inputEl = null;
  let micBtn = null;
  let liveAudioBtnEl = null;
  let headerStatusPillEl = null;
  let headerStatusDotEl = null;
  let headerStatusTextEl = null;
  let generateNotesBtnEl = null;
  let bannerEl = null;
  let statusBarEl = null;
  let writingIndicatorEl = null;
  let writingTextEl = null;
  let notesContainerEl = null;
  let searchInputEl = null;
  let countBadgeEl = null;
  let togglePill = null;
  let liveStreamCardEl = null;
  let liveStreamTextEl = null;
  let liveStreamTimeEl = null;
  let liveStreamSourceEl = null;
  let transcriptContainerEl = null;
  let viewTabsContainerEl = null;
  let notesTabBtnEl = null;
  let transcriptTabBtnEl = null;
  let currentView = 'notes';
  let transcriptAutoScroll = true;
  let transcriptSaveDebounceTimer = null;

  // Video & Playback state
  let currentVideoId = null;
  let currentVideoTitle = 'YouTube Video';
  let videoElement = null;
  let wasPlayingBeforePause = false;
  let activeSpeechRecognition = null;
  let isListeningSpeech = false;
  let isSubmittingEdit = false;

  // Transcript & Chunking
  let videoTranscript = []; // [{ start: number, end: number, text: string }]
  let chunkIntervalSec = 15;
  let lastProcessedTime = 0;
  let lastObservedTime = 0;
  let processedIntervals = new Set();
  let pendingIntervals = new Set();
  let isAiRequestActive = false;
  let saveDebounceTimer = null;

  // Notes Store & Undo Engine
  let notesList = [];
  let undoStack = []; // [{ timestamp, inversePatch: [{ action, id, previousState, note }] }]
  let searchFilterQuery = '';
  let selectedNoteId = null; // Currently selected note ID for voice/text editing

  // Topic Tracking & Completion State
  let videoTopics = []; // [{ index, title, startSec, endSec, isChapter }]
  let completedTopicIndices = new Set();
  let lastTopicCompletedTime = 0;
  let activeTopicName = '';
  let currentPlaybackRate = 1; // Tracks video playback speed (1x - 3x)

  // Source & Ad State Machine
  let isAdActive = false;
  let currentSourceState = 'INITIALIZING';
  let sourceStateMessage = 'Initializing session...';

  const SOURCE_STATE_LABELS = {
    INITIALIZING: 'Initializing session...',
    DETECTING_SOURCES: 'Detecting captions...',
    CAPTIONS_ACTIVE: 'Captions active',
    GENERATING_NOTES: 'Writing notes...',
    PAUSED_AD: 'Ad detected — note-taking paused',
    SOURCE_UNAVAILABLE: 'No captions found for this video'
  };

  function setSourceState(newState, customMessage = null) {
    currentSourceState = newState;
    sourceStateMessage = customMessage || SOURCE_STATE_LABELS[newState] || newState;
    updateLiveAudioIndicator();
  }

  /**
   * Passive YouTube Ad Detection (Safe, read-only checks)
   */
  function isAdPlaying(playerEl = null, videoEl = null) {
    if (!playerEl) {
      playerEl = document.querySelector('.html5-video-player');
    }
    if (!videoEl) {
      videoEl = getVideoElement();
    }
    if (playerEl) {
      if (
        playerEl.classList?.contains('ad-showing') ||
        playerEl.classList?.contains('ad-interrupting')
      ) {
        return true;
      }
      if (typeof playerEl.getAdState === 'function') {
        try {
          if (playerEl.getAdState() > 0) return true;
        } catch (e) {}
      }
    }
    const adOverlay = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-overlay-container');
    if (adOverlay && adOverlay.offsetParent !== null) {
      return true;
    }
    const adModule = document.querySelector('.video-ads.ytp-ad-module');
    if (adModule && adModule.children && adModule.children.length > 0) {
      for (const child of adModule.children) {
        if (child.style?.display !== 'none' && !child.classList?.contains('ytp-ad-module-hidden')) {
          return true;
        }
      }
    }
    if (videoEl && videoEl.closest) {
      try {
        if (videoEl.closest('.ad-showing, .ad-interrupting, .video-ads')) return true;
      } catch (e) {}
    }
    return false;
  }

  // Config settings
  let settings = {
    autoResume: true,
    liveEnabled: true,
    chunkInterval: 15,
    speechLang: 'en-US',
    preferredCaptionLang: 'en'
  };

  /**
   * Helper: safe DOM element creation
   */
  function el(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.attrs) {
      for (const [key, val] of Object.entries(options.attrs)) {
        element.setAttribute(key, val);
      }
    }
    return element;
  }

  /**
   * Format seconds to mm:ss or hh:mm:ss
   */
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (hours > 0) {
      return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
  }

  /**
   * Extract YouTube 11-char video ID from current location
   */
  function getVideoId() {
    const match = window.location.search.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  /**
   * Extract video title from DOM
   */
  function getVideoTitle() {
    const titleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
                    document.querySelector('h1.title yt-formatted-string') ||
                    document.querySelector('h1.title');
    if (titleEl && titleEl.textContent?.trim()) {
      return titleEl.textContent.trim();
    }
    return document.title.replace(/ - YouTube$/, '').trim() || 'YouTube Video';
  }

  /**
   * Find YouTube's main video element
   */
  function getVideoElement() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  /**
   * Prevent keyboard events from bubbling to YouTube player (Space, K, J, L, F, M)
   * while allowing VoiceNotes shortcuts (Alt+V, Escape) to pass through cleanly
   */
  function isolateKeyboardEvents(element) {
    if (!element) return;
    ['keydown', 'keyup', 'keypress'].forEach((eventType) => {
      element.addEventListener(eventType, (e) => {
        if ((e.altKey || e.metaKey) && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) return;
        if (e.key === 'Escape' || e.code === 'Escape') return;
        e.stopPropagation();
      });
    });
  }

  /**
   * Show notification or error in status bar
   */
  function showStatus(text, isError = false, actionButton = null) {
    if (!statusBarEl) return;
    statusBarEl.textContent = '';

    const msgSpan = el('span', { text });
    statusBarEl.appendChild(msgSpan);

    if (actionButton) {
      statusBarEl.appendChild(actionButton);
    }

    statusBarEl.className = `vn-status-bar ${isError ? 'vn-error' : ''}`;
    statusBarEl.classList.remove('vn-hidden');
  }

  function hideStatus() {
    if (!statusBarEl) return;
    statusBarEl.classList.add('vn-hidden');
  }

  /**
   * Update header status indicator: LIVE, PAUSED, IDLE, or GENERATING
   */
  function updateHeaderStatus(state = null) {
    if (!headerStatusPillEl || !headerStatusTextEl) return;

    let effectiveState = state;
    if (!effectiveState) {
      if (isAiRequestActive) {
        effectiveState = 'GENERATING';
      } else {
        const video = getVideoElement();
        if (!video) {
          effectiveState = 'IDLE';
        } else if (video.paused || video.ended) {
          effectiveState = 'PAUSED';
        } else {
          effectiveState = 'LIVE';
        }
      }
    }

    const video = getVideoElement();
    const rate = video?.playbackRate || currentPlaybackRate || 1;
    const rateLabel = rate !== 1 ? ` ${rate % 1 === 0 ? rate : rate.toFixed(1)}x` : '';

    headerStatusPillEl.className = `vn-status-pill vn-status-${effectiveState.toLowerCase()}`;
    headerStatusTextEl.textContent = `${effectiveState}${effectiveState === 'LIVE' || effectiveState === 'GENERATING' ? rateLabel : ''}`;
  }

  /**
   * Update Writing / AI processing state
   */
  function setWritingState(isWriting, label = 'Writing notes') {
    isAiRequestActive = isWriting;
    updateHeaderStatus(isWriting ? 'GENERATING' : null);
    if (writingIndicatorEl) {
      if (isWriting) {
        if (writingTextEl) writingTextEl.textContent = label;
        writingIndicatorEl.classList.remove('vn-hidden');
      } else {
        writingIndicatorEl.classList.add('vn-hidden');
      }
    }
    const docStatusText = notesContainerEl?.querySelector('.vn-notepad-status-label') ||
                          notesContainerEl?.querySelector('.vn-doc-status-text');
    if (docStatusText) {
      docStatusText.textContent = isWriting
        ? `${label}...`
        : (videoTranscript.length > 0 ? 'Notepad Active' : 'Waiting for captions or transcript...');
    }
    if (notesList.length > 0) {
      renderAllNotes();
    }
  }

  /**
   * Real-time display of video dialogue and captions as they are heard/read
   */
  function updateLiveDialogueStream(currentTime, forcedText = null, source = null) {
    if (!liveStreamCardEl || !liveStreamTextEl) return;

    const timeStr = formatTime(currentTime);
    if (liveStreamTimeEl) {
      liveStreamTimeEl.textContent = `[${timeStr}]`;
    }

    if (forcedText && typeof forcedText === 'string' && forcedText.trim().length > 0) {
      liveStreamTextEl.textContent = `"${forcedText.trim()}"`;
      liveStreamTextEl.classList.remove('vn-waiting-text');
      if (liveStreamSourceEl && source) {
        liveStreamSourceEl.textContent = source;
      }
      return;
    }

    // Look up segment in videoTranscript matching currentTime
    const matchingSeg = videoTranscript.find(
      (seg) => currentTime >= seg.start && currentTime <= (seg.end || seg.start + 4)
    ) || videoTranscript.find(
      (seg) => Math.abs(seg.start - currentTime) <= 2
    );

    if (matchingSeg && matchingSeg.text) {
      liveStreamTextEl.textContent = `"${matchingSeg.text.trim()}"`;
      liveStreamTextEl.classList.remove('vn-waiting-text');
      if (liveStreamSourceEl) {
        liveStreamSourceEl.textContent = 'Captions';
      }
    } else {
      // Find the most recent segment within 5 seconds to prevent flicker
      const recentSeg = [...videoTranscript]
        .reverse()
        .find((seg) => seg.start <= currentTime && currentTime - seg.start <= 5);

      if (recentSeg && recentSeg.text) {
        liveStreamTextEl.textContent = `"${recentSeg.text.trim()}"`;
        liveStreamTextEl.classList.remove('vn-waiting-text');
      } else if (videoTranscript.length === 0) {
        liveStreamTextEl.textContent = 'Waiting for captions or transcript...';
        liveStreamTextEl.classList.add('vn-waiting-text');
        if (liveStreamSourceEl) {
          liveStreamSourceEl.textContent = 'Awaiting captions';
        }
      }
    }
  }

  /**
   * Update note count badge in header and tab buttons
   */
  /**
   * Update notes counter badge in header (reflects reached notes during live playback)
   */
  function updateCountBadge(customCount = null) {
    const video = getVideoElement();
    const hasVideo = video && typeof video.currentTime === 'number';
    const currentPlaybackTime = hasVideo ? Math.floor(video.currentTime) : 0;
    const isVideoEnded = hasVideo && Boolean(video.ended);

    const count = typeof customCount === 'number'
      ? customCount
      : ((!hasVideo || isVideoEnded)
          ? notesList.length
          : notesList.filter((n) => typeof n.time !== 'number' || n.time <= currentPlaybackTime || n.source === 'user').length);

    if (countBadgeEl) {
      countBadgeEl.textContent = `${count}`;
      if (count > 0) {
        countBadgeEl.classList.remove('vn-hidden');
      } else {
        countBadgeEl.classList.add('vn-hidden');
      }
    }
    if (notesTabBtnEl) {
      notesTabBtnEl.textContent = `📝 Notes (${count})`;
    }
    if (transcriptTabBtnEl) {
      transcriptTabBtnEl.textContent = `📜 Transcript (${videoTranscript.length})`;
    }
  }

  /**
   * Seek video playback to given seconds
   */
  function seekTo(seconds) {
    const video = getVideoElement();
    if (video) {
      video.currentTime = Math.max(0, seconds);
      console.log(`${TAG} Seeked video to ${seconds}s`);
    }
  }

  /**
   * Save notes to chrome.storage.local (debounced)
   */
  function debounceSaveNotes() {
    if (!currentVideoId) return;
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SAVE_NOTES',
        payload: {
          videoId: currentVideoId,
          notes: notesList
        }
      });
    }, 800);
  }

  /**
   * Helper: Parse inline markdown safely into DOM text and format nodes (XSS-safe)
   */
  function renderInlineMarkdown(rawText, parentNode) {
    if (!rawText) return;
    const regex = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(rawText)) !== null) {
      if (match.index > lastIndex) {
        parentNode.appendChild(document.createTextNode(rawText.slice(lastIndex, match.index)));
      }

      const token = match[0];
      if (token.startsWith('`') && token.endsWith('`')) {
        const codeEl = el('code', {
          className: 'vn-notepad-inline-code',
          text: token.slice(1, -1)
        });
        parentNode.appendChild(codeEl);
      } else if (
        (token.startsWith('**') && token.endsWith('**')) ||
        (token.startsWith('__') && token.endsWith('__'))
      ) {
        const strongEl = el('strong', {
          text: token.slice(2, -2)
        });
        parentNode.appendChild(strongEl);
      } else if (
        (token.startsWith('*') && token.endsWith('*')) ||
        (token.startsWith('_') && token.endsWith('_'))
      ) {
        const emEl = el('em', {
          text: token.slice(1, -1)
        });
        parentNode.appendChild(emEl);
      } else {
        parentNode.appendChild(document.createTextNode(token));
      }

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < rawText.length) {
      parentNode.appendChild(document.createTextNode(rawText.slice(lastIndex)));
    }
  }

  /**
   * Render structured educational Markdown into container using safe DOM elements
   * Supports:
   * - Main Topic Heading: '# Title' (with ~2 lines margin bottom)
   * - Subheadings: '## Title', '### Title', '#### Title'
   * - Fenced Code Blocks: ```lang ... ```
   * - Bullet Lists: '- item', '* item', '• item'
   * - Numbered Lists: '1. item'
   * - Blockquotes: '> quote'
   * - Paragraphs with bold, italic, and inline code
   */
  function renderSafeMarkdown(markdownText, containerEl) {
    if (!markdownText || typeof markdownText !== 'string') return;

    const rawLines = markdownText.replace(/\r\n/g, '\n').split('\n');
    let inCodeBlock = false;
    let codeLanguage = '';
    let codeLines = [];
    let currentUl = null;
    let currentOl = null;

    function flushList() {
      currentUl = null;
      currentOl = null;
    }

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const trimmed = line.trim();

      // Fenced code block toggle
      if (trimmed.startsWith('```')) {
        flushList();
        if (inCodeBlock) {
          const pre = el('pre', { className: 'vn-notepad-code-block' });
          const codeEl = el('code', {
            className: `vn-code-snippet ${codeLanguage ? `language-${codeLanguage}` : ''}`,
            text: codeLines.join('\n')
          });
          pre.appendChild(codeEl);
          containerEl.appendChild(pre);

          inCodeBlock = false;
          codeLanguage = '';
          codeLines = [];
        } else {
          inCodeBlock = true;
          codeLanguage = trimmed.slice(3).trim();
          codeLines = [];
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      if (!trimmed) {
        flushList();
        continue;
      }

      // Main Topic Heading: '# Title'
      if (/^#\s+/.test(trimmed)) {
        flushList();
        const headingText = trimmed.replace(/^#\s+/, '');
        const h1 = el('h1', { className: 'vn-notepad-heading-main' });
        renderInlineMarkdown(headingText, h1);
        containerEl.appendChild(h1);
        continue;
      }

      // Subheadings: '### Title', '## Title', '#### Title'
      if (/^#{2,4}\s+/.test(trimmed)) {
        flushList();
        const level = trimmed.match(/^#{2,4}/)[0].length;
        const subText = trimmed.replace(/^#{2,4}\s+/, '');
        const hTag = level === 2 ? 'h2' : (level === 3 ? 'h3' : 'h4');
        const hEl = el(hTag, { className: 'vn-notepad-subheading' });
        renderInlineMarkdown(subText, hEl);
        containerEl.appendChild(hEl);
        continue;
      }

      // Blockquotes: '> quote'
      if (/^>\s+/.test(trimmed)) {
        flushList();
        const quoteText = trimmed.replace(/^>\s+/, '');
        const quoteEl = el('blockquote', { className: 'vn-notepad-quote' });
        renderInlineMarkdown(quoteText, quoteEl);
        containerEl.appendChild(quoteEl);
        continue;
      }

      // Bullet List item: '- item', '* item', '• item'
      if (/^[-*•]\s+/.test(trimmed)) {
        currentOl = null;
        if (!currentUl) {
          currentUl = el('ul', { className: 'vn-notepad-bullet-list' });
          containerEl.appendChild(currentUl);
        }
        const liText = trimmed.replace(/^[-*•]\s+/, '');
        const li = el('li', { className: 'vn-notepad-bullet-item' });
        renderInlineMarkdown(liText, li);
        currentUl.appendChild(li);
        continue;
      }

      // Numbered List item: '1. item'
      if (/^\d+\.\s+/.test(trimmed)) {
        currentUl = null;
        if (!currentOl) {
          currentOl = el('ol', { className: 'vn-notepad-ordered-list' });
          containerEl.appendChild(currentOl);
        }
        const liText = trimmed.replace(/^\d+\.\s+/, '');
        const li = el('li', { className: 'vn-notepad-ordered-item' });
        renderInlineMarkdown(liText, li);
        currentOl.appendChild(li);
        continue;
      }

      // Paragraph
      flushList();
      const p = el('p', { className: 'vn-notepad-paragraph vn-doc-paragraph' });
      renderInlineMarkdown(trimmed, p);
      containerEl.appendChild(p);
    }

    if (inCodeBlock && codeLines.length > 0) {
      const pre = el('pre', { className: 'vn-notepad-code-block' });
      const codeEl = el('code', {
        className: 'vn-code-snippet',
        text: codeLines.join('\n')
      });
      pre.appendChild(codeEl);
      containerEl.appendChild(pre);
    }
  }

  /**
   * Select a specific note for voice or text editing
   */
  function selectNoteForEdit(noteId) {
    const note = notesList.find((n) => n.id === noteId);
    if (!note) return;

    selectedNoteId = note.id;

    // Highlight selected entry in DOM
    const allEntries = notesContainerEl?.querySelectorAll('.vn-notepad-entry');
    allEntries?.forEach((el) => {
      if (el.dataset.id === note.id) {
        el.classList.add('vn-note-selected');
        const meta = el.querySelector('.vn-notepad-entry-meta');
        if (meta && !meta.querySelector('.vn-selected-indicator')) {
          const badge = el('span', {
            className: 'vn-selected-indicator',
            text: '✎ Selected to Edit'
          });
          meta.appendChild(badge);
        }
      } else {
        el.classList.remove('vn-note-selected');
        el.querySelector('.vn-selected-indicator')?.remove();
      }
    });

    // Populate bottom input with the note's text so user can edit or replace it with voice
    if (inputEl) {
      inputEl.value = note.text;
      inputEl.placeholder = `Edit note at [${formatTime(note.time)}] (Speak or type)...`;
      inputEl.focus();
      inputEl.select();
    }

    if (bannerEl) {
      bannerEl.textContent = `Editing note at [${formatTime(note.time)}] — Speak or type your edit`;
      bannerEl.classList.remove('vn-hidden');
    }

    const submitBtn = panelRoot?.querySelector('.vn-submit-btn');
    if (submitBtn) {
      submitBtn.textContent = 'Save Note ⏎';
    }

    showStatus(`Selected note at [${formatTime(note.time)}] for editing. Speak to update.`);
    pauseAndEdit();
  }

  function clearNoteSelection() {
    selectedNoteId = null;
    const allEntries = notesContainerEl?.querySelectorAll('.vn-notepad-entry');
    allEntries?.forEach((el) => {
      el.classList.remove('vn-note-selected');
      el.querySelector('.vn-selected-indicator')?.remove();
    });
    if (inputEl) {
      inputEl.placeholder = 'Speak or type an edit (Alt+V)...';
    }
    if (bannerEl) {
      bannerEl.textContent = 'Video paused — Speak or type your edit';
    }
    const submitBtn = panelRoot?.querySelector('.vn-submit-btn');
    if (submitBtn) {
      submitBtn.textContent = 'Submit ⏎';
    }
  }

  /**
   * Render individual note element as a digital document entry
   */
  function createDocEntryElement(note) {
    const isSelected = selectedNoteId === note.id;
    const entry = el('div', {
      className: `vn-notepad-entry vn-doc-entry ${note.source === 'user' ? 'vn-notepad-entry-user vn-doc-entry-user' : 'vn-notepad-entry-ai vn-doc-entry-ai'} ${isSelected ? 'vn-note-selected' : ''}`
    });
    entry.dataset.id = note.id;

    // Click note to select for voice or text editing
    entry.addEventListener('click', (e) => {
      if (e.target.closest('.vn-notepad-time-btn, .vn-notepad-action-btn, .vn-inline-edit-input, .vn-btn')) {
        return;
      }
      if (selectedNoteId === note.id) {
        clearNoteSelection();
      } else {
        selectNoteForEdit(note.id);
      }
    });

    // Header row: bracketed timestamp + user tag + hover action buttons
    const headerRow = el('div', { className: 'vn-notepad-entry-header vn-doc-entry-header' });

    const leftMeta = el('div', { className: 'vn-notepad-entry-meta vn-doc-entry-meta' });
    const timeBtn = el('button', {
      className: 'vn-notepad-time-btn vn-doc-timestamp-btn',
      text: `[${formatTime(note.time)}]`,
      attrs: { title: `Click to jump to ${formatTime(note.time)}` }
    });
    timeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      seekTo(note.time);
    });
    leftMeta.appendChild(timeBtn);

    if (note.source === 'user') {
      const userTag = el('span', {
        className: 'vn-notepad-user-tag vn-doc-user-tag',
        text: note.edited ? '[edited by you]' : '[you]'
      });
      leftMeta.appendChild(userTag);
    }

    if (isSelected) {
      const selectedBadge = el('span', {
        className: 'vn-selected-indicator',
        text: '✎ Selected to Edit'
      });
      leftMeta.appendChild(selectedBadge);
    }

    headerRow.appendChild(leftMeta);

    // Hover action buttons: Inline Edit & Delete
    const actions = el('div', { className: 'vn-notepad-actions vn-doc-actions' });

    const editBtn = el('button', {
      className: 'vn-notepad-action-btn vn-doc-action-btn',
      text: '✎',
      attrs: { title: 'Edit note with voice or text' }
    });
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNoteForEdit(note.id);
    });

    const deleteBtn = el('button', {
      className: 'vn-notepad-action-btn vn-notepad-btn-delete vn-doc-action-btn vn-doc-btn-delete',
      text: '✕',
      attrs: { title: 'Delete note' }
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (selectedNoteId === note.id) clearNoteSelection();
      deleteNote(note.id);
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    headerRow.appendChild(actions);

    entry.appendChild(headerRow);

    // Body content: parse structured educational markdown safely
    const bodyEl = el('div', { className: 'vn-notepad-body vn-doc-body' });
    renderSafeMarkdown(note.text || '', bodyEl);
    entry.appendChild(bodyEl);
    return entry;
  }

  /**
   * Start inline editing of an existing note inside document entry
   */
  function startInlineEdit(noteId, entryElement) {
    const note = notesList.find((n) => n.id === noteId);
    if (!note) return;

    selectedNoteId = note.id;

    const existingBodyEl = entryElement.querySelector('.vn-notepad-body') || entryElement.querySelector('.vn-doc-body');
    if (!existingBodyEl) return;

    entryElement.classList.add('vn-editing-mode');
    entryElement.classList.add('vn-note-selected');
    existingBodyEl.style.display = 'none';

    const editArea = el('textarea', {
      className: 'vn-inline-edit-input',
      text: note.text
    });
    isolateKeyboardEvents(editArea);

    const actionsRow = el('div', { className: 'vn-inline-actions' });

    // Voice dictation button directly inside inline edit
    const inlineMicBtn = el('button', {
      className: 'vn-btn vn-inline-mic-btn',
      text: '🎤 Voice Edit'
    });
    inlineMicBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      editArea.focus();
      startSpeechRecognition();
    });

    const saveBtn = el('button', {
      className: 'vn-btn vn-btn-primary',
      text: 'Save'
    });
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const updatedText = editArea.value.trim();
      if (updatedText.length > 0) {
        // Record undo inverse
        undoStack.push({
          timestamp: Date.now(),
          inversePatch: [{ action: 'update', id: note.id, previousState: { ...note } }]
        });

        note.text = updatedText;
        note.source = 'user';
        note.edited = true;
        clearNoteSelection();
        renderAllNotes([note.id]);
        debounceSaveNotes();
        showUndoFeedback('Note updated');
        showStatus('✓ Note updated with your voice edit');
        setTimeout(hideStatus, 2500);
        resumeVideo(true);
      }
    });

    const cancelBtn = el('button', {
      className: 'vn-btn',
      text: 'Cancel'
    });
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearNoteSelection();
      renderAllNotes();
    });

    actionsRow.appendChild(inlineMicBtn);
    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(saveBtn);

    entryElement.appendChild(editArea);
    entryElement.appendChild(actionsRow);
    editArea.focus();
    pauseAndEdit();
  }

  /**
   * Delete a note with Undo support
   */
  function deleteNote(noteId) {
    const index = notesList.findIndex((n) => n.id === noteId);
    if (index === -1) return;

    const deletedNote = notesList[index];
    notesList.splice(index, 1);

    undoStack.push({
      timestamp: Date.now(),
      inversePatch: [{ action: 'restore', note: deletedNote }]
    });

    renderAllNotes();
    debounceSaveNotes();
    showUndoFeedback('Note deleted');
  }

  /**
   * Display concise error with Retry action
   */
  function showErrorWithRetry(message, retryCallback) {
    if (!statusBarEl) return;
    statusBarEl.textContent = '';
    statusBarEl.classList.remove('vn-hidden');
    statusBarEl.classList.add('vn-status-error');

    const msgSpan = el('span', { text: message + ' ' });
    statusBarEl.appendChild(msgSpan);

    if (typeof retryCallback === 'function') {
      const retryBtn = el('button', {
        className: 'vn-retry-btn',
        text: '↻ Retry'
      });
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideStatus();
        retryCallback();
      });
      statusBarEl.appendChild(retryBtn);
    }
  }

  /**
   * Render digital notepad file in chronological order with notebook ruling lines and margin
   */
  function renderAllNotes(highlightIds = []) {
    if (!notesContainerEl) return;

    // Check if user is already near bottom (smart auto-scroll)
    const wasNearBottom =
      notesContainerEl.scrollHeight - notesContainerEl.scrollTop - notesContainerEl.clientHeight < 80;

    notesContainerEl.textContent = '';

    notesList.sort((a, b) => a.time - b.time);

    const video = getVideoElement();
    const hasVideo = video && typeof video.currentTime === 'number';
    const currentPlaybackTime = hasVideo ? Math.floor(video.currentTime) : 0;
    const isVideoEnded = hasVideo && Boolean(video.ended);

    // "do not show the notes before the video reach that point of the timestamp . so generate live"
    // Only display notes whose timestamp has been reached by the video playhead, or user notes
    const reachedNotes = (!hasVideo || isVideoEnded)
      ? notesList
      : notesList.filter((n) => typeof n.time !== 'number' || n.time <= currentPlaybackTime || n.source === 'user');

    updateCountBadge(reachedNotes.length);

    // Notepad Sheet container with ruled notebook paper lines and left red margin
    const notepadSheet = el('div', { className: 'vn-notepad-sheet vn-doc-sheet' });

    // Notepad File Header
    const notepadHeader = el('div', { className: 'vn-notepad-header vn-doc-header' });

    const topBar = el('div', { className: 'vn-notepad-top-bar' });
    const fileTag = el('div', { className: 'vn-notepad-file-tag' });
    const fileIcon = el('span', { className: 'vn-notepad-file-icon', text: '📝' });
    const fileName = el('span', { className: 'vn-notepad-file-name', text: 'notes.txt' });
    const autoBadge = el('span', { className: 'vn-notepad-save-badge', text: '● autosaved' });
    fileTag.appendChild(fileIcon);
    fileTag.appendChild(fileName);
    fileTag.appendChild(autoBadge);

    const noteCount = el('span', {
      className: 'vn-notepad-count vn-doc-count-label',
      text: `${reachedNotes.length} note${reachedNotes.length === 1 ? '' : 's'}`
    });
    topBar.appendChild(fileTag);
    topBar.appendChild(noteCount);
    notepadHeader.appendChild(topBar);

    // Document Title
    const videoTitle = getVideoTitle();
    const docTitle = el('h2', {
      className: 'vn-notepad-title vn-doc-title',
      text: videoTitle
    });
    notepadHeader.appendChild(docTitle);

    // Notepad Meta Sub-bar: Date & Live Status
    const metaBar = el('div', { className: 'vn-notepad-meta-bar vn-doc-meta-row' });
    const dateStr = new Date().toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
    const dateEl = el('span', { className: 'vn-notepad-date', text: dateStr });

    const liveIndicator = el('div', { className: 'vn-notepad-live-status vn-doc-live-indicator' });
    const livePulse = el('span', {
      className: 'vn-notepad-pulse-dot vn-doc-pulse-dot'
    });

    let statusText = 'Notepad Active';
    if (isAiRequestActive) {
      statusText = 'Writing notes...';
    } else if (videoTranscript.length === 0) {
      statusText = 'Waiting for captions or transcript';
    }

    const liveLabel = el('span', {
      className: 'vn-notepad-status-label vn-doc-status-text',
      text: statusText
    });
    liveIndicator.appendChild(livePulse);
    liveIndicator.appendChild(liveLabel);

    metaBar.appendChild(dateEl);
    metaBar.appendChild(liveIndicator);
    notepadHeader.appendChild(metaBar);

    const divider = el('div', { className: 'vn-notepad-divider vn-doc-divider' });
    notepadHeader.appendChild(divider);
    notepadSheet.appendChild(notepadHeader);

    const query = searchFilterQuery.trim().toLowerCase();
    const visibleNotes = query
      ? reachedNotes.filter((n) => n.text.toLowerCase().includes(query))
      : reachedNotes;

    if (visibleNotes.length === 0) {
      const emptyBox = el('div', { className: 'vn-notepad-empty vn-doc-empty-state' });
      const emptyIcon = el('div', { className: 'vn-notepad-empty-icon', text: '📝' });
      const emptyTitle = el('div', {
        className: 'vn-notepad-empty-title vn-doc-empty-title',
        text: query
          ? 'No matching notes in notepad'
          : (videoTranscript.length > 0 ? 'Digital Notepad Ready' : 'VoiceNotes Active')
      });
      let emptyDescText = '';
      if (query) {
        emptyDescText = 'Try a different search keyword.';
      } else if (notesList.length > 0 && reachedNotes.length === 0) {
        emptyDescText = 'Notes will appear live as the video playback reaches each topic timestamp. Or press Alt+V to write or speak an edit.';
      } else if (videoTranscript.length > 0) {
        emptyDescText = 'VoiceNotes synthesizes smart notes live when each topic completes (Heading then summary of the whole topic). Or press Alt+V to write or speak an edit.';
      } else {
        emptyDescText = 'Play the video to capture dialogue. When the video reaches that point of the timestamp, smart notes will generate and appear live.';
      }
      const emptyDesc = el('div', {
        className: 'vn-notepad-empty-desc vn-doc-empty-desc',
        text: emptyDescText
      });
      emptyBox.appendChild(emptyIcon);
      emptyBox.appendChild(emptyTitle);
      emptyBox.appendChild(emptyDesc);

      if (!query) {
        const actionRow = el('div', { className: 'vn-notepad-empty-actions vn-doc-empty-actions' });

        const quickActionBtn = el('button', {
          className: 'vn-btn vn-btn-primary vn-notepad-action-pill vn-doc-quick-action',
          text: '✎ Alt+V Write Note'
        });
        quickActionBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          pauseAndEdit();
        });

        actionRow.appendChild(quickActionBtn);
        emptyBox.appendChild(actionRow);
      }

      notepadSheet.appendChild(emptyBox);
      notesContainerEl.appendChild(notepadSheet);
      return;
    }

    // Document entries list
    const entriesList = el('div', { className: 'vn-notepad-entries vn-doc-entries-list' });

    visibleNotes.forEach((note) => {
      const entry = createDocEntryElement(note);
      if (highlightIds.includes(note.id)) {
        entry.classList.add('vn-notepad-new-entry', 'vn-doc-new-entry');
        setTimeout(() => entry.classList.remove('vn-notepad-new-entry', 'vn-doc-new-entry'), 2200);
      }
      entriesList.appendChild(entry);
    });

    // If AI is currently generating notes, show the active typewriter writing line on the notepad!
    if (isAiRequestActive) {
      const video = getVideoElement();
      const userTime = video ? Math.floor(video.currentTime) : 0;
      const writingLine = el('div', { className: 'vn-notepad-writing-line' });
      const writingTime = el('span', {
        className: 'vn-notepad-writing-time',
        text: `[${formatTime(userTime)}]`
      });
      const writingText = el('span', {
        className: 'vn-notepad-writing-text',
        text: 'Writing notes from video dialogue...'
      });
      const cursor = el('span', { className: 'vn-notepad-blinking-cursor', text: '▌' });

      writingLine.appendChild(writingTime);
      writingLine.appendChild(writingText);
      writingLine.appendChild(cursor);
      entriesList.appendChild(writingLine);
    }

    notepadSheet.appendChild(entriesList);
    notesContainerEl.appendChild(notepadSheet);

    // Smart auto-scroll: only scroll toward latest content if user was already near bottom
    if (wasNearBottom) {
      notesContainerEl.scrollTo({ top: notesContainerEl.scrollHeight, behavior: 'smooth' });
    }
  }

  /**
   * Switch between Digital Notepad and Transcript & Audio views
   */
  function switchView(viewName) {
    currentView = viewName;
    if (viewName === 'notes') {
      panelRoot?.classList.remove('vn-reader-mode');
      notesTabBtnEl?.classList.add('vn-tab-active');
      transcriptTabBtnEl?.classList.remove('vn-tab-active');
      notesContainerEl?.classList.remove('vn-hidden');
      transcriptContainerEl?.classList.add('vn-hidden');
      if (searchInputEl) searchInputEl.placeholder = 'Search notes...';
      renderAllNotes();
    } else {
      panelRoot?.classList.add('vn-reader-mode');
      transcriptTabBtnEl?.classList.add('vn-tab-active');
      notesTabBtnEl?.classList.remove('vn-tab-active');
      transcriptContainerEl?.classList.remove('vn-hidden');
      notesContainerEl?.classList.add('vn-hidden');
      if (searchInputEl) searchInputEl.placeholder = 'Search transcript lines...';
      renderTranscriptView();
      const video = getVideoElement();
      if (video) {
        updateActiveTranscriptLine(video.currentTime);
      }
    }
  }

  /**
   * Save transcript lines safely to chrome.storage.local (debounced)
   */
  function debounceSaveTranscript() {
    if (!currentVideoId || videoTranscript.length === 0) return;
    clearTimeout(transcriptSaveDebounceTimer);
    transcriptSaveDebounceTimer = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'SAVE_TRANSCRIPT',
        payload: {
          videoId: currentVideoId,
          transcript: videoTranscript
        }
      });
    }, 1000);
  }

  /**
   * Load saved transcript lines from storage
   */
  function loadSavedTranscript(videoId) {
    if (!videoId) return;
    chrome.runtime.sendMessage(
      {
        type: 'LOAD_TRANSCRIPT',
        payload: { videoId }
      },
      (res) => {
        if (chrome.runtime.lastError) {
          console.warn(`${TAG} Could not load transcript:`, chrome.runtime.lastError.message);
          return;
        }
        if (res?.success && Array.isArray(res.transcript) && res.transcript.length > 0) {
          // Merge with any segments already parsed, avoiding duplicates
          res.transcript.forEach((savedSeg) => {
            if (!videoTranscript.some((t) => t.start === savedSeg.start && t.text === savedSeg.text)) {
              videoTranscript.push(savedSeg);
            }
          });
          videoTranscript.sort((a, b) => a.start - b.start);
          console.log(`${TAG} Loaded ${res.transcript.length} saved transcript lines for ${videoId}`);
          updateCountBadge();
          if (currentView === 'transcript') {
            renderTranscriptView();
          }
          if (notesList.length === 0) {
            autoGenerateNotes();
          }
          const video = getVideoElement();
          if (video) {
            updateLiveDialogueStream(Math.floor(video.currentTime));
          }
        }
      }
    );
  }

  /**
   * Highlight matching query text inside element without innerHTML
   */
  function highlightSearchText(container, text, query) {
    container.textContent = '';
    const q = (query || '').trim().toLowerCase();
    if (!q) {
      container.textContent = text;
      return;
    }
    const lower = text.toLowerCase();
    let startIndex = 0;
    let matchIndex = lower.indexOf(q, startIndex);
    if (matchIndex === -1) {
      container.textContent = text;
      return;
    }
    while (matchIndex !== -1) {
      if (matchIndex > startIndex) {
        container.appendChild(document.createTextNode(text.substring(startIndex, matchIndex)));
      }
      const mark = el('mark', {
        className: 'vn-search-match',
        text: text.substring(matchIndex, matchIndex + q.length)
      });
      container.appendChild(mark);
      startIndex = matchIndex + q.length;
      matchIndex = lower.indexOf(q, startIndex);
    }
    if (startIndex < text.length) {
      container.appendChild(document.createTextNode(text.substring(startIndex)));
    }
  }

  /**
   * Robust clipboard copy helper with execCommand fallback
   */
  async function copyTextToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      console.warn(`${TAG} navigator.clipboard.writeText failed:`, err);
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      return successful;
    } catch (err) {
      console.warn(`${TAG} document.execCommand copy fallback failed:`, err);
      return false;
    }
  }

  /**
   * Copy the complete line-by-line transcript to clipboard
   */
  async function copyFullTranscript(copyBtnEl) {
    if (videoTranscript.length === 0) {
      showStatus('No transcript lines to copy', true);
      setTimeout(hideStatus, 2500);
      return;
    }
    const lines = [
      `# ${currentVideoTitle} - Transcript`,
      `Video: https://www.youtube.com/watch?v=${currentVideoId || ''}`,
      `Total lines: ${videoTranscript.length}`,
      ''
    ];
    videoTranscript.forEach((seg) => {
      lines.push(`[${formatTime(seg.start)}] ${seg.text}`);
    });
    const content = lines.join('\n');

    const copied = await copyTextToClipboard(content);
    if (copied) {
      if (copyBtnEl) {
        const originalText = copyBtnEl.textContent;
        copyBtnEl.textContent = '✓ Copied!';
        setTimeout(() => { copyBtnEl.textContent = originalText; }, 2000);
      }
      showStatus('Transcript copied to clipboard!');
      setTimeout(hideStatus, 3000);
    } else {
      showStatus('Clipboard write error', true);
    }
  }

  /**
   * Download the complete transcript as a text file
   */
  function downloadTranscriptTxt() {
    if (videoTranscript.length === 0) {
      showStatus('No transcript lines to download', true);
      setTimeout(hideStatus, 2500);
      return;
    }
    const lines = [
      `# ${currentVideoTitle} - Transcript`,
      `Video: https://www.youtube.com/watch?v=${currentVideoId || ''}`,
      `Total lines: ${videoTranscript.length}`,
      ''
    ];
    videoTranscript.forEach((seg) => {
      lines.push(`[${formatTime(seg.start)}] ${seg.text}`);
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const sanitizedTitle = (currentVideoTitle || 'transcript')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gi, '_')
      .substring(0, 40);
    const a = el('a', {
      attrs: {
        href: url,
        download: `${sanitizedTitle}_transcript.txt`
      }
    });
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  /**
   * Render the complete, line-by-line YouTube transcript in Full-Screen Reader mode
   */
  function renderTranscriptView() {
    if (!transcriptContainerEl) return;
    transcriptContainerEl.textContent = '';

    // 1. Reader Navigation Bar (Back to Notes, Reader Title, Actions)
    const navBar = el('div', { className: 'vn-transcript-nav-bar' });

    const backBtn = el('button', {
      className: 'vn-transcript-back-btn',
      text: '← Back to Notes',
      attrs: { title: 'Return to Notes view' }
    });
    backBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchView('notes');
    });

    const readerHeading = el('div', { className: 'vn-transcript-reader-heading' });
    const readerTitle = el('span', { className: 'vn-transcript-reader-title', text: 'Transcript Reader' });
    const lineCountBadge = el('span', {
      className: 'vn-transcript-lines-badge',
      text: `${videoTranscript.length} line${videoTranscript.length === 1 ? '' : 's'}`
    });
    const syncDot = el('span', { className: 'vn-transcript-sync-badge' });
    const pulseCircle = el('span', { className: 'vn-pulse-circle' });
    const syncText = el('span', { text: 'Live' });
    syncDot.appendChild(pulseCircle);
    syncDot.appendChild(syncText);
    readerHeading.appendChild(readerTitle);
    readerHeading.appendChild(lineCountBadge);
    readerHeading.appendChild(syncDot);

    const toolsRight = el('div', { className: 'vn-transcript-tools-right' });

    // Copy Transcript button with feedback
    const copyBtn = el('button', {
      className: 'vn-transcript-tool-btn vn-copy-btn',
      text: '📋 Copy',
      attrs: { title: 'Copy complete transcript with timestamps' }
    });
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      copyFullTranscript(copyBtn);
    });

    // Auto-scroll toggle button
    const autoScrollBtn = el('button', {
      className: `vn-transcript-tool-btn vn-autoscroll-btn ${transcriptAutoScroll ? 'vn-active' : ''}`,
      text: `🎯 Auto-scroll: ${transcriptAutoScroll ? 'ON' : 'OFF'}`,
      attrs: { title: 'Toggle auto-scrolling to currently playing dialogue line' }
    });
    autoScrollBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      transcriptAutoScroll = !transcriptAutoScroll;
      autoScrollBtn.classList.toggle('vn-active', transcriptAutoScroll);
      autoScrollBtn.textContent = `🎯 Auto-scroll: ${transcriptAutoScroll ? 'ON' : 'OFF'}`;
      if (transcriptAutoScroll) {
        const video = getVideoElement();
        if (video) updateActiveTranscriptLine(video.currentTime);
      }
    });

    // Download button
    const downloadBtn = el('button', {
      className: 'vn-transcript-tool-btn vn-download-btn',
      text: '⬇ .txt',
      attrs: { title: 'Download full transcript as text file' }
    });
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadTranscriptTxt();
    });

    toolsRight.appendChild(copyBtn);
    toolsRight.appendChild(autoScrollBtn);
    toolsRight.appendChild(downloadBtn);

    navBar.appendChild(backBtn);
    navBar.appendChild(readerHeading);
    navBar.appendChild(toolsRight);
    transcriptContainerEl.appendChild(navBar);

    // 2. Reader Search Toolbar
    const searchBar = el('div', { className: 'vn-transcript-search-bar' });
    const searchIcon = el('span', { className: 'vn-search-icon', text: '🔍' });
    const readerSearchInput = el('input', {
      className: 'vn-transcript-search-input',
      attrs: {
        type: 'text',
        placeholder: 'Search transcript dialogue...',
        value: searchFilterQuery,
        autocomplete: 'off',
        spellcheck: 'false'
      }
    });
    isolateKeyboardEvents(readerSearchInput);
    readerSearchInput.addEventListener('input', () => {
      searchFilterQuery = readerSearchInput.value;
      if (searchInputEl) searchInputEl.value = searchFilterQuery;
      renderTranscriptView();
    });
    searchBar.appendChild(searchIcon);
    searchBar.appendChild(readerSearchInput);
    transcriptContainerEl.appendChild(searchBar);

    // 3. Full-screen independently scrollable transcript content
    const listEl = el('div', { className: 'vn-transcript-list' });

    // Filter by searchFilterQuery if present
    const q = searchFilterQuery.trim().toLowerCase();
    const filteredSegments = q
      ? videoTranscript.filter((s) => s.text && s.text.toLowerCase().includes(q))
      : videoTranscript;

    if (videoTranscript.length === 0) {
      const emptyState = el('div', { className: 'vn-transcript-empty' });
      const emptyIcon = el('div', { className: 'vn-transcript-empty-icon', text: '📜' });
      const emptyTitle = el('div', {
        className: 'vn-transcript-empty-title',
        text: 'Waiting for captions or dialogue stream...'
      });
      const emptySubtitle = el('div', {
        className: 'vn-transcript-empty-sub',
        text: 'Play the video to start capturing dialogue line by line with timestamps.'
      });
      emptyState.appendChild(emptyIcon);
      emptyState.appendChild(emptyTitle);
      emptyState.appendChild(emptySubtitle);
      listEl.appendChild(emptyState);
    } else if (filteredSegments.length === 0) {
      const noMatchState = el('div', { className: 'vn-transcript-empty' });
      const noMatchTitle = el('div', {
        className: 'vn-transcript-empty-title',
        text: `No lines matching "${searchFilterQuery}"`
      });
      noMatchState.appendChild(noMatchTitle);
      listEl.appendChild(noMatchState);
    } else {
      filteredSegments.forEach((seg) => {
        const row = el('div', { className: 'vn-transcript-row' });
        row.dataset.start = String(seg.start);
        row.dataset.end = String(seg.end || seg.start + 3.5);

        const timeBtn = el('button', {
          className: 'vn-transcript-time-btn',
          text: `[${formatTime(seg.start)}]`,
          attrs: { title: `Click to jump video to ${formatTime(seg.start)}` }
        });
        timeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          seekTo(seg.start);
        });

        const sourceBadge = el('span', {
          className: 'vn-transcript-source-badge vn-source-cc',
          text: seg.source === 'Transcript' ? 'Transcript' : 'CC'
        });

        const textSpan = el('span', { className: 'vn-transcript-text' });
        if (q) {
          highlightSearchText(textSpan, seg.text, searchFilterQuery);
        } else {
          textSpan.textContent = seg.text;
        }

        row.appendChild(timeBtn);
        row.appendChild(sourceBadge);
        row.appendChild(textSpan);

        row.addEventListener('click', () => {
          seekTo(seg.start);
        });

        listEl.appendChild(row);
      });
    }

    transcriptContainerEl.appendChild(listEl);

    // If currently playing, sync active highlight
    const video = getVideoElement();
    if (video) {
      updateActiveTranscriptLine(video.currentTime);
    }
  }

  /**
   * Dynamically highlight the current active transcript row and auto-scroll
   */
  function updateActiveTranscriptLine(currentTime) {
    if (!transcriptContainerEl || videoTranscript.length === 0) return;
    const sec = Math.floor(currentTime);

    // Find segment that covers current playback time or closest preceding segment within 4 seconds
    const activeSeg =
      videoTranscript.find((s) => sec >= s.start && sec <= (s.end || s.start + 3.5)) ||
      [...videoTranscript].reverse().find((s) => s.start <= sec && sec <= (s.end || s.start + 4));

    const listEl = transcriptContainerEl.querySelector('.vn-transcript-list');
    if (!listEl) return;

    const prevActive = listEl.querySelector('.vn-transcript-row.vn-line-active');

    if (!activeSeg) {
      if (prevActive) prevActive.classList.remove('vn-line-active');
      return;
    }

    const targetRow = listEl.querySelector(`.vn-transcript-row[data-start="${activeSeg.start}"]`);
    if (targetRow && targetRow !== prevActive) {
      if (prevActive) prevActive.classList.remove('vn-line-active');
      targetRow.classList.add('vn-line-active');

      if (transcriptAutoScroll && currentView === 'transcript') {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }

  /**
   * Show Undo affordance in status bar
   */
  function showUndoFeedback(message) {
    if (undoStack.length === 0) {
      showStatus(message);
      setTimeout(hideStatus, 3000);
      return;
    }

    const undoBtn = el('button', {
      className: 'vn-undo-btn',
      text: 'Undo'
    });

    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      executeUndo();
    });

    showStatus(`${message} · `, false, undoBtn);
    setTimeout(hideStatus, 6000);
  }

  /**
   * Execute non-destructive Undo
   */
  function executeUndo() {
    if (undoStack.length === 0) return;

    const entry = undoStack.pop();
    const notesMap = new Map();
    notesList.forEach((n) => notesMap.set(n.id, { ...n }));

    for (const op of entry.inversePatch) {
      if (op.action === 'delete') {
        notesMap.delete(op.id);
      } else if (op.action === 'update' && op.previousState) {
        notesMap.set(op.id, { ...op.previousState });
      } else if (op.action === 'restore' && op.note) {
        notesMap.set(op.note.id, { ...op.note });
      } else if (op.action === 'reorganize' && Array.isArray(op.previousStates)) {
        for (const prev of op.previousStates) {
          const n = notesMap.get(prev.id);
          if (n) {
            notesMap.set(prev.id, { ...n, time: prev.time });
          }
        }
      } else if (op.action === 'restore_snapshot' && Array.isArray(op.snapshot)) {
        notesList = op.snapshot.map((n) => ({ ...n }));
        renderAllNotes();
        debounceSaveNotes();
        showStatus('Restored earlier version.');
        setTimeout(hideStatus, 2500);
        return;
      }
    }

    notesList = Array.from(notesMap.values()).sort((a, b) => a.time - b.time);
    renderAllNotes();
    debounceSaveNotes();
    showStatus('Action undone.');
    setTimeout(hideStatus, 2500);
  }

  /**
   * Pause video and focus edit input
   */
  function pauseAndEdit() {
    const video = getVideoElement();
    if (video) {
      wasPlayingBeforePause = !video.paused;
      try {
        video.pause();
      } catch (err) {
        console.warn(`${TAG} Direct video.pause() error:`, err);
      }
      console.log(`${TAG} Video paused for edit.`);
    }
    // Also synchronize YouTube's player button if it is still playing
    const playBtn = document.querySelector('.ytp-play-button');
    if (playBtn) {
      const title = (playBtn.getAttribute('data-title-no-tooltip') || playBtn.getAttribute('title') || '').toLowerCase();
      if (title.includes('pause')) {
        try { playBtn.click(); } catch (e) {}
      }
    }

    updateHeaderStatus('PAUSED');

    if (panelRoot) panelRoot.classList.remove('vn-collapsed');
    if (togglePill) togglePill.classList.add('vn-hidden');
    if (bannerEl) bannerEl.classList.remove('vn-hidden');
    if (inputEl) {
      inputEl.classList.add('vn-active-glow');
      inputEl.focus();
    }

    // Automatically engage voice dictation on Pause & Edit
    startSpeechRecognition();
  }

  /**
   * Resume video if autoResume is enabled or user explicitly clicked Resume / pressed Esc
   */
  function resumeVideo(forcePlay = false) {
    if (bannerEl) bannerEl.classList.add('vn-hidden');
    if (inputEl) {
      inputEl.classList.remove('vn-active-glow');
      inputEl.blur();
    }
    stopSpeechRecognition();
    clearNoteSelection();

    const video = getVideoElement();
    const shouldPlay = forcePlay || (wasPlayingBeforePause && settings.autoResume);

    if (shouldPlay) {
      if (video) {
        try {
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise.catch((err) => {
              console.log(`${TAG} Direct video.play() error:`, err.message);
              // Fallback to clicking YouTube's play button
              const playBtn = document.querySelector('.ytp-play-button');
              if (playBtn) {
                const title = (playBtn.getAttribute('data-title-no-tooltip') || playBtn.getAttribute('title') || '').toLowerCase();
                if (title.includes('play')) {
                  try { playBtn.click(); } catch (e) {}
                }
              }
            });
          }
        } catch (err) {
          console.warn(`${TAG} Error calling video.play():`, err);
        }
      } else {
        const playBtn = document.querySelector('.ytp-play-button');
        if (playBtn) {
          const title = (playBtn.getAttribute('data-title-no-tooltip') || playBtn.getAttribute('title') || '').toLowerCase();
          if (title.includes('play')) {
            try { playBtn.click(); } catch (e) {}
          }
        }
      }
      console.log(`${TAG} Video resumed.`);
    }

    updateHeaderStatus('LIVE');
    wasPlayingBeforePause = false;

    // Continue video notes or text automatically as video resumes
    const currentSec = video ? Math.floor(video.currentTime) : 0;
    lastObservedTime = currentSec;
    lastProcessedTime = currentSec;
    checkTopicCompletion(currentSec, false);
    autoGenerateNotes();
  }

  /**
   * Helper: Resolve speech recognition language dynamically
   */
  function resolveSpeechLang() {
    if (settings.speechLang && settings.speechLang !== 'auto') {
      return settings.speechLang;
    }
    const navLang = navigator.language || navigator.userLanguage || '';
    if (navLang.startsWith('hi')) return 'hi-IN';
    if (navLang.startsWith('en')) {
      // If timezone offset is -330 (IST +5:30), default to en-IN for optimal Indian accent recognition
      const isIndia = new Date().getTimezoneOffset() === -330;
      return isIndia ? 'en-IN' : navLang;
    }
    return navLang || 'en-IN';
  }

  /**
   * State variables for voice dictation
   */
  let speechFinalText = '';
  let speechBaseText = '';
  let speechRestartTimer = null;
  let speechSilenceTimer = null;
  let hasSpokenInSession = false;

  /**
   * Request microphone permission explicitly via getUserMedia so Chrome shows the permission prompt
   */
  async function ensureMicrophonePermission() {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        return true;
      } catch (err) {
        console.warn(`${TAG} Microphone permission notice:`, err.name, err.message);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          showStatus('Microphone access blocked. Click the lock/mic icon in Chrome address bar to allow.', true);
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Initialize Web Speech API speech recognition with robust sentence accumulation
   */
  function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.log(`${TAG} Web Speech API not supported in this browser.`);
      return;
    }

    try {
      activeSpeechRecognition = new SpeechRecognition();
      activeSpeechRecognition.continuous = true;
      activeSpeechRecognition.interimResults = true;
      activeSpeechRecognition.lang = resolveSpeechLang();
      activeSpeechRecognition.maxAlternatives = 1;

      activeSpeechRecognition.onstart = () => {
        isListeningSpeech = true;
        if (micBtn) micBtn.classList.add('vn-listening');
        showStatus('🎙️ Listening... Speak your note or edit');
      };

      activeSpeechRecognition.onresult = (event) => {
        let interimText = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const res = event.results[i];
          const text = (res[0]?.transcript || '').trim();
          if (!text) continue;
          if (res.isFinal) {
            speechFinalText += (speechFinalText ? ' ' : '') + text;
          } else {
            interimText += (interimText ? ' ' : '') + text;
          }
        }

        const fullSpoken = (speechFinalText + (interimText ? ' ' + interimText : '')).trim();
        const activeInput = (document.activeElement?.classList?.contains('vn-inline-edit-input'))
          ? document.activeElement
          : inputEl;

        if (activeInput && fullSpoken) {
          hasSpokenInSession = true;
          activeInput.value = (speechBaseText ? speechBaseText + ' ' : '') + fullSpoken;
          activeInput.scrollLeft = activeInput.scrollWidth;
        }

        // Voice auto-completion: when user finishes speaking a note,
        // automatically generate or update the note ("text is generate same as my voice then continue video notes or text")
        clearTimeout(speechSilenceTimer);
        if (speechFinalText && activeInput && activeInput.value.trim().length > 0) {
          speechSilenceTimer = setTimeout(() => {
            if (isListeningSpeech && activeInput && activeInput.value.trim().length > 0 && !isSubmittingEdit) {
              console.log(`${TAG} Speech pause detected. Submitting voice edit same-to-same.`);
              stopSpeechRecognition();
              if (activeInput === inputEl) {
                submitEdit();
              } else {
                const saveBtn = activeInput.parentElement?.querySelector('.vn-btn-primary');
                if (saveBtn) saveBtn.click();
                else submitEdit();
              }
            }
          }, 1800);
        }
      };

      activeSpeechRecognition.onerror = (event) => {
        console.warn(`${TAG} Speech recognition error:`, event.error);
        isListeningSpeech = false;
        activeSpeechRecognition = null;
        if (micBtn) micBtn.classList.remove('vn-listening');
        if (event.error === 'not-allowed') {
          showStatus('Microphone blocked. Click the lock/mic icon in the browser address bar to allow.', true);
        } else if (event.error === 'no-speech') {
          // Natural pause in speech, keep listening smoothly
        } else if (event.error !== 'aborted') {
          showStatus(`Voice input notice: ${event.error}`, true);
        }
      };

      activeSpeechRecognition.onend = () => {
        isListeningSpeech = false;
        activeSpeechRecognition = null;
        if (micBtn) micBtn.classList.remove('vn-listening');

        const activeInput = (document.activeElement?.classList?.contains('vn-inline-edit-input'))
          ? document.activeElement
          : inputEl;

        // If user finished speaking and captured text is present, submit edit automatically and resume video!
        if (hasSpokenInSession && activeInput && activeInput.value.trim().length > 0 && !isSubmittingEdit) {
          clearTimeout(speechSilenceTimer);
          speechSilenceTimer = setTimeout(() => {
            if (activeInput && activeInput.value.trim().length > 0 && !isSubmittingEdit) {
              console.log(`${TAG} Speech ended with captured text. Submitting voice edit and continuing video.`);
              if (activeInput === inputEl) {
                submitEdit();
              } else {
                const saveBtn = activeInput.parentElement?.querySelector('.vn-btn-primary');
                if (saveBtn) saveBtn.click();
                else submitEdit();
              }
            }
          }, 600);
          return;
        }

        // If no speech captured yet, and input is still focused and video is paused, keep listening warm
        const video = getVideoElement();
        if (video && video.paused && inputEl === document.activeElement && !hasSpokenInSession) {
          clearTimeout(speechRestartTimer);
          speechRestartTimer = setTimeout(() => {
            startSpeechRecognition();
          }, 300);
        } else {
          hideStatus();
        }
      };
    } catch (e) {
      console.warn(`${TAG} Failed to initialize SpeechRecognition:`, e.message);
      activeSpeechRecognition = null;
    }
  }

  /**
   * Start speech recognition safely
   */
  async function startSpeechRecognition() {
    clearTimeout(speechRestartTimer);
    clearTimeout(speechSilenceTimer);

    // Prompt user for microphone access if not yet granted
    await ensureMicrophonePermission();

    if (!activeSpeechRecognition) {
      setupSpeechRecognition();
    }
    if (!activeSpeechRecognition) return;

    if (!isListeningSpeech) {
      speechFinalText = '';
      hasSpokenInSession = false;
      const activeInput = (document.activeElement?.classList?.contains('vn-inline-edit-input'))
        ? document.activeElement
        : inputEl;
      speechBaseText = (selectedNoteId && activeInput === inputEl) ? '' : (activeInput ? activeInput.value.trim() : '');
      try {
        activeSpeechRecognition.start();
        isListeningSpeech = true;
        if (micBtn) micBtn.classList.add('vn-listening');
      } catch (err) {
        console.warn(`${TAG} Error starting speech recognition:`, err.message);
        activeSpeechRecognition = null;
        setupSpeechRecognition();
        try {
          if (activeSpeechRecognition) {
            activeSpeechRecognition.start();
            isListeningSpeech = true;
            if (micBtn) micBtn.classList.add('vn-listening');
          }
        } catch (e2) {}
      }
    }
  }

  function stopSpeechRecognition() {
    clearTimeout(speechRestartTimer);
    clearTimeout(speechSilenceTimer);
    if (activeSpeechRecognition) {
      try {
        activeSpeechRecognition.stop();
      } catch (e) {}
      activeSpeechRecognition = null;
    }
    isListeningSpeech = false;
    hasSpokenInSession = false;
    if (micBtn) micBtn.classList.remove('vn-listening');
  }

  /**
   * Toggle speech recognition on mic button click
   */
  function toggleSpeechRecognition() {
    if (isListeningSpeech) {
      clearTimeout(speechSilenceTimer);
      stopSpeechRecognition();
      // If user spoke something and toggles mic off, submit note immediately same-to-same and continue video!
      if (inputEl && inputEl.value.trim().length > 0) {
        submitEdit();
      } else {
        showStatus('Voice dictation paused.');
        setTimeout(hideStatus, 2000);
      }
    } else {
      pauseAndEdit();
      startSpeechRecognition();
    }
  }

  /**
   * Helper: Ensure YouTube CC subtitles button is active on player
   */
  function ensureYouTubeSubtitlesActive() {
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') {
      console.log(`${TAG} Auto-enabling YouTube CC subtitles.`);
      try {
        ccBtn.click();
      } catch (e) {}
    }
  }

  /**
   * Safe no-ops for legacy audio hooks
   */
  function startLiveAudioListening() {}
  function stopLiveAudioListening() {}

  /**
   * Update notepad document status indicator (pure caption & transcript tracking)
   */
  function updateLiveAudioIndicator() {
    const docStatusText = notesContainerEl?.querySelector('.vn-notepad-status-label') ||
                          notesContainerEl?.querySelector('.vn-doc-status-text');
    const pulseDot = notesContainerEl?.querySelector('.vn-notepad-pulse-dot') ||
                     notesContainerEl?.querySelector('.vn-doc-pulse-dot');
    if (docStatusText) {
      if (isAdActive) {
        docStatusText.textContent = 'Ad detected (paused)';
        if (pulseDot) pulseDot.className = 'vn-notepad-pulse-dot vn-pulse-amber vn-doc-pulse-dot vn-doc-pulse-amber';
      } else if (isAiRequestActive) {
        docStatusText.textContent = 'Writing notes...';
        if (pulseDot) pulseDot.className = 'vn-notepad-pulse-dot vn-doc-pulse-dot';
      } else if (videoTranscript.length > 0 || currentSourceState === 'CAPTIONS_ACTIVE') {
        docStatusText.textContent = 'Notepad Active';
        if (pulseDot) pulseDot.className = 'vn-notepad-pulse-dot vn-doc-pulse-dot';
      } else if (currentSourceState === 'DETECTING_SOURCES') {
        docStatusText.textContent = 'Detecting captions...';
        if (pulseDot) pulseDot.className = 'vn-notepad-pulse-dot vn-pulse-amber vn-doc-pulse-dot vn-doc-pulse-amber';
      } else if (currentSourceState === 'SOURCE_UNAVAILABLE') {
        docStatusText.textContent = 'No captions or transcript available';
        if (pulseDot) pulseDot.className = 'vn-notepad-pulse-dot vn-pulse-amber vn-doc-pulse-dot vn-doc-pulse-amber';
      } else {
        docStatusText.textContent = sourceStateMessage || 'Waiting for captions or transcript...';
        if (pulseDot) pulseDot.className = 'vn-notepad-pulse-dot vn-pulse-amber vn-doc-pulse-dot vn-doc-pulse-amber';
      }
    }
  }

  /**
   * Helper: unescape HTML entities in captions
   */
  function unescapeHtml(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, '/')
      .replace(/&nbsp;/g, ' ');
  }

  /**
   * Fallback: direct note addition when AI is unavailable or offline
   */
  function fallbackAddNote(instruction, userTime) {
    const newNote = {
      id: `u_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      time: userTime,
      text: instruction,
      source: 'user',
      edited: true,
      createdAt: Date.now()
    };
    notesList.push(newNote);
    notesList.sort((a, b) => a.time - b.time);
    if (inputEl) inputEl.value = '';
    renderAllNotes([newNote.id]);
    debounceSaveNotes();
  }

  /**
   * Filter out microphone breath noise, clicks, or consonant artifacts like "ggh"
   */
  function isGibberish(text) {
    if (!text || text.length < 2) return true;
    const trimmed = text.trim().toLowerCase();
    if (/^(g+h+|ggh|ghh|h+g+|uh+|um+|mm+|ah+|eh+|shh|tsk|zzz)$/i.test(trimmed)) {
      return true;
    }
    if (trimmed.length <= 4 && !/[aeiouy0-9]/.test(trimmed)) {
      return true;
    }
    return false;
  }

  /**
   * Submit voice or text edit: sends editing command to the AI document editor
   * with the latest notes document as the source of truth, preserving previous edits.
   * Seamlessly falls back to direct note insertion if AI is unavailable.
   */
  async function submitEdit() {
    if (isSubmittingEdit) return;
    const instruction = inputEl ? inputEl.value.trim() : '';
    if (!instruction) {
      if (inputEl) {
        inputEl.focus();
        inputEl.classList.add('vn-active-glow');
      }
      showStatus('Please type or speak a note first, then click Submit or press Enter.', false);
      setTimeout(hideStatus, 3500);
      return;
    }

    if (isGibberish(instruction)) {
      showStatus('No clear words heard. Please speak your edit again.');
      if (inputEl) inputEl.value = '';
      setTimeout(hideStatus, 3000);
      return;
    }

    stopSpeechRecognition();
    isSubmittingEdit = true;

    const video = getVideoElement();
    const userTime = video ? Math.floor(video.currentTime) : 0;
    const currentSelectedId = selectedNoteId;

    // Direct / fallback update handler
    const applyDirectFallback = () => {
      // Case 1: Updating an existing selected note with the exact voice ("same to same")
      if (selectedNoteId) {
        const targetNote = notesList.find((n) => n.id === selectedNoteId);
        if (targetNote) {
          // Record undo inverse
          undoStack.push({
            timestamp: Date.now(),
            inversePatch: [{
              action: 'update',
              id: targetNote.id,
              previousState: { ...targetNote }
            }]
          });

          // Update the selected note directly with the exact voice text ("same to same")
          targetNote.text = instruction;
          targetNote.source = 'user';
          targetNote.edited = true;

          const updatedId = targetNote.id;
          clearNoteSelection();

          if (inputEl) inputEl.value = '';

          renderAllNotes([updatedId]);
          debounceSaveNotes();
          showUndoFeedback('Note updated');
          showStatus('✓ Note updated with your voice edit');
          setTimeout(hideStatus, 2500);

          isSubmittingEdit = false;
          resumeVideo(true);
          return;
        }
        clearNoteSelection();
      }

      // Case 2: Adding a new note at current playback time
      const newNote = {
        id: `u_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        time: userTime,
        text: instruction,
        source: 'user',
        edited: true,
        createdAt: Date.now()
      };

      // Store undo record
      undoStack.push({
        timestamp: Date.now(),
        inversePatch: [{ action: 'delete', id: newNote.id }]
      });

      notesList.push(newNote);
      notesList.sort((a, b) => a.time - b.time);

      if (inputEl) inputEl.value = '';

      renderAllNotes([newNote.id]);
      debounceSaveNotes();
      showUndoFeedback('Note added');
      showStatus('✓ Note added directly');
      setTimeout(hideStatus, 2500);

      isSubmittingEdit = false;
      resumeVideo(true);
    };

    // Show AI progress status
    showStatus('🤖 AI is updating your notes...', false);

    // Dispatch PROCESS_VOICE_EDIT to background AI worker
    try {
      chrome.runtime.sendMessage(
        {
          type: MESSAGE_TYPES.PROCESS_VOICE_EDIT,
          payload: {
            videoId: currentVideoId,
            userTime,
            instruction,
            existingNotes: notesList,
            selectedNoteId: currentSelectedId,
            transcriptContext: videoTranscript.length > 0 ? videoTranscript.slice(-5).map((t) => t.text).join(' ') : ''
          }
        },
        (response) => {
          if (chrome.runtime.lastError || !response || !response.success) {
            console.warn(`${TAG} AI voice edit unavailable or failed, applying direct fallback:`, chrome.runtime.lastError?.message || response?.error);
            applyDirectFallback();
            return;
          }

          // Handle clarification prompt from AI
          if (response.status === 'clarification_needed') {
            isSubmittingEdit = false;
            showStatus('❓ AI: ' + (response.clarificationPrompt || 'Please specify which note or section to edit.'), false);
            if (inputEl) {
              inputEl.value = '';
              inputEl.placeholder = response.clarificationPrompt || 'Clarify your instruction...';
              inputEl.focus();
            }
            return;
          }

          // Apply AI-updated document
          if (Array.isArray(response.updatedNotes)) {
            notesList = response.updatedNotes;

            if (Array.isArray(response.inversePatch) && response.inversePatch.length > 0) {
              undoStack.push({
                timestamp: Date.now(),
                inversePatch: response.inversePatch
              });
            }

            clearNoteSelection();
            if (inputEl) {
              inputEl.value = '';
              inputEl.placeholder = 'Type a note or speak (Alt+V to pause)...';
            }

            const affected = Array.isArray(response.affectedIds) && response.affectedIds.length > 0
              ? response.affectedIds
              : undefined;

            renderAllNotes(affected);
            debounceSaveNotes();

            const summary = response.summary || 'Document updated';
            showUndoFeedback(summary);
            showStatus(`✓ AI: ${summary}`);
            setTimeout(hideStatus, 3500);

            isSubmittingEdit = false;
            resumeVideo(true);
          } else {
            applyDirectFallback();
          }
        }
      );
    } catch (sendErr) {
      console.warn(`${TAG} Exception sending voice edit to background:`, sendErr.message);
      applyDirectFallback();
    }
  }

  // Caption tracks cache from bridge
  let bridgeCaptionTracks = null;

  // Listen for captions broadcast from main-world bridge
  window.addEventListener('VOICENOTES_CAPTIONS_READY', (e) => {
    const { videoId, captionTracks } = e.detail || {};
    if (Array.isArray(captionTracks) && captionTracks.length > 0) {
      console.log(`${TAG} Received ${captionTracks.length} caption tracks from bridge for video: ${videoId}`);
      bridgeCaptionTracks = captionTracks;
      if (videoTranscript.length === 0) {
        processCaptionTracks(captionTracks);
      }
    }
  });

  // Listen for topic chapters broadcast from main-world bridge
  window.addEventListener('VOICENOTES_CHAPTERS_DATA', (e) => {
    const { videoId, chapters } = e.detail || {};
    if (videoId === currentVideoId && Array.isArray(chapters) && chapters.length > 0) {
      console.log(`${TAG} Received ${chapters.length} topic chapters from bridge for video: ${videoId}`);
      videoTopics = chapters.map((c, i) => ({
        index: i,
        title: c.title,
        startSec: c.startSec,
        endSec: c.endSec,
        isChapter: true
      }));
    }
  });

  // Listen for raw caption timedtext broadcast from main-world bridge
  window.addEventListener('VOICENOTES_CAPTIONS_DATA', (e) => {
    const { videoId, rawText, trackName } = e.detail || {};
    if (videoId === currentVideoId && rawText && videoTranscript.length === 0) {
      console.log(`${TAG} Received raw caption timedtext from bridge (${rawText.length} bytes)`);
      if (rawText.includes('<text')) {
        videoTranscript = parseXmlCaptions(rawText);
      } else if (rawText.trim().startsWith('{')) {
        try {
          const data = JSON.parse(rawText);
          const events = data.events || [];
          events.forEach((ev) => {
            if (!ev.segs || !Array.isArray(ev.segs)) return;
            const startSec = (ev.tStartMs || 0) / 1000;
            const durSec = (ev.dDurationMs || 0) / 1000;
            const text = ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
            const cleaned = unescapeHtml(text).replace(/\s+/g, ' ').trim();
            if (cleaned.length > 0) {
              videoTranscript.push({
                start: Math.round(startSec * 100) / 100,
                end: Math.round((startSec + durSec) * 100) / 100,
                text: cleaned
              });
            }
          });
        } catch (err) {}
      }
      if (videoTranscript.length > 0) {
        console.log(`${TAG} Loaded ${videoTranscript.length} caption segments from bridge.`);
        showStatus(`Live notes active (${trackName || 'Captions'})`);
        setTimeout(hideStatus, 4000);
        debounceSaveTranscript();
        updateCountBadge();
        if (currentView === 'transcript') {
          renderTranscriptView();
        } else {
          renderAllNotes();
        }
        autoGenerateNotes();
      }
    }
  });

  /**
   * Parse timed-text XML string into transcript segments
   */
  function parseXmlCaptions(xmlString) {
    const segments = [];
    if (!xmlString || typeof xmlString !== 'string') return segments;

    const textTagRegex = /<text\s+([^>]*?)>([\s\S]*?)<\/text>/gi;
    let match;

    while ((match = textTagRegex.exec(xmlString)) !== null) {
      const attrsStr = match[1];
      const rawContent = match[2];

      const startMatch = attrsStr.match(/start=["']([0-9.]+)["']/i);
      const durMatch = attrsStr.match(/dur=["']([0-9.]+)["']/i);

      const start = startMatch ? parseFloat(startMatch[1]) : 0;
      const dur = durMatch ? parseFloat(durMatch[1]) : 0;
      const text = unescapeHtml(rawContent.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

      if (text.length > 0) {
        segments.push({
          start: Math.round(start * 100) / 100,
          end: Math.round((start + dur) * 100) / 100,
          text
        });
      }
    }

    return segments;
  }

  /**
   * Process and fetch caption tracks
   */
  async function processCaptionTracks(captionTracks) {
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
      showStatus('No captions available on this video. Press Alt+V to speak or type notes.');
      return;
    }

    const prefLang = settings.preferredCaptionLang || 'en';
    const selectedTrack =
      captionTracks.find((t) => t.languageCode === prefLang && !t.kind) ||
      captionTracks.find((t) => t.languageCode === prefLang) ||
      captionTracks.find((t) => (t.languageCode === 'en' || t.vssId?.includes('.en')) && !t.kind) ||
      captionTracks.find((t) => t.languageCode === 'en' || t.vssId?.includes('.en')) ||
      captionTracks[0];

    if (!selectedTrack?.baseUrl) {
      showStatus('No caption URL available.');
      return;
    }

    const trackName = selectedTrack.name?.runs?.[0]?.text || selectedTrack.languageCode || 'Captions';
    console.log(`${TAG} Fetching caption data for track: ${trackName}`);

    // Request bridge to enable player subtitles for Layer 3 DOM observer fallback
    window.dispatchEvent(new CustomEvent('VOICENOTES_ENABLE_CC'));

    try {
      // 1. Fetch raw baseUrl (returns standard XML timed text) with user credentials
      let timedText = '';
      try {
        const rawRes = await fetch(selectedTrack.baseUrl, { credentials: 'include' });
        if (rawRes.ok) {
          timedText = await rawRes.text();
        }
      } catch (e) {
        console.warn(`${TAG} Raw caption fetch error:`, e.message);
      }

      // 1b. If direct fetch returned 429 or empty, attempt background service worker fetch
      if (!timedText || (!timedText.includes('<text') && !timedText.includes('{'))) {
        try {
          const bgRes = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              { type: 'FETCH_CAPTIONS', payload: { url: selectedTrack.baseUrl } },
              resolve
            );
          });
          if (bgRes?.success && bgRes.text) {
            timedText = bgRes.text;
          }
        } catch (e) {}
      }

      // 2. Fallback to srv3 or json3 if raw was empty or lacked <text tags
      if (!timedText || (!timedText.includes('<text') && !timedText.includes('{'))) {
        try {
          const sep = selectedTrack.baseUrl.includes('?') ? '&' : '?';
          const altRes = await fetch(selectedTrack.baseUrl + sep + 'fmt=srv3', { credentials: 'include' });
          if (altRes.ok) {
            timedText = await altRes.text();
          }
        } catch (e) {}
      }

      let parsed = [];

      // 3. Parse XML or JSON3
      if (timedText.includes('<text')) {
        parsed = parseXmlCaptions(timedText);
      } else if (timedText.trim().startsWith('{')) {
        try {
          const data = JSON.parse(timedText);
          const events = data.events || [];
          events.forEach((ev) => {
            if (!ev.segs || !Array.isArray(ev.segs)) return;
            const startSec = (ev.tStartMs || 0) / 1000;
            const durSec = (ev.dDurationMs || 0) / 1000;
            const text = ev.segs
              .map((s) => s.utf8 || '')
              .join('')
              .replace(/\n/g, ' ')
              .trim();
            const cleaned = unescapeHtml(text).replace(/\s+/g, ' ').trim();
            if (cleaned.length > 0) {
              parsed.push({
                start: Math.round(startSec * 100) / 100,
                end: Math.round((startSec + durSec) * 100) / 100,
                text: cleaned,
                source: 'CC'
              });
            }
          });
        } catch (e) {}
      }

      if (parsed.length > 0) {
        parsed.forEach((seg) => {
          if (!videoTranscript.some((t) => t.start === seg.start && t.text === seg.text)) {
            videoTranscript.push(seg);
          }
        });
        videoTranscript.sort((a, b) => a.start - b.start);
      }

      // 4. Fallback: Check if native transcript panel is already in DOM
      if (videoTranscript.length === 0) {
        const domSegments = document.querySelectorAll('ytd-transcript-segment-renderer');
        if (domSegments && domSegments.length > 0) {
          domSegments.forEach((el) => {
            const timeStr = el.querySelector('.segment-timestamp')?.textContent?.trim() || '0:00';
            const text = el.querySelector('.segment-text')?.textContent?.trim() || '';
            if (text) {
              const parts = timeStr.split(':').map(Number);
              const s = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
              videoTranscript.push({ start: s, end: s + 3, text });
            }
          });
        }
      }

      if (videoTranscript.length > 0) {
        console.log(`${TAG} Successfully loaded ${videoTranscript.length} caption segments.`);
        showStatus(`Live notes active (${trackName})`);
        setTimeout(hideStatus, 4000);
        debounceSaveTranscript();
        updateCountBadge();
        const video = getVideoElement();
        updateLiveDialogueStream(video ? Math.floor(video.currentTime) : 0);
        if (currentView === 'transcript') {
          renderTranscriptView();
        } else {
          renderAllNotes();
        }
        autoGenerateNotes();
      } else {
        console.log(`${TAG} Direct captions not available for this video.`);
        setSourceState('SOURCE_UNAVAILABLE', 'No captions found for this video');
        renderAllNotes();
      }
    } catch (err) {
      console.warn(`${TAG} Captions network error:`, err.message);
      setSourceState('SOURCE_UNAVAILABLE', 'Captions unavailable');
      renderAllNotes();
    }
  }

  /**
   * Tier 2: Scrape transcript from native YouTube DOM transcript panel if open
   */
  function scrapeNativeYouTubeTranscript() {
    const segments = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (!segments || segments.length === 0) return 0;
    let added = 0;
    segments.forEach((el) => {
      const timeStr = el.querySelector('.segment-timestamp')?.textContent?.trim() || '0:00';
      const text = el.querySelector('.segment-text')?.textContent?.trim() || '';
      if (text) {
        const parts = timeStr.split(':').map(Number);
        const s = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        if (!videoTranscript.some((t) => t.start === s && t.text === text)) {
          videoTranscript.push({ start: s, end: s + 3, text });
          added++;
        }
      }
    });
    if (added > 0) {
      videoTranscript.sort((a, b) => a.start - b.start);
      console.log(`${TAG} Scraped ${added} segments from native transcript panel.`);
      debounceSaveTranscript();
      updateCountBadge();
      const video = getVideoElement();
      updateLiveDialogueStream(video ? Math.floor(video.currentTime) : 0);
      if (currentView === 'transcript') {
        renderTranscriptView();
      }
    }
    return added;
  }

  /**
   * Auto-open YouTube's native transcript panel if present in description
   */
  function autoOpenYouTubeTranscript() {
    if (scrapeNativeYouTubeTranscript() > 0) return;
    const expandBtn = document.querySelector('#description-inline-expander #expand, #expand-sizer, #meta #expand');
    if (expandBtn && expandBtn.offsetParent !== null) {
      expandBtn.click();
    }
    setTimeout(() => {
      const transcriptBtn =
        document.querySelector('button[aria-label*="transcript" i]') ||
        document.querySelector('ytd-video-description-transcript-section-renderer button') ||
        Array.from(document.querySelectorAll('button')).find((b) =>
          b.textContent?.toLowerCase().includes('show transcript')
        );
      if (transcriptBtn) {
        console.log(`${TAG} Auto-opening native YouTube transcript.`);
        try {
          transcriptBtn.click();
          setTimeout(() => {
            const count = scrapeNativeYouTubeTranscript();
            if (count > 0) {
              showStatus(`Live notes active (${count} transcript segments)`);
              setTimeout(hideStatus, 4000);
              renderAllNotes();
              if (currentView === 'transcript') {
                renderTranscriptView();
              }
            }
          }, 1200);
        } catch (e) {}
      }
    }, 400);
  }

  /**
   * Discover and load caption tracks
   */
  async function loadCaptionsTrack(videoId) {
    console.log(`${TAG} Discovering caption tracks for video: ${videoId}`);
    bridgeCaptionTracks = null;
    if (!Array.isArray(videoTranscript)) videoTranscript = [];
    setSourceState('DETECTING_SOURCES');

    // Check Tier 2 Native Transcript Scraper first if panel is present
    const scraped = scrapeNativeYouTubeTranscript();
    if (scraped > 0) {
      setSourceState('CAPTIONS_ACTIVE');
      showStatus('Live notes active (native transcript)');
      setTimeout(hideStatus, 4000);
      renderAllNotes();
      return;
    }

    // 1. If bridge already supplied tracks, use them immediately
    if (bridgeCaptionTracks && bridgeCaptionTracks.length > 0) {
      await processCaptionTracks(bridgeCaptionTracks);
      return;
    }

    // 2. Request tracks from main-world bridge
    window.dispatchEvent(new CustomEvent('VOICENOTES_REQUEST_CAPTIONS'));

    // 3. Scan DOM script tags as secondary fallback
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const text = script.textContent || '';
      if (text.includes('captionTracks')) {
        const idx = text.indexOf('"captionTracks":');
        if (idx !== -1) {
          const arrayStart = text.indexOf('[', idx);
          if (arrayStart !== -1) {
            let depth = 0;
            let inString = false;
            let escape = false;
            for (let i = arrayStart; i < text.length; i++) {
              const c = text[i];
              if (escape) { escape = false; continue; }
              if (c === '\\') { escape = true; continue; }
              if (c === '"') { inString = !inString; continue; }
              if (!inString) {
                if (c === '[') depth++;
                else if (c === ']') {
                  depth--;
                  if (depth === 0) {
                    try {
                      const parsed = JSON.parse(text.substring(arrayStart, i + 1));
                      if (Array.isArray(parsed) && parsed.length > 0) {
                        bridgeCaptionTracks = parsed;
                        await processCaptionTracks(parsed);
                        return;
                      }
                    } catch (e) {}
                    break;
                  }
                }
              }
            }
          }
        }
      }
    }

    // 4. Retry after a short delay for bridge if page was still loading
    setTimeout(() => {
      if (videoTranscript.length === 0) {
        window.dispatchEvent(new CustomEvent('VOICENOTES_REQUEST_CAPTIONS'));

        // Auto-enable YouTube CC if transcript is not yet loaded
        const ccBtn = document.querySelector('.ytp-subtitles-button');
        if (ccBtn && ccBtn.getAttribute('aria-pressed') !== 'true') {
          console.log(`${TAG} Auto-enabling YouTube CC subtitles.`);
          ccBtn.click();
        }

        // Try opening native transcript panel
        autoOpenYouTubeTranscript();

        // Check if captions or native transcript are available
        setTimeout(() => {
          if (videoTranscript.length === 0) {
            console.log(`${TAG} No captions or transcript found on this video.`);
            setSourceState('SOURCE_UNAVAILABLE', 'No captions found for this video');
            renderAllNotes();
          }
        }, 1200);
      }
    }, 800);
  }

  /**
   * Layer 3: Live DOM Caption Observer fallback
   * Captures on-screen subtitles in real time as video plays (.ytp-caption-segment)
   */
  let domCaptionObserver = null;
  function setupLiveDomCaptionObserver() {
    if (domCaptionObserver) {
      domCaptionObserver.disconnect();
    }

    let lastObservedSubtitle = '';

    domCaptionObserver = new MutationObserver(() => {
      if (isAdPlaying()) return;
      const segments = document.querySelectorAll('.ytp-caption-segment, .caption-window');
      if (!segments || segments.length === 0) return;

      const currentText = Array.from(segments)
        .map((s) => s.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (currentText && currentText !== lastObservedSubtitle && currentText.length > 2) {
        lastObservedSubtitle = currentText;
        const video = getVideoElement();
        const currentTime = video ? Math.floor(video.currentTime) : 0;
        updateLiveDialogueStream(currentTime, currentText, 'Live Subtitle');

        // Check if this text is already in transcript near this time
        const alreadyExists = videoTranscript.some(
          (seg) => Math.abs(seg.start - currentTime) <= 4 && seg.text.includes(currentText)
        );

        if (!alreadyExists) {
          videoTranscript.push({
            start: currentTime,
            end: currentTime + 3,
            text: currentText,
            source: 'CC'
          });
          videoTranscript.sort((a, b) => a.start - b.start);
          debounceSaveTranscript();
          updateCountBadge();
          if (currentView === 'transcript') {
            renderTranscriptView();
          }
          if (notesList.length === 0) {
            autoGenerateNotes();
          }
          console.log(`${TAG} Captured on-screen subtitle: "${currentText}" at ${currentTime}s`);

          if (statusBarEl && statusBarEl.textContent?.includes('No captions')) {
            showStatus('Live captions detected from video');
            setTimeout(hideStatus, 3000);
          }
          updateLiveAudioIndicator();
        }
      }
    });

    const targetNode = document.getElementById('movie_player') || document.querySelector('.html5-video-player') || document.body;
    domCaptionObserver.observe(targetNode, { childList: true, subtree: true, characterData: true });
  }

  /**
   * Detect transition cues in transcript signaling the end or transition of a topic
   */
  function hasTopicTransitionCue(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    const transitionPatterns = [
      /\b(?:now\s+let'?s\s+move|moving\s+on\s+to|next\s+up|in\s+summary|to\s+summarize|so\s+that\s+concludes|that\s+covers|in\s+the\s+next\s+section|secondly|let'?s\s+turn\s+(?:to|our\s+attention)|our\s+next\s+topic|next\s+concept|that'?s\s+the\s+first\s+part|now\s+we\s+will|let'?s\s+now\s+discuss)\b/i
    ];
    return transitionPatterns.some((p) => p.test(lower));
  }

  /**
   * Discover and parse video topics / chapters from YouTube player response,
   * player UI, or video description timestamps.
   */
  function detectVideoTopics() {
    const video = getVideoElement();
    const duration = video?.duration ? Math.floor(video.duration) : 0;

    if (videoTopics.length > 0) {
      if (duration > 0 && videoTopics[videoTopics.length - 1].endSec === null) {
        videoTopics[videoTopics.length - 1].endSec = duration;
      }
      return videoTopics;
    }

    try {
      const descEl = document.querySelector('#description, ytd-text-inline-expander, #structured-description');
      const descText = descEl?.textContent || '';
      const regex = /(?:^|\n)\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]?\s*(.+?)(?=\n|$)/g;
      const domChapters = [];
      let match;
      while ((match = regex.exec(descText)) !== null) {
        const timeStr = match[1];
        const title = match[2].trim();
        const parts = timeStr.split(':').map(Number);
        let sec = 0;
        if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
        if (title.length > 2 && !domChapters.some((c) => c.startSec === sec)) {
          domChapters.push({ title, startSec: sec });
        }
      }
      if (domChapters.length > 1) {
        domChapters.sort((a, b) => a.startSec - b.startSec);
        for (let i = 0; i < domChapters.length; i++) {
          domChapters[i].index = i;
          domChapters[i].endSec = i < domChapters.length - 1 ? domChapters[i + 1].startSec : (duration || null);
          domChapters[i].isChapter = true;
        }
        videoTopics = domChapters;
        console.log(`${TAG} Detected ${videoTopics.length} chapters from DOM description.`);
        return videoTopics;
      }
    } catch (e) {}

    return videoTopics;
  }

  /**
   * Send transcript chunk to background worker for AI note generation.
   * Generates smart notes in the format: Heading then Summary of the whole topic.
   */
  function triggerChunkGeneration(chunkStart, chunkEnd, chunkText, onComplete = null, topicTitle = '') {
    const intervalKey = `${chunkStart}-${chunkEnd}`;
    pendingIntervals.add(intervalKey);
    isAiRequestActive = true;
    setWritingState(true, 'Writing smart notes');

    chrome.runtime.sendMessage(
      {
        type: 'GENERATE_LIVE_NOTES',
        payload: {
          chunkText,
          chunkStartTime: chunkStart,
          chunkEndTime: chunkEnd,
          existingNotes: notesList,
          videoTitle: getVideoTitle(),
          topicTitle: topicTitle || ''
        }
      },
      (response) => {
        isAiRequestActive = false;
        setWritingState(false);
        pendingIntervals.delete(intervalKey);

        if (typeof onComplete === 'function') {
          try {
            onComplete(response);
          } catch (e) {}
        }

        // Fast playback (1x - 3x): check if another topic completed while AI was generating
        const vid = getVideoElement();
        if (vid && !vid.paused) {
          const nowSec = Math.floor(vid.currentTime);
          checkTopicCompletion(nowSec, Boolean(vid.ended));
        }

        if (chrome.runtime.lastError) {
          console.warn(`${TAG} LLM error:`, chrome.runtime.lastError.message);
          showErrorWithRetry('Worker communication error', () => {
            triggerChunkGeneration(chunkStart, chunkEnd, chunkText, onComplete, topicTitle);
          });
          return;
        }

        if (response?.success && Array.isArray(response.notes)) {
          processedIntervals.add(intervalKey);
          const addedIds = [];

          for (const rawNote of response.notes) {
            if (!rawNote || typeof rawNote.text !== 'string' || !rawNote.text.trim()) continue;

            // Stable deduplication check against existing notes
            const isDuplicate = notesList.some(
              (n) =>
                n.id === rawNote.id ||
                (n.text.trim().toLowerCase() === rawNote.text.trim().toLowerCase() &&
                  Math.abs(n.time - (rawNote.time || chunkStart)) < 15)
            );

            if (!isDuplicate) {
              const newNote = {
                id: rawNote.id || `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                time: typeof rawNote.time === 'number' ? Math.max(0, Math.floor(rawNote.time)) : chunkStart,
                text: rawNote.text.trim(),
                source: rawNote.source === 'user' ? 'user' : 'ai',
                edited: Boolean(rawNote.edited),
                createdAt: rawNote.createdAt || Date.now()
              };
              notesList.push(newNote);
              addedIds.push(newNote.id);
            }
          }

          if (addedIds.length > 0) {
            renderAllNotes(addedIds);
            debounceSaveNotes();
            showStatus('Topic note added: Heading + Summary');
            setTimeout(hideStatus, 2500);
          } else {
            showStatus('Notes up to date');
            setTimeout(hideStatus, 2000);
          }
        } else if (response?.error) {
          console.warn(`${TAG} Live notes generation error:`, response.error);
          showErrorWithRetry('AI generation failed: ' + response.error, () => {
            triggerChunkGeneration(chunkStart, chunkEnd, chunkText, onComplete, topicTitle);
          });
        }
      }
    );
  }

  /**
   * Monitor video playback and check for topic completion.
   * When the video reaches the point where a topic completes (first topic and subsequent topics),
   * synthesizes a smart note in the format: Heading then summary of the whole topic.
   */
  function checkTopicCompletion(currentSec, isEnded = false) {
    if (isAiRequestActive || !settings.liveEnabled || videoTranscript.length === 0) return;

    const topics = detectVideoTopics();

    // Strategy 1: Video with defined chapters / topic markers
    if (topics.length > 0) {
      for (let i = 0; i < topics.length; i++) {
        if (completedTopicIndices.has(i)) continue;
        const topic = topics[i];
        const endSec = topic.endSec !== null ? topic.endSec : (i < topics.length - 1 ? topics[i + 1].startSec : null);

        // Topic completes when playback reaches its end timestamp, or video finishes
        const isTopicCompleted = (endSec !== null && currentSec >= endSec) || (isEnded && currentSec >= topic.startSec);

        if (isTopicCompleted) {
          const effectiveEnd = endSec !== null ? endSec : currentSec;
          const topicSegments = videoTranscript.filter(
            (seg) => seg.start >= topic.startSec && (endSec === null || seg.start < endSec)
          );
          const topicText = topicSegments.map((s) => s.text).join(' ').trim();

          if (topicText.length >= 10) {
            console.log(`${TAG} Topic ${i + 1} ("${topic.title}") completed at ${currentSec}s. Generating note...`);
            completedTopicIndices.add(i);
            lastTopicCompletedTime = effectiveEnd;
            lastProcessedTime = effectiveEnd;
            showStatus(`Topic ${i + 1} completed: "${topic.title}". Generating summary note...`);
            updateHeaderStatus('GENERATING');

            triggerChunkGeneration(
              topic.startSec,
              effectiveEnd,
              topicText,
              () => {
                updateHeaderStatus();
                showStatus(`✓ Added note for completed topic: "${topic.title}"`);
                setTimeout(hideStatus, 3500);
              },
              topic.title
            );
            return;
          } else {
            completedTopicIndices.add(i);
          }
        } else {
          // Video is currently inside this topic and hasn't reached the completion point yet
          const topicName = topic.title || `Topic ${i + 1}`;
          if (topicName !== activeTopicName && !isAdActive) {
            activeTopicName = topicName;
            showStatus(`Listening to Topic ${i + 1}: "${topicName}" (generates note when topic completes)...`);
          }
          break; // Stop at the active topic
        }
      }
      return;
    }

    // Strategy 2: Video without predefined chapters (Dynamic Topic Boundary Detection)
    const topicStart = lastTopicCompletedTime;
    const elapsed = currentSec - topicStart;

    const candidateSegments = videoTranscript.filter(
      (seg) => seg.start >= topicStart && seg.start <= currentSec
    );
    const candidateText = candidateSegments.map((s) => s.text).join(' ').trim();

    // A topic completes when:
    // 1) Transition cue detected in transcript after substantive dialogue (>= 45s and >= 35 words)
    // 2) OR topic reaches standard educational concept threshold (>= 60s and >= 35 words)
    // 3) OR video ended (>= 15s dialogue)
    const isTransitionCue = elapsed >= 45 && hasTopicTransitionCue(candidateText);
    const isDurationThreshold = elapsed >= 60 && candidateText.split(/\s+/).length >= 35;
    const isVideoEnd = isEnded && candidateText.split(/\s+/).length >= 10;

    if ((isTransitionCue || isDurationThreshold || isVideoEnd) && candidateText.length >= 20) {
      const topicIndex = completedTopicIndices.size;
      completedTopicIndices.add(topicIndex);
      lastTopicCompletedTime = currentSec;
      lastProcessedTime = currentSec;

      console.log(`${TAG} Topic ${topicIndex + 1} completed at ${currentSec}s! Generating note...`);
      showStatus(`Topic ${topicIndex + 1} completed. Generating note...`);
      updateHeaderStatus('GENERATING');

      triggerChunkGeneration(
        topicStart,
        currentSec,
        candidateText,
        () => {
          updateHeaderStatus();
          showStatus(`✓ Added note for completed topic ${topicIndex + 1}.`);
          setTimeout(hideStatus, 3500);
        }
      );
    }
  }

  /**
   * Automatic Note Generation: Checks whether any topic has reached completion,
   * or monitors the first topic as playback progresses.
   */
  function autoGenerateNotes(forceCurrentDialogue = false) {
    if (isAiRequestActive || !settings.liveEnabled) return;
    if (!videoTranscript || videoTranscript.length === 0) return;

    const video = getVideoElement();
    const currentSec = video ? Math.floor(video.currentTime) : 0;

    // Check if the video has already reached or passed any completed topic
    checkTopicCompletion(currentSec, false);

    // If still at the beginning of the video and no notes yet, inform the user
    if (notesList.length === 0 && !isAiRequestActive && !isAdActive) {
      const topics = detectVideoTopics();
      if (topics.length > 0) {
        showStatus(`Tracking Topic 1: "${topics[0].title}" — Note will generate when topic completes.`);
      } else {
        showStatus('Listening to video... Smart notes will generate when the first topic completes.');
      }
    }
  }

  /**
   * Monitor video playback and process topics as they reach completion
   */
  function setupVideoTimeTracking() {
    const video = getVideoElement();
    if (!video) {
      setTimeout(setupVideoTimeTracking, 1000);
      return;
    }

    videoElement = video;
    const currentSec = Math.floor(video.currentTime);
    lastProcessedTime = notesList.length === 0 ? 0 : currentSec;
    lastObservedTime = currentSec;
    updateHeaderStatus(video.paused ? 'PAUSED' : 'LIVE');

    // Check for topics already completed if starting midway through video
    autoGenerateNotes();

    video.addEventListener('play', () => {
      updateHeaderStatus('LIVE');
      autoGenerateNotes();
    });

    video.addEventListener('pause', () => {
      updateHeaderStatus('PAUSED');
    });

    let lastRenderedReachedCount = -1;
    let isUserSeeking = false;

    // Track playback speed changes (1x - 3x)
    currentPlaybackRate = video.playbackRate || 1;
    video.addEventListener('ratechange', () => {
      currentPlaybackRate = video.playbackRate || 1;
      console.log(`${TAG} Video playback rate changed to ${currentPlaybackRate}x (supporting 1x - 3x live)`);
      updateHeaderStatus();
      const currentSec = Math.floor(video.currentTime);
      checkTopicCompletion(currentSec, Boolean(video.ended));
      renderAllNotes();
    });

    video.addEventListener('seeking', () => {
      isUserSeeking = true;
    });

    video.addEventListener('seeked', () => {
      isUserSeeking = false;
      const currentSec = Math.floor(video.currentTime);
      lastObservedTime = currentSec;
      lastProcessedTime = currentSec;
      lastRenderedReachedCount = -1;
      renderAllNotes();
      checkTopicCompletion(currentSec, Boolean(video.ended));
    });

    video.addEventListener('timeupdate', () => {
      const currentSec = Math.floor(video.currentTime);

      // Passive YouTube Ad Detection: Pause notes, ignore ad dialogue
      const playerEl = document.querySelector('.html5-video-player');
      if (isAdPlaying(playerEl, video)) {
        if (!isAdActive) {
          isAdActive = true;
          setSourceState('PAUSED_AD');
        }
        lastObservedTime = currentSec;
        lastProcessedTime = currentSec;
        return;
      } else if (isAdActive) {
        // Ad ended, cleanly resume tracking
        isAdActive = false;
        lastProcessedTime = currentSec;
        lastObservedTime = currentSec;
        setSourceState(
          videoTranscript.length > 0 ? 'CAPTIONS_ACTIVE' : 'DETECTING_SOURCES'
        );
      }

      updateLiveDialogueStream(currentSec);
      updateActiveTranscriptLine(video.currentTime);

      // Live update: reveal notes as playback reaches each note's timestamp
      const reachedCount = notesList.filter((n) => typeof n.time !== 'number' || n.time <= currentSec || n.source === 'user').length;
      if (reachedCount !== lastRenderedReachedCount) {
        lastRenderedReachedCount = reachedCount;
        renderAllNotes();
      }

      if (video.paused || isAiRequestActive || !settings.liveEnabled) return;

      // Handle seeking backwards or forward jump (scaled with 1x - 3x playback speed)
      const rate = video.playbackRate || currentPlaybackRate || 1;
      const maxForwardGap = Math.max(60, 45 * Math.max(1, rate));
      if (currentSec < lastObservedTime || (currentSec - lastObservedTime > maxForwardGap && isUserSeeking)) {
        lastProcessedTime = currentSec;
        lastObservedTime = currentSec;
      }
      lastObservedTime = currentSec;

      // Check if video has reached the point where a topic completes
      checkTopicCompletion(currentSec, false);
    });

    // Flush final topic note when video finishes
    video.addEventListener('ended', () => {
      console.log(`${TAG} Video ended.`);
      updateHeaderStatus('IDLE');
      lastRenderedReachedCount = -1;
      renderAllNotes();
      const currentSec = Math.floor(video.currentTime);
      checkTopicCompletion(currentSec, true);
    });
  }

  /**
   * Export notes to Markdown (Copy to Clipboard & Download)
   */
  async function exportNotes(downloadFile = false) {
    if (notesList.length === 0) {
      if (videoTranscript.length > 0) {
        if (downloadFile) {
          downloadTranscriptTxt();
        } else {
          copyFullTranscript();
        }
        return;
      }
      showStatus('No notes or transcript yet. Play the video to capture dialogue.');
      setTimeout(hideStatus, 3000);
      return;
    }

    currentVideoTitle = getVideoTitle();

    chrome.runtime.sendMessage(
      {
        type: 'EXPORT_NOTES',
        payload: {
          title: currentVideoTitle,
          videoId: currentVideoId,
          videoUrl: window.location.href,
          notes: notesList,
          downloadFile
        }
      },
      async (response) => {
        if (response?.success && response.markdown) {
          if (!downloadFile) {
            const copied = await copyTextToClipboard(response.markdown);
            showStatus(copied ? 'Markdown copied to clipboard!' : 'Could not copy to clipboard.');
          } else {
            showStatus('Markdown file downloaded!');
          }
          setTimeout(hideStatus, 3500);
        } else {
          showStatus('Export failed.', true);
        }
      }
    );
  }

  /**
   * Clear all notes for current video
   */
  function clearCurrentNotebook() {
    if (notesList.length === 0) return;
    const confirmed = window.confirm('Clear all notes for this video? This cannot be undone.');
    if (!confirmed) return;

    notesList = [];
    undoStack = [];
    processedIntervals.clear();
    pendingIntervals.clear();
    renderAllNotes();

    chrome.runtime.sendMessage({
      type: 'CLEAR_NOTES',
      payload: { videoId: currentVideoId }
    });

    showStatus('Notebook cleared.');
    setTimeout(hideStatus, 2500);
  }

  /**
   * Load saved notes from storage
   */
  function loadSavedNotes(videoId) {
    if (!videoId) {
      renderAllNotes();
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'LOAD_NOTES',
        payload: { videoId }
      },
      (res) => {
        if (chrome.runtime.lastError) {
          console.warn(`${TAG} Could not load notes:`, chrome.runtime.lastError.message);
          renderAllNotes();
          return;
        }
        if (res?.success && Array.isArray(res.notes)) {
          notesList = res.notes;
          console.log(`${TAG} Loaded ${notesList.length} notes for ${videoId}`);
        } else {
          notesList = [];
        }
        renderAllNotes();
        if (notesList.length === 0) {
          autoGenerateNotes();
        }
      }
    );
  }

  /**
   * Load user settings from background
   */
  function loadSettings() {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (res) => {
      if (res?.success && res.config) {
        settings.autoResume = res.config.autoResume !== undefined ? res.config.autoResume : true;
        settings.liveEnabled = res.config.liveEnabled !== undefined ? res.config.liveEnabled : true;
        settings.chunkInterval = res.config.chunkInterval || 15;
        settings.speechLang = res.config.speechLang || 'en-US';
        settings.preferredCaptionLang = res.config.preferredCaptionLang || 'en';
        chunkIntervalSec = settings.chunkInterval;
      }
    });
  }

  /**
   * Construct and mount the VoiceNotes panel inside a closed Shadow DOM
   */
  function initPanel() {
    const videoId = getVideoId();
    if (!videoId) {
      // Not a watch page
      if (hostElement) hostElement.remove();
      return;
    }

    // Prevent redundant wipe & remount if already initialized for this exact video
    if (currentVideoId === videoId && hostElement && document.getElementById('voicenotes-host')) {
      console.log(`${TAG} Already initialized for video: ${videoId}, skipping redundant re-init.`);
      return;
    }

    // Clean up previous listeners & observers on SPA navigation
    if (domCaptionObserver) {
      try { domCaptionObserver.disconnect(); } catch (e) {}
      domCaptionObserver = null;
    }
    stopSpeechRecognition();
    clearTimeout(speechRestartTimer);

    currentVideoId = videoId;
    currentVideoTitle = getVideoTitle();
    bridgeCaptionTracks = null;
    videoTranscript = [];
    processedIntervals.clear();
    pendingIntervals.clear();
    undoStack = [];
    lastProcessedTime = 0;
    lastObservedTime = 0;
    isAdActive = false;
    setSourceState('INITIALIZING');
    videoTopics = [];
    completedTopicIndices.clear();
    lastTopicCompletedTime = 0;
    activeTopicName = '';

    // Remove existing host if already present
    const existingHost = document.getElementById('voicenotes-host');
    if (existingHost) existingHost.remove();

    // Create host container
    hostElement = document.createElement('div');
    hostElement.id = 'voicenotes-host';
    hostElement.style.position = 'fixed';
    hostElement.style.top = '0';
    hostElement.style.right = '0';
    hostElement.style.width = '340px';
    hostElement.style.height = '100vh';
    hostElement.style.zIndex = '2147483647';
    hostElement.style.pointerEvents = 'none';
    hostElement.style.overflow = 'visible';

    // Attach Shadow DOM boundary
    shadowRoot = hostElement.attachShadow({ mode: 'open' });
    window.__voicenotes = {
      shadowRoot,
      switchView,
      renderTranscriptView,
      renderAllNotes,
      getVideoTranscript: () => videoTranscript,
      getNotes: () => notesList,
      getVideoTopics: () => videoTopics,
      setVideoTopics: (topics) => { videoTopics = topics; },
      checkTopicCompletion
    };

    // Link panel stylesheet
    const styleLink = document.createElement('link');
    styleLink.rel = 'stylesheet';
    styleLink.href = chrome.runtime.getURL('panel.css');
    shadowRoot.appendChild(styleLink);

    // 1. Root container
    panelRoot = el('div', { className: 'vn-root' });

    // 2. Floating toggle pill when collapsed
    togglePill = el('button', {
      className: 'vn-toggle-pill vn-hidden',
      text: 'VoiceNotes'
    });
    togglePill.addEventListener('click', (e) => {
      e.stopPropagation();
      panelRoot.classList.remove('vn-collapsed');
      togglePill.classList.add('vn-hidden');
    });

    // 3. Header
    const header = el('div', { className: 'vn-header' });

    const headerLeft = el('div', { className: 'vn-header-left' });
    const brandTitle = el('span', { className: 'vn-title', text: 'VoiceNotes' });

    headerStatusPillEl = el('span', { className: 'vn-status-pill vn-status-idle' });
    headerStatusDotEl = el('span', { className: 'vn-status-dot' });
    headerStatusTextEl = el('span', { className: 'vn-status-text', text: 'IDLE' });
    headerStatusPillEl.appendChild(headerStatusDotEl);
    headerStatusPillEl.appendChild(headerStatusTextEl);

    countBadgeEl = el('span', { className: 'vn-count-badge vn-hidden', text: '0' });

    headerLeft.appendChild(brandTitle);
    headerLeft.appendChild(headerStatusPillEl);
    headerLeft.appendChild(countBadgeEl);

    // Header actions
    const headerActions = el('div', { className: 'vn-header-actions' });

    // Copy Markdown button
    const copyMdBtn = el('button', {
      className: 'vn-icon-button',
      text: 'Copy',
      attrs: { title: 'Copy notes as Markdown' }
    });
    copyMdBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportNotes(false);
    });

    // Download .md button
    const downloadBtn = el('button', {
      className: 'vn-icon-button',
      text: '↓',
      attrs: { title: 'Download notes (.md)' }
    });
    downloadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportNotes(true);
    });

    // Settings menu button
    const menuBtn = el('button', {
      className: 'vn-icon-button',
      text: '•••',
      attrs: { title: 'Settings & Options' }
    });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }, () => {
          if (chrome.runtime.lastError) {
            window.open(chrome.runtime.getURL('options.html'), '_blank');
          }
        });
      } catch (err) {
        window.open(chrome.runtime.getURL('options.html'), '_blank');
      }
    });

    // Collapse button
    const collapseBtn = el('button', {
      className: 'vn-icon-button',
      text: '—',
      attrs: { title: 'Collapse panel' }
    });
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panelRoot.classList.add('vn-collapsed');
      togglePill.classList.remove('vn-hidden');
    });

    headerActions.appendChild(copyMdBtn);
    headerActions.appendChild(downloadBtn);
    headerActions.appendChild(menuBtn);
    headerActions.appendChild(collapseBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerActions);
    panelRoot.appendChild(header);

    // 4. Dual View Tabs Switcher (Deleted from visible screen per user request; runs 100% in background)
    // viewTabsContainerEl, notesTabBtnEl, transcriptTabBtnEl are initialized for background tracking if needed,
    // but NEVER appended to panelRoot, so transcript selection does not appear on screen.
    viewTabsContainerEl = el('div', { className: 'vn-view-tabs vn-hidden' });

    notesTabBtnEl = el('button', {
      className: 'vn-tab-btn vn-tab-active',
      text: `📝 Notes (${notesList.length})`,
      attrs: { title: 'View Digital Notepad Document' }
    });
    notesTabBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      switchView('notes');
    });

    transcriptTabBtnEl = el('button', {
      className: 'vn-tab-btn',
      text: `📜 Transcript (${videoTranscript.length})`,
      attrs: { title: 'View Line-by-Line Video Transcript' }
    });
    transcriptTabBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      switchView('transcript');
    });

    viewTabsContainerEl.appendChild(notesTabBtnEl);
    viewTabsContainerEl.appendChild(transcriptTabBtnEl);
    // Deleted from on-screen display: panelRoot only displays notes workspace!
    currentView = 'notes';

    // 5. Workspace Toolbar (Search + Prominent Generate Notes Button)
    const workspaceToolbar = el('div', { className: 'vn-workspace-toolbar' });

    const searchWrapper = el('div', { className: 'vn-search-wrapper' });
    const searchIcon = el('span', { className: 'vn-search-icon', text: '🔍' });
    searchInputEl = el('input', {
      className: 'vn-search-input',
      attrs: {
        type: 'text',
        placeholder: 'Search notes...',
        autocomplete: 'off',
        spellcheck: 'false'
      }
    });
    isolateKeyboardEvents(searchInputEl);

    searchInputEl.addEventListener('input', () => {
      searchFilterQuery = searchInputEl.value;
      renderAllNotes();
    });
    searchWrapper.appendChild(searchIcon);
    searchWrapper.appendChild(searchInputEl);

    workspaceToolbar.appendChild(searchWrapper);
    panelRoot.appendChild(workspaceToolbar);

    // 6. Status Bar
    statusBarEl = el('div', { className: 'vn-status-bar vn-hidden' });
    panelRoot.appendChild(statusBarEl);

    // 7. Paused Banner
    bannerEl = el('div', {
      className: 'vn-banner vn-hidden',
      text: 'Video paused — Speak or type your edit'
    });
    panelRoot.appendChild(bannerEl);

    // 7. Notes Scrollable Container (The ONLY view displayed on screen)
    notesContainerEl = el('div', {
      className: 'vn-notes-container'
    });
    panelRoot.appendChild(notesContainerEl);

    // 7b. Transcript & Audio Scrollable Container (Kept hidden for background processes)
    transcriptContainerEl = el('div', {
      className: 'vn-transcript-container vn-hidden'
    });
    panelRoot.appendChild(transcriptContainerEl);

    // 8. Writing / AI Indicator
    writingIndicatorEl = el('div', { className: 'vn-writing-state vn-hidden' });
    writingTextEl = el('span', { text: 'Writing notes' });
    const dotsContainer = el('div', { className: 'vn-dots' });
    dotsContainer.appendChild(el('span'));
    dotsContainer.appendChild(el('span'));
    dotsContainer.appendChild(el('span'));
    writingIndicatorEl.appendChild(writingTextEl);
    writingIndicatorEl.appendChild(dotsContainer);
    panelRoot.appendChild(writingIndicatorEl);

    // 9. Footer & Edit Input
    const footer = el('div', { className: 'vn-footer' });

    const inputWrapper = el('div', { className: 'vn-input-wrapper' });
    inputEl = el('input', {
      className: 'vn-input',
      attrs: {
        type: 'text',
        placeholder: 'Speak or type an edit (Alt+V)...',
        autocomplete: 'off',
        spellcheck: 'false'
      }
    });
    isolateKeyboardEvents(inputEl);

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitEdit();
      } else if (e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault();
        resumeVideo(true);
      }
    });

    // Mic button for speech recognition
    micBtn = el('button', {
      className: 'vn-mic-btn',
      text: '🎤',
      attrs: { title: 'Speak edit (Microphone)' }
    });
    micBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSpeechRecognition();
    });

    // Submit button for text/voice edit
    const submitBtn = el('button', {
      className: 'vn-submit-btn',
      text: 'Submit ⏎',
      attrs: { title: 'Submit edit to AI (Enter)' }
    });
    submitBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      submitEdit();
    });

    inputWrapper.appendChild(inputEl);
    inputWrapper.appendChild(micBtn);
    inputWrapper.appendChild(submitBtn);
    footer.appendChild(inputWrapper);

    // Button Row: Pause & Edit, Resume, Clear
    const buttonRow = el('div', { className: 'vn-button-row' });

    const pauseEditBtn = el('button', { className: 'vn-btn vn-btn-primary' });
    const pauseLabel = el('span', { text: 'Pause & Edit' });
    const pauseKbd = el('kbd', { className: 'vn-kbd', text: 'Alt+V' });
    pauseEditBtn.appendChild(pauseLabel);
    pauseEditBtn.appendChild(pauseKbd);
    pauseEditBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pauseAndEdit();
    });

    const resumeBtn = el('button', { className: 'vn-btn' });
    const resumeLabel = el('span', { text: 'Resume' });
    const resumeKbd = el('kbd', { className: 'vn-kbd', text: 'Esc' });
    resumeBtn.appendChild(resumeLabel);
    resumeBtn.appendChild(resumeKbd);
    resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resumeVideo(true);
    });

    buttonRow.appendChild(pauseEditBtn);
    buttonRow.appendChild(resumeBtn);
    footer.appendChild(buttonRow);
    panelRoot.appendChild(footer);

    // Allow Alt+V and Escape to trigger cleanly inside panelRoot even when shadow DOM elements have focus
    panelRoot.addEventListener('keydown', (e) => {
      if ((e.altKey || e.metaKey) && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) {
        e.preventDefault();
        e.stopPropagation();
        pauseAndEdit();
      } else if (e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        resumeVideo(true);
      }
    });

    isolateKeyboardEvents(panelRoot);

    shadowRoot.appendChild(togglePill);
    shadowRoot.appendChild(panelRoot);

    document.body.appendChild(hostElement);
    console.log(`${TAG} VoiceNotes panel mounted successfully.`);

    // Render initial views immediately so UI is never blank
    renderAllNotes();
    renderTranscriptView();
    updateHeaderStatus();
    updateLiveDialogueStream(0);

    // Load saved notes, saved transcript and start caption tracking
    loadSettings();
    loadSavedNotes(currentVideoId);
    loadSavedTranscript(currentVideoId);
    loadCaptionsTrack(currentVideoId);
    setupVideoTimeTracking();
    setupSpeechRecognition();
    setupLiveDomCaptionObserver();

    // When the user starts the extension on YouTube, automatically start writing notes
    setTimeout(() => {
      if (notesList.length === 0 && videoTranscript.length > 0) {
        console.log(`${TAG} Video open on YouTube detected: starting automatic note writing.`);
        autoGenerateNotes();
      }
    }, 1200);
  }

  // Global Alt+V and Escape listeners with capture: true
  window.addEventListener(
    'keydown',
    (e) => {
      // 1. Alt+V to Pause & Edit
      if ((e.altKey || e.metaKey) && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) {
        e.preventDefault();
        e.stopPropagation();
        pauseAndEdit();
        return;
      }

      // 2. Escape to Resume Video
      if (e.key === 'Escape' || e.code === 'Escape') {
        const isInputActive = inputEl && (document.activeElement === inputEl || shadowRoot?.activeElement === inputEl);
        const isPaused = bannerEl && !bannerEl.classList.contains('vn-hidden');
        const video = getVideoElement();
        const isVideoPaused = video && video.paused;

        if (isInputActive || isPaused || isVideoPaused) {
          e.preventDefault();
          e.stopPropagation();
          resumeVideo(true);
        }
      }
    },
    { capture: true }
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if ((e.altKey || e.metaKey) && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) {
        e.preventDefault();
        e.stopPropagation();
        pauseAndEdit();
      } else if (e.key === 'Escape' || e.code === 'Escape') {
        const isInputActive = inputEl && (document.activeElement === inputEl || shadowRoot?.activeElement === inputEl);
        const isPaused = bannerEl && !bannerEl.classList.contains('vn-hidden');
        if (isInputActive || isPaused) {
          e.preventDefault();
          e.stopPropagation();
          resumeVideo(true);
        }
      }
    },
    { capture: true }
  );

  // Background commands & actions listener
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'TOGGLE_PANEL') {
      if (panelRoot) {
        const isCollapsed = panelRoot.classList.contains('vn-collapsed');
        if (isCollapsed) {
          panelRoot.classList.remove('vn-collapsed');
          if (togglePill) togglePill.classList.add('vn-hidden');
        } else {
          panelRoot.classList.add('vn-collapsed');
          if (togglePill) togglePill.classList.remove('vn-hidden');
        }
      } else {
        initPanel();
      }
    } else if (message.type === 'COMMAND_TRIGGERED' && message.payload?.command === 'toggle-pause-edit') {
      pauseAndEdit();
    }
  });

  // Automatically sync preference changes from options page
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local') {
        loadSettings();
      }
    });
  }

  // Watch for YouTube SPA navigation events
  window.addEventListener('yt-navigate-finish', () => {
    console.log(`${TAG} yt-navigate-finish event detected.`);
    initPanel();
  });

  window.addEventListener('popstate', () => {
    setTimeout(initPanel, 500);
  });

  // Initial startup
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanel);
  } else {
    initPanel();
  }
})();
