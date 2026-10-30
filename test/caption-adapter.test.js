import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionAdapter } from '../src/shared/caption-adapter.js';

describe('CaptionAdapter', () => {
  const adapter = new CaptionAdapter();

  it('parses timed-text XML correctly', () => {
    const sampleXml = `
      <transcript>
        <text start="1.5" dur="2.3">Hello &amp; welcome to the course.</text>
        <text start="4.0" dur="3.1">We are discussing &quot;state&quot; here.</text>
      </transcript>
    `;

    const segments = adapter.parseXmlCaptions(sampleXml);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].start, 1.5);
    assert.equal(segments[0].end, 3.8);
    assert.equal(segments[0].text, 'Hello & welcome to the course.');
    assert.equal(segments[1].text, 'We are discussing "state" here.');
  });

  it('parses json3 timed captions format', () => {
    const sampleJson3 = {
      events: [
        {
          tStartMs: 1200,
          dDurationMs: 2500,
          segs: [{ utf8: 'First segment ' }, { utf8: 'continued' }]
        },
        {
          tStartMs: 4000,
          dDurationMs: 3000,
          segs: [{ utf8: 'Second point covered' }]
        }
      ]
    };

    const segments = adapter.parseJson3Captions(sampleJson3);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].start, 1.2);
    assert.equal(segments[0].end, 3.7);
    assert.equal(segments[0].text, 'First segment continued');
    assert.equal(segments[1].start, 4.0);
    assert.equal(segments[1].text, 'Second point covered');
  });

  it('selects best track preferring requested language or English', () => {
    const tracks = [
      { languageCode: 'es', name: { runs: [{ text: 'Spanish' }] } },
      { languageCode: 'en', kind: 'asr', vssId: 'a.en', name: { runs: [{ text: 'English (auto-generated)' }] } },
      { languageCode: 'en', vssId: '.en', name: { runs: [{ text: 'English' }] } },
      { languageCode: 'fr', name: { runs: [{ text: 'French' }] } }
    ];

    const selectedEn = adapter.selectBestTrack(tracks, 'en');
    assert.equal(selectedEn.languageCode, 'en');
    assert.equal(selectedEn.kind, undefined); // Prefers non-asr manual track

    const selectedEs = adapter.selectBestTrack(tracks, 'es');
    assert.equal(selectedEs.languageCode, 'es');
  });
});
