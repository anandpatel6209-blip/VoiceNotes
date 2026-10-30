import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EditEngine } from '../src/shared/edit-engine.js';
import { parseStructuredEditResponse, parseChangesetResponse } from '../src/shared/validator.js';
import { MESSAGE_TYPES } from '../src/shared/types.js';

describe('Persistent AI-Powered Voice Note Editing', () => {
  let editEngine;

  beforeEach(() => {
    editEngine = new EditEngine();
  });

  // ---------------------------------------------------------------------------
  // 1. Structured AI Response Parsing & Clarification Handling
  // ---------------------------------------------------------------------------
  describe('Structured Response Parsing', () => {
    it('parses structured JSON with summary, operation, and targetSection', () => {
      const rawAiResponse = JSON.stringify({
        status: 'success',
        summary: 'Added concrete example of supervised learning',
        operation: 'add',
        targetSection: 'Supervised Learning',
        operations: [
          {
            action: 'add',
            note: {
              time: 145,
              text: '### Example: House Price Prediction\nUsing linear regression to predict prices based on square footage.'
            }
          }
        ]
      });

      const structured = parseStructuredEditResponse(rawAiResponse, 145, 'Add an example of supervised learning');

      assert.equal(structured.status, 'success');
      assert.equal(structured.summary, 'Added concrete example of supervised learning');
      assert.equal(structured.operation, 'add');
      assert.equal(structured.targetSection, 'Supervised Learning');
      assert.equal(structured.operations.length, 1);
      assert.equal(structured.operations[0].action, 'add');
      assert.match(structured.operations[0].note.text, /House Price Prediction/);
    });

    it('attaches structured metadata to parseChangesetResponse for backward compatibility', () => {
      const rawAiResponse = JSON.stringify({
        status: 'success',
        summary: 'Simplified unsupervised learning explanation',
        operation: 'update',
        targetSection: 'Unsupervised Learning',
        operations: [
          {
            action: 'update',
            id: 'n_unsup',
            text: 'Unsupervised learning finds hidden patterns in data without pre-existing labels.'
          }
        ]
      });

      const changeset = parseChangesetResponse(rawAiResponse, 200, 'explain unsupervised learning in simple language');

      assert.ok(Array.isArray(changeset), 'Changeset must be an array');
      assert.equal(changeset.length, 1);
      assert.equal(changeset.status, 'success');
      assert.equal(changeset.summary, 'Simplified unsupervised learning explanation');
      assert.equal(changeset.operation, 'update');
      assert.equal(changeset.targetSection, 'Unsupervised Learning');
    });

    it('handles ambiguous instructions with clarification_needed status', () => {
      const rawClarification = JSON.stringify({
        status: 'clarification_needed',
        summary: 'Ambiguous instruction',
        clarificationPrompt: 'Did you want to simplify supervised or unsupervised learning?',
        operations: []
      });

      const structured = parseStructuredEditResponse(rawClarification, 100, 'simplify this');

      assert.equal(structured.status, 'clarification_needed');
      assert.equal(structured.clarificationPrompt, 'Did you want to simplify supervised or unsupervised learning?');
      assert.equal(structured.operations.length, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Multi-Operation Document Editing Capabilities
  // ---------------------------------------------------------------------------
  describe('Document Editing Operations', () => {
    it('supports adding headings, subheadings, and examples', () => {
      const initialNotes = [
        { id: 'n_1', time: 60, text: 'Machine learning algorithms learn from data.', source: 'ai' }
      ];

      const changeset = [
        {
          action: 'add',
          note: {
            time: 90,
            text: '## Supervised Learning\nAlgorithms trained on labeled input-output pairs.'
          }
        },
        {
          action: 'add',
          note: {
            time: 110,
            text: '### Example: Spam Filter\nClassifying incoming emails as spam or inbox based on labeled history.'
          }
        }
      ];

      const result = editEngine.applyChangeset(initialNotes, changeset, 110, {
        summary: 'Added Supervised Learning heading and Spam Filter example',
        operation: 'add'
      });

      assert.equal(result.updatedNotes.length, 3);
      assert.match(result.updatedNotes[1].text, /^## Supervised Learning/);
      assert.match(result.updatedNotes[2].text, /^### Example: Spam Filter/);
      assert.equal(result.updatedNotes[1].edited, true);
    });

    it('supports rewriting existing paragraphs and correcting grammar/terminology', () => {
      const initialNotes = [
        { id: 'n_1', time: 40, text: 'Linear regresion tries to fit line on points.', source: 'ai' }
      ];

      const changeset = [
        {
          action: 'update',
          id: 'n_1',
          text: 'Linear regression models the relationship between dependent and independent variables by fitting a linear equation.'
        }
      ];

      const result = editEngine.applyChangeset(initialNotes, changeset, 45, {
        summary: 'Corrected spelling and rewritten linear regression explanation',
        operation: 'update'
      });

      assert.equal(result.updatedNotes.length, 1);
      assert.equal(
        result.updatedNotes[0].text,
        'Linear regression models the relationship between dependent and independent variables by fitting a linear equation.'
      );
      assert.equal(result.updatedNotes[0].edited, true);
    });

    it('supports removing specific content when explicitly requested', () => {
      const initialNotes = [
        { id: 'n_intro', time: 10, text: 'Introduction to AI and Course Syllabus', source: 'ai' },
        { id: 'n_sponsor', time: 35, text: 'Sponsored by TechGear: Use code NOTE20', source: 'ai' },
        { id: 'n_core', time: 60, text: 'Core concept: Neural network layers', source: 'ai' }
      ];

      const changeset = [
        {
          action: 'delete',
          id: 'n_sponsor'
        }
      ];

      const result = editEngine.applyChangeset(initialNotes, changeset, 35, {
        summary: 'Removed sponsor mention',
        operation: 'delete'
      });

      assert.equal(result.updatedNotes.length, 2);
      assert.ok(!result.updatedNotes.some((n) => n.id === 'n_sponsor'));
      assert.equal(result.updatedNotes[0].id, 'n_intro');
      assert.equal(result.updatedNotes[1].id, 'n_core');
    });

    it('supports reorganizing notes order', () => {
      const initialNotes = [
        { id: 'n_c', time: 30, text: 'Topic C: Reinforcement Learning', source: 'ai' },
        { id: 'n_a', time: 60, text: 'Topic A: Supervised Learning', source: 'ai' },
        { id: 'n_b', time: 90, text: 'Topic B: Unsupervised Learning', source: 'ai' }
      ];

      const changeset = [
        {
          action: 'reorganize',
          order: ['n_a', 'n_b', 'n_c']
        }
      ];

      const result = editEngine.applyChangeset(initialNotes, changeset, 95, {
        summary: 'Reorganized topics into logical A, B, C order',
        operation: 'reorganize'
      });

      assert.equal(result.updatedNotes[0].id, 'n_a');
      assert.equal(result.updatedNotes[1].id, 'n_b');
      assert.equal(result.updatedNotes[2].id, 'n_c');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. User Specification Requirement: Sequential Persistent Document Editing
  // ---------------------------------------------------------------------------
  describe('Preserve Previous Edits Across Sequential Commands', () => {
    it('preserves First Edit when Second Edit executes against the persistent document', () => {
      // Step 0: Initial document generated from video topics
      let activeDocument = [
        {
          id: 'doc_1',
          time: 60,
          text: '# Machine Learning Overview\nAlgorithms that learn patterns from data.',
          source: 'ai'
        },
        {
          id: 'doc_2',
          time: 120,
          text: '# Supervised Learning\nModels trained on labeled data.',
          source: 'ai'
        },
        {
          id: 'doc_3',
          time: 240,
          text: '# Unsupervised Learning\nHigh dimensional clustering and anomaly detection.',
          source: 'ai'
        }
      ];

      // First Command: "Add an example of supervised learning."
      const firstEditCommand = 'Add an example of supervised learning.';
      const firstChangeset = [
        {
          action: 'add',
          note: {
            time: 150,
            text: '### Example: House Price Prediction\nPredicting home values from square footage and bedrooms.'
          }
        }
      ];

      const firstResult = editEngine.applyChangeset(activeDocument, firstChangeset, 150, {
        command: firstEditCommand,
        summary: 'Added example of supervised learning',
        operation: 'add',
        targetSection: 'Supervised Learning'
      });

      // Update active document (persistent document state)
      activeDocument = firstResult.updatedNotes;

      assert.equal(activeDocument.length, 4);
      const houseExample = activeDocument.find((n) => n.text.includes('House Price Prediction'));
      assert.ok(houseExample, 'First edit note must exist in active document');

      // Second Command: "Explain unsupervised learning in simple language."
      const secondEditCommand = 'Explain unsupervised learning in simple language.';
      // AI reads the latest document (including doc_1, doc_2, doc_3, and houseExample)
      // and targets doc_3 to simplify without touching houseExample or other notes
      const secondChangeset = [
        {
          action: 'update',
          id: 'doc_3',
          text: '# Unsupervised Learning (Simplified)\nFinding hidden groupings or patterns in data without any answer keys or labels.'
        }
      ];

      const secondResult = editEngine.applyChangeset(activeDocument, secondChangeset, 250, {
        command: secondEditCommand,
        summary: 'Explained unsupervised learning in simple terms',
        operation: 'update',
        targetSection: 'Unsupervised Learning'
      });

      activeDocument = secondResult.updatedNotes;

      // Assertions on final persistent state
      assert.equal(activeDocument.length, 4, 'Document must retain all 4 notes');

      // 1. First edit MUST BE PRESERVED
      const preservedFirstEdit = activeDocument.find((n) => n.text.includes('House Price Prediction'));
      assert.ok(preservedFirstEdit, 'CRITICAL: First edit must be fully preserved after second edit');

      // 2. Second edit is applied
      const updatedSecondNote = activeDocument.find((n) => n.id === 'doc_3');
      assert.match(updatedSecondNote.text, /Simplified/);
      assert.match(updatedSecondNote.text, /without any answer keys/);

      // 3. Unrelated notes (doc_1, doc_2) remain intact
      const doc1 = activeDocument.find((n) => n.id === 'doc_1');
      assert.ok(doc1 && doc1.text.includes('Machine Learning Overview'));
      const doc2 = activeDocument.find((n) => n.id === 'doc_2');
      assert.ok(doc2 && doc2.text.includes('Models trained on labeled data'));
    });
  });

  // ---------------------------------------------------------------------------
  // 4. History Tracking, Version Snapshots & Undo
  // ---------------------------------------------------------------------------
  describe('Edit History and Version Restoration', () => {
    it('maintains history entries with timestamps, commands, and summaries', () => {
      const notes = [
        { id: '1', time: 10, text: 'Note 1', source: 'ai' }
      ];

      editEngine.applyChangeset(
        notes,
        [{ action: 'add', note: { time: 20, text: 'Note 2' } }],
        20,
        { command: 'Add note 2', summary: 'Added Note 2', operation: 'add' }
      );

      const history = editEngine.getEditHistory();
      assert.equal(history.length, 1);
      assert.equal(history[0].command, 'Add note 2');
      assert.equal(history[0].summary, 'Added Note 2');
      assert.equal(history[0].operation, 'add');
      assert.ok(Number.isFinite(history[0].timestamp));
    });

    it('allows undoing the most recent modification via inverse patch', () => {
      const initialNotes = [
        { id: 'n_a', time: 10, text: 'Alpha concept', source: 'ai' }
      ];

      const applyRes = editEngine.applyChangeset(
        initialNotes,
        [{ action: 'update', id: 'n_a', text: 'Alpha concept (modified)' }],
        15
      );

      assert.equal(applyRes.updatedNotes[0].text, 'Alpha concept (modified)');
      assert.ok(editEngine.canUndo());

      // Undo reverts only the modified note
      const undoRes = editEngine.undo(applyRes.updatedNotes);
      assert.ok(undoRes);
      assert.equal(undoRes.updatedNotes[0].text, 'Alpha concept');
    });

    it('allows restoring an earlier version from version snapshot', () => {
      const v0 = [
        { id: 'n_1', time: 10, text: 'Version 0 Note', source: 'ai' }
      ];

      // Step 1: Make Edit 1
      const res1 = editEngine.applyChangeset(
        v0,
        [{ action: 'add', note: { time: 20, text: 'Version 1 Note' } }],
        20,
        { summary: 'Edit 1' }
      );

      // Step 2: Make Edit 2
      const res2 = editEngine.applyChangeset(
        res1.updatedNotes,
        [{ action: 'add', note: { time: 30, text: 'Version 2 Note' } }],
        30,
        { summary: 'Edit 2' }
      );

      assert.equal(res2.updatedNotes.length, 3);

      const history = editEngine.getEditHistory();
      assert.equal(history.length, 2);

      // Restore to Version 1 (history[0])
      const restoreRes = editEngine.restoreVersion(history[0].id, res2.updatedNotes);
      assert.ok(restoreRes);
      assert.equal(restoreRes.updatedNotes.length, 2);
      assert.equal(restoreRes.updatedNotes[1].text, 'Version 1 Note');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Section Heading Fuzzy Resolution
  // ---------------------------------------------------------------------------
  describe('Fuzzy Section Resolution', () => {
    it('resolves notes by matching heading names in targetSection', () => {
      const currentNotes = [
        { id: 'sec_1', time: 50, text: '# Neural Networks Basics\nDeep learning architecture.', source: 'ai' },
        { id: 'sec_2', time: 120, text: '# Convolutional Layers\nFor image analysis.', source: 'ai' }
      ];

      const changeset = [
        {
          action: 'update',
          targetSection: 'Convolutional Layers',
          text: '# Convolutional Layers\nOptimized feature extractors for 2D spatial grid data.'
        }
      ];

      const result = editEngine.applyChangeset(currentNotes, changeset, 130);
      assert.equal(result.updatedNotes[1].id, 'sec_2');
      assert.match(result.updatedNotes[1].text, /feature extractors for 2D spatial grid data/);
    });
  });
});

