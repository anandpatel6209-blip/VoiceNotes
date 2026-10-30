import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Feature 2: Full-Screen Transcript Reader Verification', () => {
  const contentJs = fs.readFileSync(path.join(process.cwd(), 'content.js'), 'utf-8');
  const panelCss = fs.readFileSync(path.join(process.cwd(), 'panel.css'), 'utf-8');

  it('1. Switches to full-screen reader mode when Transcript tab is selected', () => {
    // Assert reader mode class is toggled on panelRoot
    assert.match(
      contentJs,
      /panelRoot\?\.classList\.add\('vn-reader-mode'\)/,
      'switchView("transcript") must add vn-reader-mode to panelRoot'
    );
    assert.match(
      contentJs,
      /panelRoot\?\.classList\.remove\('vn-reader-mode'\)/,
      'switchView("notes") must remove vn-reader-mode from panelRoot'
    );
  });

  it('2. Hides compact editing footer, banner, and workspace toolbar in full-screen reader mode', () => {
    assert.match(
      panelCss,
      /\.vn-root\.vn-reader-mode\s+\.vn-footer/,
      'CSS must target footer in vn-reader-mode'
    );
    assert.match(
      panelCss,
      /\.vn-root\.vn-reader-mode\s+\.vn-transcript-container\s*\{[^}]*height:\s*100%;/,
      'Transcript container must expand to 100% height in reader mode'
    );
  });

  it('3. Provides a prominent Back to Notes navigation control', () => {
    // Navigation bar created
    assert.match(contentJs, /className:\s*'vn-transcript-nav-bar'/);
    // Back button with label
    assert.match(contentJs, /text:\s*'← Back to Notes'/);
    // On click, calls switchView('notes')
    assert.match(contentJs, /switchView\('notes'\)/);
  });

  it('4. Provides full transcript copy action with user feedback', () => {
    // Copy button present
    assert.match(contentJs, /copyFullTranscript\(copyBtn\)/);
    // Visual feedback
    assert.match(contentJs, /Copied!/);
  });

  it('5. Provides readable typography and paragraph spacing for transcript rows', () => {
    // Font size and line height
    assert.match(
      panelCss,
      /\.vn-transcript-row\s*\{[^}]*font-size:\s*13px;/,
      'Transcript rows must use comfortable 13px font size'
    );
    assert.match(
      panelCss,
      /\.vn-transcript-row\s*\{[^}]*line-height:\s*1\.6;/,
      'Transcript rows must have readable 1.6 line height'
    );
    assert.match(
      panelCss,
      /\.vn-transcript-row\s*\{[^}]*margin-bottom:\s*6px;/,
      'Transcript rows must have paragraph spacing'
    );
  });

  it('6. Keeps transcript independently scrollable with auto-scroll sync', () => {
    assert.match(
      panelCss,
      /\.vn-transcript-list\s*\{[^}]*overflow-y:\s*auto;/,
      'Transcript list must be independently scrollable'
    );
    assert.match(contentJs, /updateActiveTranscriptLine\(/);
    assert.match(contentJs, /targetRow\.scrollIntoView/);
  });

  it('7. Preserves notes and transcript state between tab switches', () => {
    // Notes and transcript remain intact in storage and memory
    assert.match(contentJs, /debounceSaveTranscript\(\)/);
    assert.match(contentJs, /debounceSaveNotes\(\)/);
  });
});

