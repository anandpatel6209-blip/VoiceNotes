import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('VoiceNotes UI Redesign & Feature Improvements Verification', () => {
  const contentJs = fs.readFileSync(path.join(process.cwd(), 'content.js'), 'utf-8');
  const panelCss = fs.readFileSync(path.join(process.cwd(), 'panel.css'), 'utf-8');

  it('1. Live Video Stream panel is completely removed from visible interface', () => {
    // Assert liveStreamCardEl is not appended in panelRoot
    assert.doesNotMatch(
      contentJs,
      /panelRoot\.appendChild\(liveStreamCardEl\)/,
      'liveStreamCardEl must not be appended to panelRoot'
    );
    // Assert CSS completely hides or removes .vn-live-stream-card
    assert.match(
      panelCss,
      /\.vn-live-stream-card\s*\{\s*display:\s*none\s*!important;\s*\}/,
      '.vn-live-stream-card must be display: none !important in panel.css'
    );
  });

  it('2. Speaker Audio monitoring control & Speaker Audio Active status are removed from UI', () => {
    // Assert liveAudioBtn is not appended to headerActions
    assert.doesNotMatch(
      contentJs,
      /headerActions\.appendChild\(liveAudioBtn\)/,
      'headerActions must not contain liveAudioBtn'
    );
    // Assert empty state does not contain the old speaker audio toggle
    assert.doesNotMatch(
      contentJs,
      /'⏹️ Stop Notes & Audio' : '▶ Start Notes & Audio'/,
      'Notes empty state must not contain audio start/stop toggle'
    );
    // Assert transcript empty state does not ask user to click 🔊
    assert.doesNotMatch(
      contentJs,
      /click 🔊 to enable live speaker audio/,
      'Transcript empty state must not prompt user to click 🔊'
    );
    // Assert "Speaker Audio Active" is not shown anywhere in UI
    assert.doesNotMatch(
      contentJs,
      /'Speaker Audio Active'/,
      'UI status must never show "Speaker Audio Active"'
    );
  });

  it('3. Header redesign contains logo, unobtrusive status pill, and essential actions', () => {
    // Brand title
    assert.match(contentJs, /el\('span',\s*\{\s*className:\s*'vn-title',\s*text:\s*'VoiceNotes'\s*\}\)/);
    // Status pill
    assert.match(contentJs, /headerStatusPillEl = el\('span',\s*\{\s*className:\s*'vn-status-pill/);
    assert.match(contentJs, /headerStatusDotEl = el\('span',\s*\{\s*className:\s*'vn-status-dot'\s*\}\)/);
    assert.match(contentJs, /headerStatusTextEl = el\('span',\s*\{\s*className:\s*'vn-status-text'/);
    // Essential actions: Copy, Download, Settings, Collapse
    assert.match(contentJs, /headerActions\.appendChild\(copyMdBtn\)/);
    assert.match(contentJs, /headerActions\.appendChild\(downloadBtn\)/);
    assert.match(contentJs, /headerActions\.appendChild\(menuBtn\)/);
    assert.match(contentJs, /headerActions\.appendChild\(collapseBtn\)/);
  });

  it('4. Main Workspace deletes transcript selection from screen and displays only notes (no manual Generate Notes button)', () => {
    // Tabs hidden / deleted from visible interface in CSS
    assert.match(panelCss, /\.vn-view-tabs\s*\{[^}]*display:\s*none\s*!important;/);
    // Workspace toolbar appended right below header
    assert.match(contentJs, /panelRoot\.appendChild\(workspaceToolbar\)/);
    // Search input inside toolbar
    assert.match(contentJs, /searchWrapper\.appendChild\(searchInputEl\)/);
    // Generate Notes button NOT inside workspaceToolbar (removed for full automation)
    assert.doesNotMatch(contentJs, /workspaceToolbar\.appendChild\(generateNotesBtnEl\)/);
  });

  it('5. Automatic Note Generation is fully implemented and speed-optimized', () => {
    // Automatic note generation function exists
    assert.match(contentJs, /function autoGenerateNotes\(/);
    // Trigger chunk generation is used
    assert.match(contentJs, /triggerChunkGeneration\(chunkStart,\s*chunkEnd,\s*chunkText/);
    // Chunk interval is reduced to 15s for high-speed note making
    assert.match(contentJs, /chunkIntervalSec\s*=\s*15/);
    // Auto-generates on video play / time tracking initialization
    assert.match(contentJs, /autoGenerateNotes\(\)/);
  });

  it('6. Notes tab empty state provides clean auto-generation guidance without manual generate button', () => {
    assert.doesNotMatch(contentJs, /text:\s*'✨ Generate Notes Now'/);
    assert.match(contentJs, /text:\s*'✎ Alt\+V Write Note'/);
  });

  it('7. Transcript view toolbar does not contain manual generate button', () => {
    assert.doesNotMatch(contentJs, /text:\s*'✨ Generate Notes'/);
  });

  it('8. Bottom controls are pinned with flex-shrink: 0 and do not overlap content', () => {
    assert.match(panelCss, /\.vn-footer\s*\{[^}]*flex-shrink:\s*0;/);
    assert.match(panelCss, /\.vn-notes-container\s*\{[^}]*flex:\s*1 1 0;/);
    assert.match(panelCss, /\.vn-notes-container\s*\{[^}]*min-height:\s*0;/);
    assert.match(panelCss, /\.vn-transcript-container\s*\{[^}]*flex:\s*1 1 0;/);
    assert.match(panelCss, /\.vn-transcript-container\s*\{[^}]*min-height:\s*0;/);
  });

  it('9. Dark-first productivity design tokens and status indicators are defined in CSS', () => {
    assert.match(panelCss, /--vn-bg:\s*#121110;/);
    assert.match(panelCss, /--vn-card-bg:\s*#1a1917;/);
    assert.match(panelCss, /--vn-text:\s*#f5f5f4;/);
    assert.match(panelCss, /--vn-accent:\s*#c2410c;/);
    assert.match(panelCss, /\.vn-status-pill/);
    assert.match(panelCss, /\.vn-status-live/);
    assert.match(panelCss, /\.vn-status-paused/);
    assert.match(panelCss, /\.vn-status-idle/);
    assert.match(panelCss, /\.vn-status-generating/);
  });

  it('10. Local video player is deleted and no generate AI logo appears beside the search bar', () => {
    // Assert player.html and player.js do not exist on disk
    assert.equal(fs.existsSync(path.join(process.cwd(), 'player.html')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'player.js')), false);

    // Assert options.html does not contain link to player.html
    const optionsHtml = fs.readFileSync(path.join(process.cwd(), 'options.html'), 'utf-8');
    assert.doesNotMatch(optionsHtml, /player\.html/);

    // Assert .vn-btn-generate is hidden in panelCss
    assert.match(panelCss, /\.vn-btn-generate[^}]*display:\s*none\s*!important/);

    // Assert workspace toolbar only has searchWrapper and no AI logo or generate button
    assert.doesNotMatch(contentJs, /workspaceToolbar\.appendChild\([^s]/);
  });
});

