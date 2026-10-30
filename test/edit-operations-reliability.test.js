import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EditEngine } from '../src/shared/edit-engine.js';
import { parseChangesetResponse, parseStructuredEditResponse } from '../src/shared/validator.js';

describe('Edit Operations Reliability & Precision', () => {
  const contentJs = readFileSync(resolve(process.cwd(), 'content.js'), 'utf-8');
  const panelCss = readFileSync(resolve(process.cwd(), 'panel.css'), 'utf-8');

  it('1. Inline editing triggers on both double-click and edit button', () => {
    assert.match(
      contentJs,
      /entry\.addEventListener\('dblclick',\s*\(e\)\s*=>\s*\{[\s\S]*?startInlineEdit\(note\.id,\s*entry\);/s,
      'Double click on note card must start inline edit'
    );
    assert.match(
      contentJs,
      /editBtn\.addEventListener\('click',\s*\(e\)\s*=>\s*\{[\s\S]*?startInlineEdit\(note\.id,\s*entry\);/s,
      'Edit button (✎) must trigger startInlineEdit'
    );
  });

  it('2. Inline edit supports keyboard shortcuts Ctrl+Enter to save and Escape to cancel', () => {
    assert.match(
      contentJs,
      /editArea\.addEventListener\('keydown',\s*\(e\)\s*=>\s*\{[\s\S]*?saveBtn\.click\(\);[\s\S]*?cancelBtn\.click\(\);/s,
      'Inline edit must support Enter/Ctrl+Enter to save and Escape to cancel'
    );
    assert.match(
      panelCss,
      /\.vn-notepad-entry\.vn-editing-mode/,
      'CSS must highlight .vn-editing-mode'
    );
  });

  it('3. Direct text modification of a selected note saves directly without waiting on AI', () => {
    assert.match(
      contentJs,
      /const\s+isConversationalCommand\s*=\s*\/\^\(add\\b\|insert\\b/i,
      'content.js must differentiate conversational commands from direct text'
    );
    assert.match(
      contentJs,
      /if\s*\(selectedNoteId\s*&&\s*!isConversationalCommand\)\s*\{[\s\S]*?applyDirectFallback\(\);[\s\S]*?return;\s*\}/s,
      'Direct text edits on selected note must save immediately via applyDirectFallback'
    );
  });

  it('4. If AI asks for clarification on an active selected note, fallback directly saves the update', () => {
    assert.match(
      contentJs,
      /if\s*\(response\.status\s*===\s*'clarification_needed'\)\s*\{[\s\S]*?if\s*\(currentSelectedId\)\s*\{[\s\S]*?applyDirectFallback\(\);[\s\S]*?return;\s*\}/s,
      'Clarification on selected note must fall back to direct update so note is never lost'
    );
  });

  it('5. Changeset parser handles variations in keys: changes, replacement, newText, updatedText, operation', () => {
    const existing = [
      { id: 'n_1', time: 60, text: 'Original note text', source: 'ai' }
    ];

    // Format A: changes array with operation & replacement
    const rawA = JSON.stringify({
      summary: 'Updated note 1',
      operation: 'update',
      changes: [
        { operation: 'update', id: 'n_1', replacement: 'Polished note text' }
      ]
    });
    const parsedA = parseChangesetResponse(rawA, 60, 'polish note', existing);
    assert.equal(parsedA.status, 'success');
    assert.equal(parsedA.operations.length, 1);
    assert.equal(parsedA.operations[0].action, 'update');
    assert.equal(parsedA.operations[0].text, 'Polished note text');

    // Format B: operations array with newText
    const rawB = JSON.stringify({
      summary: 'Shortened note',
      operations: [
        { action: 'update', targetId: 'n_1', newText: 'Short note' }
      ]
    });
    const parsedB = parseChangesetResponse(rawB, 60, 'shorten', existing);
    assert.equal(parsedB.status, 'success');
    assert.equal(parsedB.operations[0].text, 'Short note');

    // Apply with EditEngine
    const engine = new EditEngine();
    const result = engine.applyChangeset(existing, parsedB, 60, { selectedNoteId: 'n_1' });
    assert.equal(result.updatedNotes[0].text, 'Short note');
    assert.equal(result.updatedNotes[0].edited, true);
    assert.equal(result.updatedNotes[0].source, 'user');
  });

  it('6. Selected note resolution in EditEngine falls back to metadata.selectedNoteId if LLM omits target ID', () => {
    const existing = [
      { id: 'n_42', time: 120, text: 'First note', source: 'ai' },
      { id: 'n_99', time: 240, text: 'Second note', source: 'ai' }
    ];
    const changeset = {
      status: 'success',
      operations: [
        { action: 'update', text: 'Targeted update without id in op' }
      ]
    };
    const engine = new EditEngine();
    const result = engine.applyChangeset(existing, changeset, 120, { selectedNoteId: 'n_99' });
    const target = result.updatedNotes.find((n) => n.id === 'n_99');
    assert.equal(target.text, 'Targeted update without id in op');
    assert.equal(target.edited, true);
    // n_42 should remain untouched
    const untouched = result.updatedNotes.find((n) => n.id === 'n_42');
    assert.equal(untouched.text, 'First note');
  });
});
