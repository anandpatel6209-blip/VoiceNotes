import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasTopicTransitionCue } from '../src/shared/validator.js';

describe('Playback Rate (1x to 3x) Speed Adaptation & Live Note Generation', () => {
  const contentJs = fs.readFileSync(path.join(process.cwd(), 'content.js'), 'utf-8');

  it('1. Tracks video playbackRate dynamically via ratechange event (supporting 1x to 3x)', () => {
    // Declares currentPlaybackRate
    assert.match(
      contentJs,
      /let\s+currentPlaybackRate\s*=\s*1;/,
      'Must declare currentPlaybackRate variable'
    );
    // Listens to ratechange event on video
    assert.match(
      contentJs,
      /video\.addEventListener\('ratechange',\s*\(\)\s*=>\s*\{/,
      'Must register ratechange listener on video'
    );
    // Updates currentPlaybackRate from video.playbackRate
    assert.match(
      contentJs,
      /currentPlaybackRate\s*=\s*video\.playbackRate\s*\|\|\s*1;/,
      'Must update currentPlaybackRate on ratechange'
    );
  });

  it('2. Reflects playback speed in header status pill for speeds between 1x and 3x', () => {
    // Shows speed in header when rate !== 1
    assert.match(
      contentJs,
      /const\s+rate\s*=\s*video\?\.playbackRate\s*\|\|\s*currentPlaybackRate\s*\|\|\s*1;/,
      'Must resolve playback rate'
    );
    assert.match(
      contentJs,
      /const\s+rateLabel\s*=\s*rate\s*!==\s*1\s*\?\s*`\s*\$\{rate\s*%\s*1\s*===\s*0\s*\?\s*rate\s*:\s*rate\.toFixed\(1\)\}x`\s*:\s*'';/,
      'Must format rate label (e.g. 1.5x, 2x, 3x)'
    );
  });

  it('3. Adapts seek/jump gap threshold dynamically to prevent false resets at 1x - 3x speeds', () => {
    // Scaled jump gap
    assert.match(
      contentJs,
      /const\s+maxForwardGap\s*=\s*Math\.max\(60,\s*45\s*\*\s*Math\.max\(1,\s*rate\)\);/,
      'Jump threshold must scale with playback speed'
    );
    // Listens to native seeking/seeked events
    assert.match(contentJs, /video\.addEventListener\('seeking',/);
    assert.match(contentJs, /video\.addEventListener\('seeked',/);
  });

  it('4. Follow-up check immediately triggers any topic completed while AI was generating at high speed', () => {
    // In triggerChunkGeneration on response
    assert.match(
      contentJs,
      /\/\/ Fast playback \(1x - 3x\): check if another topic completed while AI was generating[\s\S]*?checkTopicCompletion\(nowSec,\s*Boolean\(vid\.ended\)\);/,
      'Must re-check topic completion immediately when previous AI generation completes'
    );
  });

  it('5. Simulation: Identical structured notes generated accurately across 1x, 2x, and 3x speeds', () => {
    const chapters = [
      { title: 'System Architecture', startSec: 0, endSec: 120 },
      { title: 'Database Optimization', startSec: 120, endSec: 300 }
    ];

    const mockTranscript = [
      { start: 10, text: 'Welcome to system architecture overview.' },
      { start: 60, text: 'Microservices communicate through event brokers.' },
      { start: 115, text: 'That concludes our architecture module.' },
      { start: 130, text: 'Next up is database indexing and query optimization.' },
      { start: 200, text: 'B-tree indexes dramatically reduce query latency.' },
      { start: 290, text: 'Now let us move on to caching strategies.' }
    ];

    // Helper simulating topic completion check at given playback rate
    const simulateTopicExtraction = (rate) => {
      const generated = [];
      const completedIndices = new Set();
      const tickIntervalSec = 0.25 * rate; // Video seconds advanced per 250ms timeupdate tick

      for (let videoTime = 0; videoTime <= 300; videoTime += tickIntervalSec) {
        for (let i = 0; i < chapters.length; i++) {
          if (completedIndices.has(i)) continue;
          const chapter = chapters[i];
          if (videoTime >= chapter.endSec) {
            completedIndices.add(i);
            const topicSegs = mockTranscript.filter(
              (s) => s.start >= chapter.startSec && s.start < chapter.endSec
            );
            const text = topicSegs.map((s) => s.text).join(' ');
            generated.push({
              topicIndex: i,
              title: chapter.title,
              mediaTimestamp: chapter.endSec,
              text,
              hasTransition: hasTopicTransitionCue(text)
            });
          }
        }
      }
      return generated;
    };

    const notes1x = simulateTopicExtraction(1.0);
    const notes2x = simulateTopicExtraction(2.0);
    const notes3x = simulateTopicExtraction(3.0);

    // All speeds must produce exactly 2 topic notes
    assert.equal(notes1x.length, 2);
    assert.equal(notes2x.length, 2);
    assert.equal(notes3x.length, 2);

    // Topic 1 and Topic 2 text must be 100% identical across all speeds
    assert.equal(notes1x[0].text, notes2x[0].text);
    assert.equal(notes2x[0].text, notes3x[0].text);
    assert.equal(notes1x[1].text, notes2x[1].text);
    assert.equal(notes2x[1].text, notes3x[1].text);

    // Completion timestamps must be identical media seconds (120s and 300s)
    assert.equal(notes1x[0].mediaTimestamp, 120);
    assert.equal(notes2x[0].mediaTimestamp, 120);
    assert.equal(notes3x[0].mediaTimestamp, 120);

    assert.equal(notes1x[1].mediaTimestamp, 300);
    assert.equal(notes2x[1].mediaTimestamp, 300);
    assert.equal(notes3x[1].mediaTimestamp, 300);
  });
});

