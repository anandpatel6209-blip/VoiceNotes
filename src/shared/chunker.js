/**
 * VoiceNotes - Transcript Chunker & Interval Tracker
 * Handles video playback time tracking, interval deduplication,
 * seeking, rewinding, pause/resume, and final segment flushing.
 */

export class TranscriptChunker {
  constructor(options = {}) {
    this.chunkInterval = options.chunkInterval || 30; // seconds
    this.minTextLength = options.minTextLength || 25; // characters
    this.maxTextLength = options.maxTextLength || 4000;

    this.videoId = options.videoId || '';
    this.transcript = []; // [{ start: number, end: number, text: string }]

    // State tracking
    this.currentPlayTime = 0;
    this.lastObservedTime = 0;
    this.lastProcessedTime = 0;

    // Track intervals: Set of strings "start-end"
    this.processedIntervals = new Set();
    this.pendingIntervals = new Set();
  }

  setVideoId(videoId) {
    if (this.videoId !== videoId) {
      this.videoId = videoId;
      this.reset();
    }
  }

  setTranscript(transcript) {
    this.transcript = Array.isArray(transcript) ? transcript : [];
  }

  setChunkInterval(interval) {
    if (typeof interval === 'number' && interval >= 10 && interval <= 120) {
      this.chunkInterval = interval;
    }
  }

  reset() {
    this.currentPlayTime = 0;
    this.lastObservedTime = 0;
    this.lastProcessedTime = 0;
    this.processedIntervals.clear();
    this.pendingIntervals.clear();
  }

  /**
   * Called on player timeupdate.
   * Returns a segment payload if an interval is eligible for AI processing, or null.
   */
  onTimeUpdate(videoTime, isSeeking = false, isEnded = false) {
    const currentSec = Math.max(0, Math.floor(videoTime));
    this.currentPlayTime = currentSec;

    // Detect backward seek or massive forward jump
    if (isSeeking || currentSec < this.lastObservedTime) {
      // User jumped backwards or sought
      this.lastObservedTime = currentSec;
      // Do not jump lastProcessedTime backwards into already committed regions,
      // but align lastProcessedTime so we don't accidentally create an enormous chunk
      this.lastProcessedTime = currentSec;
      return null;
    }

    this.lastObservedTime = currentSec;

    // Check if interval threshold reached, or video ended
    const elapsedSinceLast = currentSec - this.lastProcessedTime;
    if (elapsedSinceLast >= this.chunkInterval || (isEnded && elapsedSinceLast >= 10)) {
      const chunkStart = this.lastProcessedTime;
      const chunkEnd = currentSec;

      const intervalKey = `${chunkStart}-${chunkEnd}`;
      if (this.processedIntervals.has(intervalKey) || this.pendingIntervals.has(intervalKey)) {
        this.lastProcessedTime = currentSec;
        return null;
      }

      // Find transcript segments within this time window
      const eligibleSegments = this.transcript.filter(
        (seg) => seg.start >= chunkStart && seg.start < chunkEnd
      );

      let chunkText = eligibleSegments
        .map((s) => s.text)
        .join(' ')
        .trim();

      if (chunkText.length > this.maxTextLength) {
        chunkText = chunkText.slice(0, this.maxTextLength);
      }

      if (chunkText.length >= this.minTextLength) {
        this.pendingIntervals.add(intervalKey);
        this.lastProcessedTime = currentSec;

        return {
          videoId: this.videoId,
          intervalKey,
          chunkStartTime: chunkStart,
          chunkEndTime: chunkEnd,
          chunkText
        };
      } else {
        // Not enough speech text in this interval (e.g. music/silence/paused section)
        // Advance lastProcessedTime so we don't accumulate indefinite silence
        this.lastProcessedTime = currentSec;
        return null;
      }
    }

    return null;
  }

  /**
   * Mark interval as successfully processed by AI
   */
  commitInterval(intervalKey) {
    this.pendingIntervals.delete(intervalKey);
    this.processedIntervals.add(intervalKey);
  }

  /**
   * Release pending interval if job failed, allowing retry
   */
  failInterval(intervalKey) {
    this.pendingIntervals.delete(intervalKey);
  }

  /**
   * Flush final segment (e.g. when video finishes)
   */
  flushFinalSegment() {
    return this.onTimeUpdate(this.currentPlayTime, false, true);
  }
}
