import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isAdPlaying } from '../src/shared/source-manager.js';

describe('Ad Detector', () => {
  it('returns false when no ad elements or classes are present', () => {
    const mockPlayer = {
      classList: {
        contains: (cls) => ['html5-video-player', 'playing-mode'].includes(cls)
      },
      getAdState: () => 0
    };
    const mockVideo = {
      closest: () => null
    };

    assert.equal(isAdPlaying(mockPlayer, mockVideo), false);
  });

  it('detects ad when player has ad-showing class', () => {
    const mockPlayer = {
      classList: {
        contains: (cls) => ['html5-video-player', 'ad-showing'].includes(cls)
      }
    };
    assert.equal(isAdPlaying(mockPlayer, null), true);
  });

  it('detects ad when player has ad-interrupting class', () => {
    const mockPlayer = {
      classList: {
        contains: (cls) => ['html5-video-player', 'ad-interrupting'].includes(cls)
      }
    };
    assert.equal(isAdPlaying(mockPlayer, null), true);
  });

  it('detects ad when player getAdState() returns 1', () => {
    const mockPlayer = {
      classList: {
        contains: () => false
      },
      getAdState: () => 1
    };
    assert.equal(isAdPlaying(mockPlayer, null), true);
  });

  it('detects ad when video element is within ad container', () => {
    const mockPlayer = {
      classList: {
        contains: () => false
      }
    };
    const mockVideo = {
      closest: (sel) => {
        if (sel.includes('.ad-showing') || sel.includes('.video-ads')) {
          return { id: 'ad-container' };
        }
        return null;
      }
    };
    assert.equal(isAdPlaying(mockPlayer, mockVideo), true);
  });
});

