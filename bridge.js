/**
 * VoiceNotes - Main World Bridge Script
 * Runs in the YouTube page's execution context (world: "MAIN")
 * with direct access to movie_player, window.ytInitialPlayerResponse, and player events.
 */

(() => {
  const TAG = '[VoiceNotes:bridge]';
  console.log(`${TAG} Main-world bridge initialized.`);

  // Intercept player's own fetch calls to /api/timedtext
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/api/timedtext')) {
        const clone = res.clone();
        clone
          .text()
          .then((rawText) => {
            if (rawText && (rawText.includes('<text') || rawText.includes('"events":'))) {
              const videoId =
                new URL(url, window.location.origin).searchParams.get('v') ||
                new URLSearchParams(window.location.search).get('v');
              console.log(`${TAG} Intercepted player timedtext (${rawText.length} bytes) for ${videoId}`);
              window.dispatchEvent(
                new CustomEvent('VOICENOTES_CAPTIONS_DATA', {
                  detail: {
                    videoId,
                    rawText,
                    trackName: 'Captions'
                  }
                })
              );
            }
          })
          .catch(() => {});
      }
    } catch (e) {}
    return res;
  };

  // Intercept player's XMLHttpRequest calls to /api/timedtext
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._vnUrl = url;
    return originalXhrOpen.apply(this, [method, url, ...rest]);
  };
  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (this._vnUrl && typeof this._vnUrl === 'string' && this._vnUrl.includes('/api/timedtext')) {
          const rawText = this.responseText;
          if (rawText && (rawText.includes('<text') || rawText.includes('"events":'))) {
            const videoId =
              new URL(this._vnUrl, window.location.origin).searchParams.get('v') ||
              new URLSearchParams(window.location.search).get('v');
            console.log(`${TAG} Intercepted XHR timedtext (${rawText.length} bytes) for ${videoId}`);
            window.dispatchEvent(
              new CustomEvent('VOICENOTES_CAPTIONS_DATA', {
                detail: {
                  videoId,
                  rawText,
                  trackName: 'Captions'
                }
              })
            );
          }
        }
      } catch (e) {}
    });
    return originalXhrSend.apply(this, args);
  };

  function getTracks(expectedVideoId) {
    try {
      const player = document.getElementById('movie_player');
      const playerResponse = player?.getPlayerResponse?.();
      const playerVid = playerResponse?.videoDetails?.videoId;
      if (!expectedVideoId || !playerVid || playerVid === expectedVideoId) {
        const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (Array.isArray(tracks) && tracks.length > 0) {
          return tracks;
        }
      }
    } catch (e) {}

    try {
      const initialResponse = window.ytInitialPlayerResponse;
      const initVid = initialResponse?.videoDetails?.videoId;
      if (!expectedVideoId || !initVid || initVid === expectedVideoId) {
        const tracks = initialResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (Array.isArray(tracks) && tracks.length > 0) {
          return tracks;
        }
      }
    } catch (e) {}

    return null;
  }

  function getChapters(expectedVideoId) {
    try {
      const player = document.getElementById('movie_player');
      const playerResponse = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
      const playerVid = playerResponse?.videoDetails?.videoId;
      if (!expectedVideoId || !playerVid || playerVid === expectedVideoId) {
        const rawChapters =
          playerResponse?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.playerBar
            ?.chapteredProgressBarRenderer?.chapters;
        if (Array.isArray(rawChapters) && rawChapters.length > 0) {
          const chapters = rawChapters
            .map((c, i) => {
              const rend = c.chapterRenderer;
              const title = rend?.title?.simpleText || rend?.title?.runs?.[0]?.text || `Topic ${i + 1}`;
              const startSec = Math.floor((rend?.timeRangeStartMillis || 0) / 1000);
              return { title, startSec };
            })
            .filter((c) => c.title);
          if (chapters.length > 0) {
            for (let i = 0; i < chapters.length; i++) {
              chapters[i].endSec = i < chapters.length - 1 ? chapters[i + 1].startSec : null;
            }
            return chapters;
          }
        }
      }
    } catch (e) {}

    // Fallback: Check description timestamps
    try {
      const player = document.getElementById('movie_player');
      const desc = (player?.getPlayerResponse?.() || window.ytInitialPlayerResponse)?.videoDetails?.shortDescription;
      if (desc) {
        const regex = /(?:^|\n)\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–—]?\s*(.+?)(?=\n|$)/g;
        const chapters = [];
        let match;
        while ((match = regex.exec(desc)) !== null) {
          const timeStr = match[1];
          const title = match[2].trim();
          const parts = timeStr.split(':').map(Number);
          let sec = 0;
          if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
          if (title.length > 2 && !chapters.some((c) => c.startSec === sec)) {
            chapters.push({ title, startSec: sec });
          }
        }
        if (chapters.length > 1) {
          chapters.sort((a, b) => a.startSec - b.startSec);
          for (let i = 0; i < chapters.length; i++) {
            chapters[i].endSec = i < chapters.length - 1 ? chapters[i + 1].startSec : null;
          }
          return chapters;
        }
      }
    } catch (e) {}

    return [];
  }

  function broadcastChapters() {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;
    const chapters = getChapters(videoId);
    if (chapters && chapters.length > 0) {
      console.log(`${TAG} Broadcasting ${chapters.length} topic chapters for video: ${videoId}`);
      window.dispatchEvent(
        new CustomEvent('VOICENOTES_CHAPTERS_DATA', {
          detail: {
            videoId,
            chapters
          }
        })
      );
    }
  }

  function enablePlayerCaptions() {
    try {
      const player = document.getElementById('movie_player');
      if (player) {
        if (typeof player.loadModule === 'function') {
          player.loadModule('captions');
        }
        if (typeof player.setOption === 'function') {
          player.setOption('captions', 'track', { languageCode: 'en' });
          player.setOption('captions', 'reload', true);
        }
      }
    } catch (e) {}
  }

  async function broadcastCaptions() {
    const videoId = new URLSearchParams(window.location.search).get('v');
    if (!videoId) return;

    const tracks = getTracks(videoId);
    if (tracks && tracks.length > 0) {
      console.log(`${TAG} Broadcasting ${tracks.length} caption tracks for video: ${videoId}`);
      window.dispatchEvent(
        new CustomEvent('VOICENOTES_CAPTIONS_READY', {
          detail: {
            videoId,
            captionTracks: tracks
          }
        })
      );

      // Attempt first-party fetch of track data inside YouTube's MAIN execution context
      const selectedTrack =
        tracks.find((t) => t.languageCode === 'en' && !t.kind) ||
        tracks.find((t) => t.languageCode === 'en') ||
        tracks[0];

      if (selectedTrack?.baseUrl) {
        let rawText = '';

        // Attempt 1: Fetch with &fmt=json3 (lighter, reliable, avoids XML 429)
        try {
          const sep = selectedTrack.baseUrl.includes('?') ? '&' : '?';
          const json3Url = selectedTrack.baseUrl + sep + 'fmt=json3';
          const res = await fetch(json3Url, { credentials: 'same-origin' });
          if (res.ok) {
            const text = await res.text();
            if (text && text.trim().startsWith('{')) {
              rawText = text;
            }
          }
        } catch (e) {}

        // Attempt 2: Standard baseUrl
        if (!rawText) {
          try {
            const res = await fetch(selectedTrack.baseUrl, { credentials: 'same-origin' });
            if (res.ok) {
              const text = await res.text();
              if (text && (text.includes('<text') || text.includes('{'))) {
                rawText = text;
              }
            }
          } catch (e) {}
        }

        // Attempt 3: Fetch with &fmt=srv3
        if (!rawText) {
          try {
            const sep = selectedTrack.baseUrl.includes('?') ? '&' : '?';
            const srv3Url = selectedTrack.baseUrl + sep + 'fmt=srv3';
            const res = await fetch(srv3Url, { credentials: 'same-origin' });
            if (res.ok) {
              const text = await res.text();
              if (text && text.includes('<text')) {
                rawText = text;
              }
            }
          } catch (e) {}
        }

        if (rawText) {
          console.log(`${TAG} MAIN bridge successfully fetched captions (${rawText.length} bytes)`);
          window.dispatchEvent(
            new CustomEvent('VOICENOTES_CAPTIONS_DATA', {
              detail: {
                videoId,
                rawText,
                trackName: selectedTrack.name?.runs?.[0]?.text || selectedTrack.languageCode || 'Captions'
              }
            })
          );
        }
      }
    }
  }

  // Broadcast on YouTube SPA navigation
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(() => { broadcastCaptions(); broadcastChapters(); }, 300);
    setTimeout(() => { broadcastCaptions(); broadcastChapters(); }, 1000);
    setTimeout(() => { broadcastCaptions(); broadcastChapters(); }, 2500);
  });

  // Respond immediately when isolated content script requests tracks or CC enable
  window.addEventListener('VOICENOTES_REQUEST_CAPTIONS', () => {
    broadcastCaptions();
    broadcastChapters();
  });

  window.addEventListener('VOICENOTES_REQUEST_CHAPTERS', () => {
    broadcastChapters();
  });

  window.addEventListener('VOICENOTES_ENABLE_CC', () => {
    enablePlayerCaptions();
  });

  // Periodic check during video load
  setTimeout(() => { broadcastCaptions(); broadcastChapters(); }, 500);
  setTimeout(() => { broadcastCaptions(); broadcastChapters(); }, 1500);
  setTimeout(() => { broadcastCaptions(); broadcastChapters(); }, 3500);
})();
