/**
 * VoiceNotes - Validator and Sanitization Utilities
 */

/**
 * Format total seconds into mm:ss or hh:mm:ss
 */
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Parse time string (mm:ss or hh:mm:ss or seconds) to seconds integer
 */
export function parseTime(timeStr) {
  if (typeof timeStr === 'number') {
    return Math.max(0, Math.floor(timeStr));
  }
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (parts.length === 2) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  if (parts.length === 1) {
    return Math.max(0, Math.floor(parts[0]));
  }
  return 0;
}

/**
 * Unescape common HTML entities found in transcripts
 */
export function unescapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

/**
 * Validate and normalize a single note item
 */
export function validateNote(item, defaultTime = 0, defaultSource = 'ai') {
  if (!item || typeof item !== 'object') return null;

  let time = defaultTime;
  if (typeof item.time === 'number' && Number.isFinite(item.time)) {
    time = Math.max(0, Math.floor(item.time));
  } else if (typeof item.time === 'string') {
    time = parseTime(item.time);
  }

  let text = '';
  if (typeof item.text === 'string') {
    text = unescapeHtml(item.text).trim().slice(0, 5000);
  } else if (typeof item.content === 'string') {
    text = unescapeHtml(item.content).trim().slice(0, 5000);
  }

  if (!text) return null;

  const source = item.source === 'user' ? 'user' : defaultSource;
  const edited = Boolean(item.edited);
  const createdAt = typeof item.createdAt === 'number' && item.createdAt > 0
    ? item.createdAt
    : Date.now();

  const id = typeof item.id === 'string' && item.id.trim().length > 0
    ? item.id.trim()
    : `n_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  return {
    id,
    time,
    text,
    source,
    edited,
    createdAt
  };
}

/**
 * Safely parse AI response containing JSON notes
 */
export function parseNotesResponse(rawText, defaultTime = 0) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('Empty response received from AI model.');
  }

  let cleaned = rawText.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }

  // Find first [ or { in case there is leading conversational text
  const firstBracket = cleaned.indexOf('[');
  const firstBrace = cleaned.indexOf('{');

  let jsonStr = cleaned;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    const lastBracket = cleaned.lastIndexOf(']');
    if (lastBracket > firstBracket) {
      jsonStr = cleaned.substring(firstBracket, lastBracket + 1);
    }
  } else if (firstBrace !== -1) {
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse AI response as JSON: ${err.message}. Raw: "${rawText.slice(0, 120)}..."`);
  }

  const items = Array.isArray(parsed) ? parsed : (parsed.notes || [parsed]);
  if (!Array.isArray(items)) {
    throw new Error('Model output could not be converted to a notes array.');
  }

  const validNotes = [];
  for (const item of items) {
    const valid = validateNote(item, defaultTime, 'ai');
    if (valid) {
      validNotes.push(valid);
    }
  }

  return validNotes;
}

/**
 * Safely parse AI response for voice edit changeset operations and structured metadata.
 * Handles conversational preambles, markdown code fences, flat note arrays,
 * clarification prompts, and returns a rich structured result.
 *
 * @returns {{
 *   status: 'success' | 'clarification_needed' | 'fallback',
 *   summary: string,
 *   operation: string,
 *   targetSection: string,
 *   clarificationPrompt: string,
 *   operations: Array<Object>
 * }}
 */
