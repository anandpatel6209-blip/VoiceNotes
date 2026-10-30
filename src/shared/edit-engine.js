/**
 * VoiceNotes - Edit Engine & Patch-based Undo Manager
 * Handles applying structured AI edit changesets and reversing them
 * without deleting subsequent live AI notes.
 * Maintains persistent document state and version history.
 */

import { validateNote } from './validator.js';

export class EditEngine {
  constructor() {
    this.undoStack = []; // List of inverse patches: [{ timestamp, inversePatch }]
    this.editHistory = []; // List of full version snapshots & metadata
    this.maxUndoDepth = 25;
    this.maxHistoryDepth = 50;
  }

  /**
   * Apply a validated changeset to the notes list.
   * Returns: { updatedNotes: Array, affectedIds: Array<string>, inversePatch: Array }
   *
   * @param {Array} currentNotes Current active notes array
   * @param {Array} changeset Array of operations [{ action, id, note, text, time, order, targetSection }]
   * @param {number} userTimestamp Video timestamp when user spoke or edited
   * @param {Object} metadata Optional edit metadata: { command, summary, operation, targetSection }
   */
  applyChangeset(currentNotes, changeset, userTimestamp = 0, metadata = {}) {
    const operations = Array.isArray(changeset)
      ? changeset
      : (Array.isArray(changeset?.operations) ? changeset.operations : null);

    if (!Array.isArray(operations)) {
      throw new Error('Changeset must be an array of operations.');
    }

    const notesMap = new Map();
    currentNotes.forEach((n) => notesMap.set(n.id, { ...n }));

    // Helper to resolve an ID or fuzzy reference to an existing note
    const resolveExistingNote = (targetRef) => {
      if (targetRef === undefined || targetRef === null) return null;
      const refStr = String(targetRef).trim();

      // 1. Direct ID match
      if (notesMap.has(refStr)) {
        return notesMap.get(refStr);
      }

      // 2. 1-based index or "note 1", "#1"
      const match = refStr.match(/\b(?:note\s*|#)?(\d+)\b/i);
      if (match) {
        const idx = parseInt(match[1], 10) - 1;
        if (idx >= 0 && idx < currentNotes.length) {
          const candidateId = currentNotes[idx].id;
          if (notesMap.has(candidateId)) {
            return notesMap.get(candidateId);
          }
        }
      }

      // 3. Section Heading match (e.g. "Supervised Learning" matching "# Supervised Learning")
      const cleanRef = refStr.replace(/^[#\s*_-]+|[#\s*_-]+$/g, '').toLowerCase();
      if (cleanRef.length >= 3) {
        for (const note of notesMap.values()) {
          const cleanNote = note.text.replace(/^[#\s*_-]+|[#\s*_-]+$/g, '').toLowerCase();
          if (cleanNote.startsWith(cleanRef) || cleanNote.includes(cleanRef)) {
            return note;
          }
        }
      }

      // 4. Substring match on text
      if (refStr.length >= 3) {
        const lowerRef = refStr.toLowerCase();
        for (const note of notesMap.values()) {
          if (note.text.toLowerCase().includes(lowerRef) || lowerRef.includes(note.text.slice(0, 30).toLowerCase())) {
            return note;
          }
        }
      }

      return null;
    };

    const affectedIds = [];
    const inversePatch = [];

    for (const op of operations) {
      if (!op || typeof op !== 'object') continue;

      let action = typeof op.action === 'string' ? op.action.toLowerCase().trim() : '';
      if (['edit', 'modify', 'change', 'rewrite', 'simplify'].includes(action)) action = 'update';
      if (['remove', 'drop'].includes(action)) action = 'delete';
      if (['insert', 'create', 'new'].includes(action)) action = 'add';
      if (['reorder'].includes(action)) action = 'reorganize';

      // Infer action if missing
      if (!action) {
        if (op.id !== undefined && (op.text || op.content)) {
          action = 'update';
        } else if (op.text || op.content || op.note) {
          action = 'add';
        } else if (op.id !== undefined) {
          action = 'delete';
        } else {
          continue;
        }
      }

      if (action === 'add') {
        const rawNote = op.note || op;
        const valid = validateNote(
          {
            ...rawNote,
            time: typeof rawNote.time === 'number' ? rawNote.time : userTimestamp,
            source: 'user',
            edited: true
          },
          userTimestamp,
          'user'
        );

        if (valid) {
          notesMap.set(valid.id, valid);
          affectedIds.push(valid.id);
          inversePatch.push({
            action: 'delete',
            id: valid.id
          });
        }
      } else if (action === 'update') {
        let existing = resolveExistingNote(op.id || op.targetSection);
        if (!existing && metadata.selectedNoteId) {
          existing = resolveExistingNote(metadata.selectedNoteId);
        }
        if (!existing && currentNotes.length === 1) {
          existing = currentNotes[0];
        }

        if (existing) {
          const targetId = existing.id;
          const previousState = { ...existing };
          const newText = typeof op.text === 'string' && op.text.trim().length > 0
            ? op.text.trim()
            : existing.text;

          const newTime = typeof op.time === 'number' && Number.isFinite(op.time)
            ? Math.max(0, Math.floor(op.time))
            : existing.time;

          const updated = {
            ...existing,
            text: newText,
            time: newTime,
            source: 'user',
            edited: true
          };

          notesMap.set(targetId, updated);
          affectedIds.push(targetId);

          inversePatch.push({
            action: 'update',
            id: targetId,
            previousState
          });
        } else if (op.text && typeof op.text === 'string' && op.text.trim().length > 0) {
          // If note to update was not found, safely convert into an add operation so note is never lost
          const valid = validateNote(
            {
              time: typeof op.time === 'number' ? op.time : userTimestamp,
              text: op.text.trim(),
              source: 'user',
              edited: true
            },
            userTimestamp,
            'user'
          );
          if (valid) {
            notesMap.set(valid.id, valid);
            affectedIds.push(valid.id);
            inversePatch.push({ action: 'delete', id: valid.id });
          }
        }
      } else if (action === 'delete') {
        const existing = resolveExistingNote(op.id || op.targetSection);

        if (existing) {
          const targetId = existing.id;
          notesMap.delete(targetId);
          affectedIds.push(targetId);

          inversePatch.push({
            action: 'restore',
            note: existing
          });
        }
      } else if (action === 'reorganize') {
        if (Array.isArray(op.order) && op.order.length > 0) {
          const orderedNotes = [];
          const previousStates = [];

          for (const ref of op.order) {
            const n = resolveExistingNote(ref);
            if (n && !orderedNotes.some((x) => x.id === n.id)) {
              previousStates.push({ id: n.id, time: n.time });
              orderedNotes.push(n);
            }
          }

          if (orderedNotes.length > 1) {
            const times = orderedNotes.map((n) => n.time).sort((a, b) => a - b);
            orderedNotes.forEach((n, idx) => {
              const updatedTime = times[idx];
              if (n.time !== updatedTime) {
                n.time = updatedTime;
                notesMap.set(n.id, { ...n, edited: true });
                affectedIds.push(n.id);
              }
            });

            if (affectedIds.length > 0) {
              inversePatch.push({
                action: 'reorganize',
                previousStates
              });
            }
          }
        } else if (op.id !== undefined && typeof op.time === 'number') {
          const existing = resolveExistingNote(op.id);
          if (existing) {
            const previousState = { ...existing };
            const updated = { ...existing, time: Math.max(0, Math.floor(op.time)), edited: true };
            notesMap.set(existing.id, updated);
            affectedIds.push(existing.id);
            inversePatch.push({
              action: 'update',
              id: existing.id,
              previousState
            });
          }
        }
      }
    }

    const updatedNotes = Array.from(notesMap.values()).sort((a, b) => a.time - b.time);

    // Save to undo stack & version history if any modifications were made
    if (inversePatch.length > 0) {
      const historyEntry = {
        id: `hist_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        timestamp: Date.now(),
        userTimestamp,
        command: metadata.command || '',
        summary: metadata.summary || changeset.summary || 'Document modification',
        operation: metadata.operation || changeset.operation || 'update',
        targetSection: metadata.targetSection || changeset.targetSection || '',
        affectedIds: [...affectedIds],
        snapshot: updatedNotes.map((n) => ({ ...n })),
        inversePatch: [...inversePatch]
      };

      this.editHistory.push(historyEntry);
      if (this.editHistory.length > this.maxHistoryDepth) {
        this.editHistory.shift();
      }

      this.undoStack.push({
        timestamp: Date.now(),
        inversePatch
      });
      if (this.undoStack.length > this.maxUndoDepth) {
        this.undoStack.shift();
      }
    }

    return {
      updatedNotes,
      affectedIds,
      inversePatch
    };
  }

  /**
   * Check if undo is available
   */
  canUndo() {
    return this.undoStack.length > 0;
  }

  /**
   * Revert the most recent user edit using the inverse patch.
   * Does NOT disturb any notes created after the edit!
   * Returns: { updatedNotes: Array, affectedIds: Array<string> } or null if no undo available.
   */
  undo(currentNotes) {
    if (!this.canUndo()) return null;

    const entry = this.undoStack.pop();
    const notesMap = new Map();
    currentNotes.forEach((n) => notesMap.set(n.id, { ...n }));

    const affectedIds = [];

    for (const op of entry.inversePatch) {
      if (op.action === 'delete') {
        notesMap.delete(op.id);
        affectedIds.push(op.id);
      } else if (op.action === 'update') {
        if (op.previousState) {
          notesMap.set(op.id, { ...op.previousState });
          affectedIds.push(op.id);
        }
      } else if (op.action === 'restore') {
        if (op.note) {
          notesMap.set(op.note.id, { ...op.note });
          affectedIds.push(op.note.id);
        }
      } else if (op.action === 'reorganize' && Array.isArray(op.previousStates)) {
        for (const prev of op.previousStates) {
          const n = notesMap.get(prev.id);
          if (n) {
            notesMap.set(prev.id, { ...n, time: prev.time });
            affectedIds.push(prev.id);
          }
        }
      } else if (op.action === 'restore_snapshot' && Array.isArray(op.snapshot)) {
        return {
          updatedNotes: op.snapshot.map((n) => ({ ...n })),
          affectedIds: op.snapshot.map((n) => n.id)
        };
      }
    }

    const updatedNotes = Array.from(notesMap.values()).sort((a, b) => a.time - b.time);
    return {
      updatedNotes,
      affectedIds
    };
  }

  /**
   * Get immutable copy of edit history entries
   */
  getEditHistory() {
    return this.editHistory.map((h) => ({
      id: h.id,
      timestamp: h.timestamp,
      userTimestamp: h.userTimestamp,
      command: h.command,
      summary: h.summary,
      operation: h.operation,
      targetSection: h.targetSection,
      affectedIds: [...h.affectedIds],
      noteCount: Array.isArray(h.snapshot) ? h.snapshot.length : 0
    }));
  }

  /**
   * Restore document notes from a specific historical version.
   * Maintains persistent document state and pushes an undo record.
   *
   * @param {string|number} versionIdOrTimestamp
   * @param {Array} currentNotes
   * @returns {{ updatedNotes: Array, affectedIds: Array<string> } | null}
   */
  restoreVersion(versionIdOrTimestamp, currentNotes) {
    if (!Array.isArray(this.editHistory) || this.editHistory.length === 0) {
      return null;
    }

    const entry = this.editHistory.find(
      (h) => h.id === versionIdOrTimestamp || h.timestamp === Number(versionIdOrTimestamp)
    );

    if (!entry || !Array.isArray(entry.snapshot)) {
      return null;
    }

    // Save current document as undo inverse before restoring
    const previousSnapshot = currentNotes.map((n) => ({ ...n }));
    this.undoStack.push({
      timestamp: Date.now(),
      inversePatch: [
        {
          action: 'restore_snapshot',
          snapshot: previousSnapshot
        }
      ]
    });

    const restoredNotes = entry.snapshot.map((n) => ({ ...n }));
    const affectedIds = restoredNotes.map((n) => n.id);

    return {
      updatedNotes: restoredNotes,
      affectedIds
    };
  }

  clearHistory() {
    this.undoStack = [];
    this.editHistory = [];
  }
}
