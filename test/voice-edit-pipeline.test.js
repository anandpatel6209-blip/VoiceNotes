import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangesetResponse } from '../src/shared/validator.js';
import { EditEngine } from '../src/shared/edit-engine.js';

describe('Voice Edit Pipeline & Changeset Engine', () => {
  const existingNotes = [
    { id: 'n_abc1', time: 15, text: 'First point: Introduction to algorithms', source: 'ai', edited: false },
    { id: 'n_abc2', time: 45, text: 'Second point: Big O notation means worst case', source: 'ai', edited: false }
  ];

  it('parses fenced markdown changeset JSON', () => {
    const raw = '```json\n[{"action": "update", "id": "n_abc2", "text": "Big O notation measures asymptotic upper bound"}]\n```';
    const changeset = parseChangesetResponse(raw, 50, 'correct point 2', existingNotes);

    assert.equal(changeset.length, 1);
    assert.equal(changeset[0].action, 'update');
    assert.equal(changeset[0].id, 'n_abc2');
    assert.equal(changeset[0].text, 'Big O notation measures asymptotic upper bound');
  });

  it('parses changeset with conversational preamble and trailing commentary', () => {
    const raw = 'Certainly! Here is your updated changeset to modify the note:\n\n```json\n[{"action": "update", "id": "n_abc1", "text": "Algorithms are step-by-step procedures"}]\n```\nHope this helps!';
    const changeset = parseChangesetResponse(raw, 20, 'clarify algorithms', existingNotes);

    assert.equal(changeset.length, 1);
    assert.equal(changeset[0].action, 'update');
    assert.equal(changeset[0].id, 'n_abc1');
    assert.equal(changeset[0].text, 'Algorithms are step-by-step procedures');
  });

  it('handles flat note array by inferring actions', () => {
    const raw = '[{"id": "n_abc1", "text": "Inferred update"}, {"time": 60, "text": "Inferred add"}]';
    const changeset = parseChangesetResponse(raw, 60, '', existingNotes);

    assert.equal(changeset.length, 2);
    assert.equal(changeset[0].action, 'update');
    assert.equal(changeset[0].id, 'n_abc1');
    assert.equal(changeset[1].action, 'add');
    assert.equal(changeset[1].note.text, 'Inferred add');
  });

  it('resolves fuzzy numeric and ordinal note IDs in EditEngine', () => {
    const engine = new EditEngine();

    // LLM outputs "id": "2" or "note 2" targeting second note
    const changeset = [
      { action: 'update', id: '2', text: 'Second point: Updated via fuzzy ordinal index' }
    ];

    const { updatedNotes, affectedIds } = engine.applyChangeset(existingNotes, changeset, 45);
    assert.equal(affectedIds.length, 1);
    assert.equal(affectedIds[0], 'n_abc2');

    const updatedNote = updatedNotes.find((n) => n.id === 'n_abc2');
    assert.equal(updatedNote.text, 'Second point: Updated via fuzzy ordinal index');
    assert.equal(updatedNote.edited, true);
  });

  it('resolves fuzzy text substring in EditEngine', () => {
    const engine = new EditEngine();

    // LLM outputs ID referencing text
    const changeset = [
      { action: 'update', id: 'algorithms', text: 'First point: Introduction to data structures and algorithms' }
    ];

    const { updatedNotes, affectedIds } = engine.applyChangeset(existingNotes, changeset, 20);
    assert.equal(affectedIds.length, 1);
    assert.equal(affectedIds[0], 'n_abc1');

    const updatedNote = updatedNotes.find((n) => n.id === 'n_abc1');
    assert.equal(updatedNote.text, 'First point: Introduction to data structures and algorithms');
  });

  it('falls back safely to add note when response is completely unparseable', () => {
    const raw = 'I am not sure how to format this, sorry!';
    const changeset = parseChangesetResponse(raw, 33, 'Remember to review sorting', existingNotes);

    assert.equal(changeset.length, 1);
    assert.equal(changeset[0].action, 'add');
    assert.equal(changeset[0].note.text, 'Remember to review sorting');
    assert.equal(changeset[0].note.time, 33);
  });
});