export function parseStructuredEditResponse(rawText, userTime = 0, cleanInstruction = '', existingNotes = []) {
  const fallback = {
    status: 'fallback',
    summary: 'Direct user note',
    operation: 'add',
    targetSection: '',
    clarificationPrompt: '',
    operations: [
      {
        action: 'add',
        note: {
          time: userTime,
          text: cleanInstruction || (typeof rawText === 'string' ? rawText.trim().slice(0, 500) : 'User Note'),
          source: 'user',
          edited: true
        }
      }
    ]
  };

  if (!rawText || typeof rawText !== 'string') {
    return fallback;
  }

  let cleaned = rawText.trim();

  // Strip code fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }

  // Extract JSON slice between brackets or braces if conversational text exists
  const firstBracket = cleaned.indexOf('[');
  const firstBrace = cleaned.indexOf('{');

  let jsonStr = cleaned;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    const lastBracket = cleaned.lastIndexOf(']');
    if (lastBracket > firstBracket) {
      jsonStr = cleaned.substring(firstBracket, lastBracket + 1);
    }
  } else if (firstBrace !== -1) {
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > firstBrace) {
      jsonStr = cleaned.substring(firstBrace, lastBrace + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    // If JSON parsing fails, return fallback
    return fallback;
  }

  // Handle clarification_needed status from AI
  if (parsed && typeof parsed === 'object' && (parsed.status === 'clarification_needed' || parsed.clarificationPrompt)) {
    return {
      status: 'clarification_needed',
      summary: parsed.summary || 'Clarification needed',
      operation: 'clarification',
      targetSection: parsed.targetSection || '',
      clarificationPrompt: parsed.clarificationPrompt || parsed.message || 'Please specify which section you want to modify.',
      operations: []
    };
  }

  const rawOps = Array.isArray(parsed)
    ? parsed
    : (parsed.operations || parsed.changes || parsed.changeset || parsed.notes || [parsed]);

  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    return fallback;
  }

  const normalizedOperations = [];
  const operationsFound = new Set();

  for (const op of rawOps) {
    if (!op || typeof op !== 'object') continue;

    let rawAction = typeof op.action === 'string' ? op.action.toLowerCase().trim() : '';

    // Action aliases
    if (['add', 'insert', 'create', 'new'].includes(rawAction)) {
      rawAction = 'add';
    } else if (['update', 'edit', 'modify', 'change', 'rewrite', 'simplify'].includes(rawAction)) {
      rawAction = 'update';
    } else if (['delete', 'remove', 'drop'].includes(rawAction)) {
      rawAction = 'delete';
    } else if (['reorganize', 'reorder'].includes(rawAction)) {
      rawAction = 'reorganize';
    }

    // If action is missing, infer from structure
    if (!rawAction) {
      if (op.id !== undefined && (op.text || op.content)) {
        rawAction = 'update';
      } else if (op.text || op.content || op.note) {
        rawAction = 'add';
      } else if (op.id !== undefined) {
        rawAction = 'delete';
      } else {
        continue;
      }
    }

    operationsFound.add(rawAction);

    if (rawAction === 'add') {
      const rawNote = op.note && typeof op.note === 'object' ? op.note : op;
      const text = (rawNote.text || rawNote.content || '').trim();
      if (!text) continue;

      let time = userTime;
      if (typeof rawNote.time === 'number' && Number.isFinite(rawNote.time)) {
        time = Math.max(0, Math.floor(rawNote.time));
      } else if (typeof rawNote.time === 'string') {
        time = parseTime(rawNote.time);
      }

      normalizedOperations.push({
        action: 'add',
        targetSection: op.targetSection || rawNote.targetSection || '',
        note: {
          id: rawNote.id || `n_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          time,
          text: unescapeHtml(text),
          source: 'user',
          edited: true
        }
      });
    } else if (rawAction === 'update') {
      const targetId = op.id !== undefined ? String(op.id).trim() : '';
      const text = (op.text || op.content || op.note?.text || '').trim();

      normalizedOperations.push({
        action: 'update',
        id: targetId,
        targetSection: op.targetSection || '',
        text: unescapeHtml(text),
        time: typeof op.time === 'number' ? Math.max(0, Math.floor(op.time)) : undefined
      });
    } else if (rawAction === 'delete') {
      const targetId = op.id !== undefined ? String(op.id).trim() : '';
      if (targetId) {
        normalizedOperations.push({
          action: 'delete',
          id: targetId,
          targetSection: op.targetSection || ''
        });
      }
    } else if (rawAction === 'reorganize') {
      normalizedOperations.push({
        action: 'reorganize',
        id: op.id !== undefined ? String(op.id).trim() : undefined,
        time: typeof op.time === 'number' ? Math.max(0, Math.floor(op.time)) : undefined,
        order: Array.isArray(op.order) ? op.order : undefined
      });
    }
  }

  if (normalizedOperations.length === 0) {
    return fallback;
  }

  // Derive top-level summary, operation type, targetSection
  let inferredOperation = 'update';
  if (operationsFound.size === 1) {
    inferredOperation = operationsFound.values().next().value;
  } else if (operationsFound.size > 1) {
    inferredOperation = 'multiple';
  }

  const topSummary = (!Array.isArray(parsed) && parsed.summary)
    ? parsed.summary
    : (inferredOperation === 'add' ? 'Added new information' :
       inferredOperation === 'update' ? 'Updated note content' :
       inferredOperation === 'delete' ? 'Removed note content' :
       inferredOperation === 'reorganize' ? 'Reorganized notes' : 'Modified notes');

  const topTargetSection = (!Array.isArray(parsed) && parsed.targetSection)
    ? parsed.targetSection
    : (normalizedOperations[0]?.targetSection || '');

  return {
    status: 'success',
    summary: topSummary,
    operation: inferredOperation,
    targetSection: topTargetSection,
    clarificationPrompt: '',
    operations: normalizedOperations
  };
}

/**
 * Safely parse AI response for voice edit changeset operations.
 * Handles conversational preambles, markdown code fences, flat note arrays,
 * and attaches structured metadata (.status, .summary, .operation, .targetSection).
 */
export function parseChangesetResponse(rawText, userTime = 0, cleanInstruction = '', existingNotes = []) {
  const structured = parseStructuredEditResponse(rawText, userTime, cleanInstruction, existingNotes);
  const ops = structured.operations;
  ops.status = structured.status;
  ops.summary = structured.summary;
  ops.operation = structured.operation;
  ops.targetSection = structured.targetSection;
  ops.clarificationPrompt = structured.clarificationPrompt;
  return ops;
}

/**
 * Sanitize filename for export
 */
export function sanitizeFilename(name, fallback = 'VoiceNotes_Export') {
  if (!name || typeof name !== 'string') return fallback;
  const sanitized = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 100);
  return sanitized || fallback;
}

/**
 * Filter out audio noise tags (music, applause, cheering, silence, sound effects)
 */
export function cleanTranscriptNoise(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/\[(?:music|applause|laughter|cheering|audio|silence|bell|chime|sound)\]/gi, ' ')
    .replace(/\((?:music|applause|laughter|cheering|audio|silence|bell|chime|sound)\)/gi, ' ')
    .replace(/[♪♫#*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a transcript chunk contains meaningful educational speech
 * rather than pure music, applause, silence, or sponsorship plugs.
 */
export function isMeaningfulEducationalTranscript(text) {
  const cleaned = cleanTranscriptNoise(text);
  if (cleaned.length < 15) return false;

  // Verify there are at least 10 alphanumeric characters
  const alphaCount = (cleaned.match(/[a-zA-Z0-9]/g) || []).length;
  if (alphaCount < 10) return false;

  return true;
}

/**
 * Detect transition cues in transcript signaling the end or transition of a topic
 */
export function hasTopicTransitionCue(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  const transitionPatterns = [
    /\b(?:now\s+let'?s\s+move|moving\s+on\s+to|next\s+up|in\s+summary|to\s+summarize|so\s+that\s+concludes|that\s+covers|in\s+the\s+next\s+section|secondly|let'?s\s+turn\s+(?:to|our\s+attention)|our\s+next\s+topic|next\s+concept|that'?s\s+the\s+first\s+part|now\s+we\s+will|let'?s\s+now\s+discuss)\b/i
  ];
  return transitionPatterns.some((p) => p.test(lower));
}
