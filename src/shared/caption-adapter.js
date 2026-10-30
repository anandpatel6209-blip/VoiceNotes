/**
 * VoiceNotes - YouTube Caption Adapter
 * Extracts, fetches, parses, and normalizes caption tracks (json3 and xml formats).
 */

import { unescapeHtml } from './validator.js';

export class CaptionAdapter {
  constructor() {
    this.cachedTracks = new Map(); // videoId -> captionTracks list
    this.cachedTranscript = new Map(); // videoId -> transcript segments
  }

  /**
   * Parse timed-text XML / srv3 format:
   * <transcript><text start="1.23" dur="4.56">caption text</text></transcript>
   */
  parseXmlCaptions(xmlString) {
    const segments = [];
    if (!xmlString || typeof xmlString !== 'string') return segments;

    // Use regex to be compatible in both browser and Node test environments
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
   * Parse YouTube timedtext json3 format:
   * { events: [ { tStartMs: 1200, dDurationMs: 3400, segs: [ { utf8: "text" } ] } ] }
   */
  parseJson3Captions(jsonData) {
    const segments = [];
    if (!jsonData || !Array.isArray(jsonData.events)) return segments;

    for (const ev of jsonData.events) {
      if (!ev.segs || !Array.isArray(ev.segs)) continue;

      const startSec = (ev.tStartMs || 0) / 1000;
      const durSec = (ev.dDurationMs || 0) / 1000;
      const text = ev.segs
        .map((s) => s.utf8 || '')
        .join('')
        .replace(/\n/g, ' ')
        .trim();

      const cleanedText = unescapeHtml(text).replace(/\s+/g, ' ').trim();
      if (cleanedText.length > 0) {
        segments.push({
          start: Math.round(startSec * 100) / 100,
          end: Math.round((startSec + durSec) * 100) / 100,
          text: cleanedText
        });
      }
    }

    return segments;
  }

  /**
   * Filter and order available caption tracks.
   * Preferred: preferred language -> english ('en') -> auto-translated english -> first track
   */
  selectBestTrack(captionTracks, preferredLang = 'en') {
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) return null;

    // 1. Direct match on preferred language
    const exactMatch = captionTracks.find((t) => t.languageCode === preferredLang && !t.kind);
    if (exactMatch) return exactMatch;

    // 2. Any track of preferred language (e.g. asr / auto-generated)
    const langMatch = captionTracks.find((t) => t.languageCode === preferredLang);
    if (langMatch) return langMatch;

    // 3. Standard English track
    const enMatch = captionTracks.find((t) => (t.languageCode === 'en' || t.vssId?.includes('.en')) && !t.kind);
    if (enMatch) return enMatch;

    // 4. Any English track (asr)
    const anyEnMatch = captionTracks.find((t) => t.languageCode === 'en' || t.vssId?.includes('.en'));
    if (anyEnMatch) return anyEnMatch;

    // 5. Fallback to first available track
    return captionTracks[0];
  }

  /**
   * Extract captionTracks array from page HTML or ytInitialPlayerResponse
   */
  extractTracksFromPage(docOrHtml) {
    if (typeof docOrHtml === 'string') {
      const match = docOrHtml.match(/"captionTracks":\s*(\[[\s\S]+?\])(?:,\s*"|})/);
      if (match && match[1]) {
        try {
          return JSON.parse(match[1]);
        } catch (e) {
          return null;
        }
      }
      return null;
    }

    // In browser DOM:
    // 1. Check window.ytInitialPlayerResponse if accessible
    if (typeof window !== 'undefined' && window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
      return window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks;
    }

    // 2. Scan script tags in document
    if (docOrHtml && typeof docOrHtml.querySelectorAll === 'function') {
      const scripts = Array.from(docOrHtml.querySelectorAll('script'));
      for (const s of scripts) {
        const text = s.textContent || '';
        if (text.includes('captionTracks')) {
          const m = text.match(/"captionTracks":\s*(\[[\s\S]+?\])(?:,\s*"|})/);
          if (m && m[1]) {
            try {
              const parsed = JSON.parse(m[1]);
              if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed;
              }
            } catch (e) {
              // try next script
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Fetch caption track content and parse into timed transcript segments
   */
  async fetchTrackTranscript(trackUrl) {
    if (!trackUrl) throw new Error('Missing track URL');

    const jsonUrl = trackUrl + (trackUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    try {
      const res = await fetch(jsonUrl);
      if (res.ok) {
        const jsonData = await res.json();
        const segments = this.parseJson3Captions(jsonData);
        if (segments.length > 0) {
          return segments;
        }
      }
    } catch (e) {
      // Fallback to XML
    }

    // Fallback: fetch original XML URL
    const xmlRes = await fetch(trackUrl);
    if (!xmlRes.ok) {
      throw new Error(`Failed to fetch caption data (HTTP ${xmlRes.status})`);
    }
    const xmlText = await xmlRes.text();
    return this.parseXmlCaptions(xmlText);
  }
}
