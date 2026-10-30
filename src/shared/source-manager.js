/**
 * VoiceNotes - Source Manager & Ad Detector
 * Manages transcript source states (Captions -> Live Audio Fallback),
 * ad detection, and transcript item normalization.
 */

import { unescapeHtml } from './validator.js';

export const SOURCE_STATES = {
  INITIALIZING: 'INITIALIZING',
  DETECTING_SOURCES: 'DETECTING_SOURCES',
  CAPTIONS_ACTIVE: 'CAPTIONS_ACTIVE',
  AUDIO_FALLBACK: 'AUDIO_FALLBACK',
  TRANSCRIBING: 'TRANSCRIBING',
  GENERATING_NOTES: 'GENERATING_NOTES',
  PAUSED_AD: 'PAUSED_AD',
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE'
};

export const STATUS_MESSAGES = {
  [SOURCE_STATES.INITIALIZING]: 'Initializing session...',
  [SOURCE_STATES.DETECTING_SOURCES]: 'Detecting captions...',
  [SOURCE_STATES.CAPTIONS_ACTIVE]: 'Captions active',
  [SOURCE_STATES.AUDIO_FALLBACK]: 'Waiting for captions',
  [SOURCE_STATES.TRANSCRIBING]: 'Processing captions...',
  [SOURCE_STATES.GENERATING_NOTES]: 'Generating notes...',
  [SOURCE_STATES.PAUSED_AD]: 'Ad detected — note-taking paused',
  [SOURCE_STATES.SOURCE_UNAVAILABLE]: 'Waiting for captions or transcript'
};

/**
 * Robust YouTube Ad Detection (Passive, read-only DOM and API checks)
 * Never interacts with or modifies ad elements.
 * Returns true if an advertisement is currently playing.
 */
export function isAdPlaying(playerEl = null, videoEl = null) {
  // 1. Direct player class checks
  if (playerEl) {
    if (typeof playerEl.classList?.contains === 'function') {
      if (
        playerEl.classList.contains('ad-showing') ||
        playerEl.classList.contains('ad-interrupting')
      ) {
        return true;
      }
    }

    // YouTube HTML5 Player API getAdState()
    if (typeof playerEl.getAdState === 'function') {
      try {
        const adState = playerEl.getAdState();
        if (adState > 0) return true;
      } catch (e) {}
    }
  }

  // 2. Global DOM ad markers
  if (typeof document !== 'undefined') {
    const adOverlay = document.querySelector('.ytp-ad-player-overlay, .ytp-ad-overlay-container');
    if (adOverlay && adOverlay.offsetParent !== null) {
      return true;
    }

    const adModule = document.querySelector('.video-ads.ytp-ad-module');
    if (adModule && adModule.children && adModule.children.length > 0) {
      // Check if any ad children are visible
      for (const child of adModule.children) {
        if (child.style?.display !== 'none' && !child.classList?.contains('ytp-ad-module-hidden')) {
          return true;
        }
      }
    }

    const ytpPlayer = document.querySelector('.html5-video-player');
    if (ytpPlayer?.classList) {
      if (
        ytpPlayer.classList.contains('ad-showing') ||
        ytpPlayer.classList.contains('ad-interrupting')
      ) {
        return true;
      }
    }
  }

  // 3. Video element check inside ad container
  if (videoEl && videoEl.closest) {
    try {
      if (videoEl.closest('.ad-showing, .ad-interrupting, .video-ads')) {
        return true;
      }
    } catch (e) {}
  }

  return false;
}

/**
 * Normalize a single transcript item
 */
export function normalizeTranscriptItem({
  videoId = '',
  sessionId = '',
  start = 0,
  end = 0,
  text = '',
  source = 'Captions',
  id = null
} = {}) {
  const safeStart = Math.max(0, Math.floor(Number(start) || 0));
  const safeEnd = Math.max(safeStart, Math.floor(Number(end) || safeStart + 3));
  const cleanText = unescapeHtml(String(text || '')).trim().replace(/\s+/g, ' ');

  const safeId = id || `t_${safeStart}_${Math.random().toString(36).substring(2, 7)}`;

  return {
    id: safeId,
    videoId: String(videoId || ''),
    sessionId: String(sessionId || ''),
    start: safeStart,
    end: safeEnd,
    text: cleanText,
    source: String(source || 'Captions')
  };
}

/**
 * Check if a new segment is a duplicate of an existing segment within a time window
 */
export function isDuplicateSegment(existingSegments, newSegment, timeToleranceSec = 4) {
  if (!Array.isArray(existingSegments) || !newSegment || !newSegment.text) {
    return false;
  }

  const newText = newSegment.text.toLowerCase().trim();
  if (newText.length === 0) return true;

  return existingSegments.some((seg) => {
    if (!seg || !seg.text) return false;
    const timeDiff = Math.abs(seg.start - newSegment.start);
    if (timeDiff > timeToleranceSec) return false;

    const existingText = seg.text.toLowerCase().trim();
    return (
      existingText === newText ||
      existingText.includes(newText) ||
      newText.includes(existingText)
    );
  });
}

/**
 * Source State Machine
 */
export class SourceStateMachine {
  constructor(onStateChange = null) {
    this.state = SOURCE_STATES.INITIALIZING;
    this.customMessage = null;
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    this.stateHistory = [];
  }

  getState() {
    return this.state;
  }

  getStatusMessage() {
    return this.customMessage || STATUS_MESSAGES[this.state] || this.state;
  }

  transitionTo(nextState, customMessage = null) {
    if (!SOURCE_STATES[nextState]) {
      console.warn(`[SourceStateMachine] Invalid target state: ${nextState}`);
      return false;
    }

    const previousState = this.state;
    this.state = nextState;
    this.customMessage = customMessage;

    const event = {
      state: this.state,
      previousState,
      message: this.getStatusMessage(),
      timestamp: Date.now()
    };

    this.stateHistory.push(event);
    if (this.stateHistory.length > 30) {
      this.stateHistory.shift();
    }

    if (this.onStateChange) {
      try {
        this.onStateChange(event);
      } catch (err) {
        console.warn(`[SourceStateMachine] Callback error:`, err);
      }
    }

    return true;
  }
}

