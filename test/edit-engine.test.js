import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditEngine } from '../src/shared/edit-engine.js';

describe('EditEngine & Undo Manager', () => {
  const initialNotes = [
    { id: 'n1', time: 10, text: 'Introduction to React', source: 'ai', edited: false },
    { id: 'n2', time: 30, text: 'Components return JSX', source: 'ai', edited: false },
    { id: 'n3', time: 60, text: 'State is local to component', source: 'ai', edited: false }
  ];

  it('applies an update changeset and generates inverse patch', () => {
    const engine = new EditEngine();
    const changeset = [
      { action: 'update', id: 'n2', text: 'Components return JSX (Virtual DOM)' }
    ];

    const { updatedNotes, affectedIds } = engine.applyChangeset(initialNotes, changeset, 35);
    assert.equal(affectedIds.length, 1);
    assert.equal(affectedIds[0], 'n2');

    const updatedNote = updatedNotes.find((n) => n.id === 'n2');
    assert.equal(updatedNote.text, 'Components return JSX (Virtual DOM)');
    assert.equal(updatedNote.source, 'user');
    assert.equal(updatedNote.edited, true);
  });

  it('applies an add changeset', () => {
    const engine = new EditEngine();
    const changeset = [
      { action: 'add', note: { id: 'u1', time: 45, text: 'Remember keys in lists!' } }
    ];

    const { updatedNotes } = engine.applyChangeset(initialNotes, changeset, 45);
    assert.equal(updatedNotes.length, 4);
    assert.ok(updatedNotes.some((n) => n.id === 'u1'));
  });

  it('reverses an edit with Undo without deleting newer AI notes', () => {
    const engine = new EditEngine();

    // 1. User edits n2
    const { updatedNotes: afterEdit } = engine.applyChangeset(
      initialNotes,
      [{ action: 'update', id: 'n2', text: 'Updated by user' }],
      35
    );

    // 2. Later, live AI generates note n4 at 90s
    const withNewAiNote = [
      ...afterEdit,
      { id: 'n4', time: 90, text: 'New AI insight generated after the edit', source: 'ai', edited: false }
    ];

    // 3. User clicks Undo
    assert.ok(engine.canUndo());
    const undoResult = engine.undo(withNewAiNote);
    assert.ok(undoResult);

    const { updatedNotes } = undoResult;

    // The edited note n2 was reverted to its original text
    const revertedN2 = updatedNotes.find((n) => n.id === 'n2');
    assert.equal(revertedN2.text, 'Components return JSX');
    assert.equal(revertedN2.source, 'ai');

    // The newer AI note n4 is STILL PRESENT! (Critical success criterion)
    const existingN4 = updatedNotes.find((n) => n.id === 'n4');
    assert.ok(existingN4, 'Newer AI note must survive user edit undo');
    assert.equal(existingN4.text, 'New AI insight generated after the edit');
  });

  it('reverses an added note with Undo', () => {
    const engine = new EditEngine();
    const { updatedNotes: afterAdd } = engine.applyChangeset(
      initialNotes,
      [{ action: 'add', note: { id: 'added_1', time: 50, text: 'Spoken note' } }],
      50
    );

    assert.equal(afterAdd.length, 4);

    const undoResult = engine.undo(afterAdd);
    assert.equal(undoResult.updatedNotes.length, 3);
    assert.equal(undoResult.updatedNotes.some((n) => n.id === 'added_1'), false);
  });
});
