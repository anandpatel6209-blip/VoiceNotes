import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_TYPES, DEFAULT_SETTINGS, PROVIDERS } from '../src/shared/types.js';
import { formatNotesToMarkdown, generateExportFilename } from '../src/shared/exporter.js';
import { EditEngine } from '../src/shared/edit-engine.js';
import { parseNotesResponse, parseChangesetResponse } from '../src/shared/validator.js';

describe('Integration: Message Contracts & Note Lifecycle', () => {
  it('handles note creation, storage simulation, edit changeset, undo and export', () => {
    // 1. Storage simulation
    const mockStorage = new Map();
    const videoId = 'test_video_123';
    const storageKey = `notes:${videoId}`;

    // 2. Simulate AI Live Note Generation output
    const rawAiOutput = JSON.stringify([
      { time: 15, text: 'Introduction to React components' },
      { time: 30, text: 'Props are read-only' }
    ]);
    const generatedNotes = parseNotesResponse(rawAiOutput, 15);
    assert.equal(generatedNotes.length, 2);

    // Save to storage
    mockStorage.set(storageKey, generatedNotes);
    assert.equal(mockStorage.get(storageKey).length, 2);

    // 3. User Voice Edit Flow via EditEngine
    const editEngine = new EditEngine();
    const changeset = [
      { action: 'update', id: generatedNotes[1].id, text: 'Props are read-only and immutable' },
      { action: 'add', note: { time: 45, text: 'State is managed locally', source: 'user', edited: true } }
    ];

    const currentNotes = mockStorage.get(storageKey);
    const { updatedNotes, affectedIds } = editEngine.applyChangeset(currentNotes, changeset, 45);

    assert.equal(updatedNotes.length, 3);
    assert.equal(affectedIds.length, 2);
    mockStorage.set(storageKey, updatedNotes);

    // 4. Verify Undo reverses edit without deleting newer notes
    const withSubsequentLiveNote = [
      ...updatedNotes,
      { id: 'subsequent_ai_1', time: 75, text: 'Subsequent live takeaway', source: 'ai', edited: false }
    ];

    const undoResult = editEngine.undo(withSubsequentLiveNote);
    assert.ok(undoResult);
    assert.equal(undoResult.updatedNotes.length, 3); // The added note was deleted, but subsequent_ai_1 survived!
    assert.ok(undoResult.updatedNotes.some((n) => n.id === 'subsequent_ai_1'));

    // 5. Export to Markdown
    const markdown = formatNotesToMarkdown({
      title: 'React Fundamentals',
      videoId,
      notes: undoResult.updatedNotes
    });

    assert.ok(markdown.includes('# React Fundamentals'));
    assert.ok(markdown.includes('https://www.youtube.com/watch?v=test_video_123&t=15s'));
    assert.ok(markdown.includes('Subsequent live takeaway'));

    const filename = generateExportFilename('React Fundamentals');
    assert.ok(filename.startsWith('VoiceNotes_React_Fundamentals_'));
    assert.ok(filename.endsWith('.md'));
  });

  it('handles line-by-line transcript persistence and safe merging', () => {
    assert.equal(MESSAGE_TYPES.LOAD_TRANSCRIPT, 'LOAD_TRANSCRIPT');
    assert.equal(MESSAGE_TYPES.SAVE_TRANSCRIPT, 'SAVE_TRANSCRIPT');

    const mockStorage = new Map();
    const videoId = 'vid_python_101';
    const transcriptKey = `transcript:${videoId}`;

    // 1. Initial captured lines from captions
    const initialCaptions = [
      { start: 0, end: 3, text: 'Welcome to Python tutorial', source: 'CC' },
      { start: 5, end: 8, text: 'Python is dynamic and readable', source: 'CC' }
    ];

    // Save to storage
    mockStorage.set(transcriptKey, initialCaptions);
    assert.equal(mockStorage.get(transcriptKey).length, 2);

    // 2. Additional live speaker audio line transcribed safely without overwriting
    const saved = [...mockStorage.get(transcriptKey)];
    const liveAudioLine = { start: 10, end: 13, text: 'Functions are defined using def', source: 'Audio' };

    // Deduplication check
    if (!saved.some((t) => t.start === liveAudioLine.start && t.text === liveAudioLine.text)) {
      saved.push(liveAudioLine);
    }
    saved.sort((a, b) => a.start - b.start);

    mockStorage.set(transcriptKey, saved);
    const restored = mockStorage.get(transcriptKey);
    assert.equal(restored.length, 3);
    assert.equal(restored[2].source, 'Audio');
    assert.equal(restored[2].text, 'Functions are defined using def');
  });

  it('handles end-to-end voice edit parsing with conversational text and fuzzy target ID', () => {
    const editEngine = new EditEngine();
    const existingNotes = [
      { id: 'n_1001', time: 10, text: 'First point: Introduction', source: 'ai', edited: false },
      { id: 'n_1002', time: 30, text: 'Second point: Core architecture', source: 'ai', edited: false }
    ];

    // LLM outputs conversational preamble and refers to note 2 by ordinal "2"
    const rawLLMResponse = `Here is the changeset for your edit:
\`\`\`json
[
  { "action": "update", "id": "2", "text": "Second point: Core architecture and event-driven data flow" }
]
\`\`\`
Let me know if you need anything else!`;

    const changeset = parseChangesetResponse(rawLLMResponse, 32, 'expand point 2', existingNotes);
    assert.equal(changeset.length, 1);
    assert.equal(changeset[0].action, 'update');

    const { updatedNotes, affectedIds, inversePatch } = editEngine.applyChangeset(existingNotes, changeset, 32);
    assert.equal(affectedIds.length, 1);
    assert.equal(affectedIds[0], 'n_1002');
    assert.equal(updatedNotes.find((n) => n.id === 'n_1002').text, 'Second point: Core architecture and event-driven data flow');

    // Inverse patch is valid and can undo
    assert.equal(inversePatch.length, 1);
    assert.equal(inversePatch[0].action, 'update');
    assert.equal(inversePatch[0].id, 'n_1002');

    const undone = editEngine.undo(updatedNotes);
    assert.equal(undone.updatedNotes.find((n) => n.id === 'n_1002').text, 'Second point: Core architecture');
  });
});
