/**
 * VoiceNotes - Background Service Worker (Manifest V3)
 * Handles commands, secure AI requests with priority queueing,
 * provider testing, settings management, and persistence.
 *
 * Security & Reliability:
 * - Reads API key only from chrome.storage.local (never logged or exposed)
 * - Prioritizes user edits over background live chunks
 * - Exponential backoff and bounded jitter on transient network/rate errors
 * - Strict 30s timeout with AbortController
 * - Validates message sender and payload schema
 */

import { MESSAGE_TYPES, PROVIDERS, DEFAULT_MODELS, DEFAULT_SETTINGS, JOB_STATUS } from './src/shared/types.js';
import { parseNotesResponse, parseChangesetResponse, validateNote, isMeaningfulEducationalTranscript } from './src/shared/validator.js';
import { callLLMWithRetry, testConnection } from './src/shared/provider-adapters.js';
import { EditEngine } from './src/shared/edit-engine.js';
import { formatNotesToMarkdown, generateExportFilename } from './src/shared/exporter.js';

const TAG = '[VoiceNotes:bg]';
console.log(`${TAG} Service worker initializing...`);

// Priority Job Queue: User edits have priority 1, live chunks have priority 2
const jobQueue = [];
let activeJob = null;
let activeAbortController = null;

// Initialize edit engine for server-side changeset validation
const editEngine = new EditEngine();

/**
 * Retrieve user configuration securely from local storage
 */
async function getConfig() {
  const stored = await chrome.storage.local.get([
    'vn_provider',
    'vn_model',
    'vn_api_key',
    'vn_chunk_interval',
    'vn_auto_resume',
    'vn_live_enabled',
    'vn_speech_lang',
    'vn_preferred_caption_lang',
    'vn_debug_mode'
  ]);

  let provider = stored.vn_provider || DEFAULT_SETTINGS.vn_provider;
  let model = stored.vn_model || DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini;
  let apiKey = (stored.vn_api_key || DEFAULT_SETTINGS.vn_api_key || '').trim();
  const chunkInterval = stored.vn_chunk_interval || DEFAULT_SETTINGS.vn_chunk_interval;
  const autoResume = stored.vn_auto_resume !== undefined ? stored.vn_auto_resume : DEFAULT_SETTINGS.vn_auto_resume;
  const liveEnabled = stored.vn_live_enabled !== undefined ? stored.vn_live_enabled : DEFAULT_SETTINGS.vn_live_enabled;
  const speechLang = stored.vn_speech_lang || DEFAULT_SETTINGS.vn_speech_lang;
  const preferredCaptionLang = stored.vn_preferred_caption_lang || DEFAULT_SETTINGS.vn_preferred_caption_lang;
  const debugMode = Boolean(stored.vn_debug_mode);

  // Auto-heal deprecated Gemini models to gemini-3.5-flash-lite
  if (provider === PROVIDERS.GEMINI && (!model || model.includes('1.5') || model.includes('2.0') || model.includes('2.5'))) {
    model = 'gemini-3.5-flash-lite';
    chrome.storage.local.set({ vn_model: model });
  }

  // Ensure valid default key is persisted if empty
  if (!apiKey && DEFAULT_SETTINGS.vn_api_key) {
    apiKey = DEFAULT_SETTINGS.vn_api_key;
    chrome.storage.local.set({ vn_api_key: apiKey });
  }

  return {
    provider,
    model,
    apiKey,
    chunkInterval,
    autoResume,
    liveEnabled,
    speechLang,
    preferredCaptionLang,
    debugMode
  };
}

/**
 * Process next job in priority queue
 */
async function processQueue() {
  if (activeJob || jobQueue.length === 0) return;

  // Sort queue by priority ascending (1 = high priority user edit, 2 = normal live chunk)
  jobQueue.sort((a, b) => a.priority - b.priority);
  activeJob = jobQueue.shift();
  activeJob.status = JOB_STATUS.RUNNING;

  activeAbortController = new AbortController();

  try {
    const config = await getConfig();

    if (config.debugMode) {
      console.log(`${TAG} Executing job [${activeJob.type}] (priority ${activeJob.priority})`);
    }

    const isUserEdit = activeJob.priority === 1;
    const rawResponse = await callLLMWithRetry({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: activeJob.systemPrompt,
      userPrompt: activeJob.userPrompt,
      timeoutMs: isUserEdit ? 20000 : 30000,
      maxRetries: 2
    });

    activeJob.status = JOB_STATUS.SUCCEEDED;
    activeJob.resolve(rawResponse);
  } catch (err) {
    if (err.name === 'AbortError') {
      activeJob.status = JOB_STATUS.CANCELLED;
      activeJob.reject(new Error('Job was cancelled.'));
    } else {
      activeJob.status = JOB_STATUS.FAILED;
      console.error(`${TAG} Job execution failed:`, err.message);
      activeJob.reject(err);
    }
  } finally {
    activeJob = null;
    activeAbortController = null;
    if (jobQueue.length > 0) {
      setTimeout(processQueue, 50);
    }
  }
}

/**
 * Enqueue an AI request
 */
function enqueueJob({ type, priority = 2, systemPrompt, userPrompt }) {
  return new Promise((resolve, reject) => {
    // Avoid unbounded queue buildup (cap at 10 items)
    if (jobQueue.length >= 10) {
      // Remove lowest priority oldest job
      const droppedIndex = jobQueue.findLastIndex((j) => j.priority >= 2);
      if (droppedIndex !== -1) {
        const dropped = jobQueue.splice(droppedIndex, 1)[0];
        dropped.reject(new Error('Queue limit exceeded, request dropped.'));
      }
    }

    jobQueue.push({
      id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      type,
      priority,
      status: JOB_STATUS.QUEUED,
      systemPrompt,
      userPrompt,
      resolve,
      reject
    });

    processQueue();
  });
}

/**
 * Cancel currently active or queued job
 */
function cancelCurrentJob() {
  if (activeAbortController) {
    activeAbortController.abort();
  }
  // Clear any queued live chunk tasks
  const droppedJobs = jobQueue.splice(0, jobQueue.length);
  droppedJobs.forEach((j) => j.reject(new Error('Queue cleared / job cancelled.')));
  return { cancelled: true, droppedCount: droppedJobs.length };
}

/**
 * Handle GENERATE_LIVE_NOTES request
 */
async function handleGenerateLiveNotes(payload) {
  const { chunkText, chunkStartTime, chunkEndTime, existingNotes, videoTitle, topicTitle } = payload;
  if (!chunkText || typeof chunkText !== 'string' || chunkText.trim().length < 10) {
    throw new Error('Transcript chunk text is too short to generate notes.');
  }

  // Pre-filter: ignore music, applause, silence, or noise chunks before calling LLM
  if (!isMeaningfulEducationalTranscript(chunkText)) {
    console.log(`${TAG} Skipping non-educational / noise transcript chunk:`, chunkText.slice(0, 50));
    return [];
  }

  const systemPrompt = `You are VoiceNotes, an elite educational AI note-taker.
The user is playing an educational video. The video has completed a topic (time: ${chunkStartTime}s - ${chunkEndTime}s).
Generate a structured, high-value smart note for this completed topic.

Note Structure Requirements:
1. Main Topic Heading:
   - Begin with a clear Markdown heading: '# [Main Topic Heading]'.
   ${topicTitle ? `- Topic/chapter title: "${topicTitle}". Use this or an enhanced version as the main heading.` : '- Deduce a clear, accurate, concise title naming this completed topic.'}
2. Spacing:
   - Leave approximately two blank lines of vertical spacing directly below the main heading.
3. Summary of the Whole Topic:
   - Provide a comprehensive, cohesive summary covering the entire completed topic.
   - Introductory overview framing the core topic.
   - Important concepts organized under '### [Subheading]'.
   - Detailed explanations in clear paragraphs, followed by concise bullet points ('- ') highlighting key definitions, structural components, rules, or steps.
   - Clear fenced code blocks (\`\`\`language ... \`\`\`) or concrete examples whenever programming, math, or technical architecture is covered.
   - Final '### Key Takeaways & Summary' synthesizing the core lessons of the whole topic.

Rules:
- Format: HEADING, then SUMMARY OF THE WHOLE TOPIC.
- Synthesize the WHOLE topic comprehensively. Do not produce fragmented snippets or copy raw transcript speech.
- Continuity: Maintain topic continuity with previous notes, avoiding duplicate headings. If existing notes for this topic are already provided, do NOT re-generate the '# [Main Topic Heading]'.
- Irrelevant Content Filtering: If the transcript chunk consists solely of advertisements, sponsor pitches, intro/outro channel chatter, background music tags, or noise, return an empty array [].
- Response Format:
  Return a valid JSON array only: [{"time": number, "text": string}].
  * 'time': timestamp in seconds (integer: ${chunkStartTime}).
  * 'text': the structured Markdown content containing the '# [Main Topic Heading]' and the summary of the whole topic.
Do not wrap in extra markdown commentary outside the JSON array.`;

  const recentNotesSummary = (existingNotes || [])
    .slice(-8)
    .map((n) => `[${n.time}s] ${n.text.slice(0, 300)}`)
    .join('\n\n');

  const userPrompt = `Video Title: ${videoTitle || '(unknown)'}
Chunk Time Range: ${chunkStartTime}s - ${chunkEndTime}s
Existing Notes Context:
${recentNotesSummary || '(none yet - this is the start of the video)'}

<transcript>
${chunkText}
</transcript>

Analyze this transcript chunk and produce smart educational notes following the required structure. Return JSON array only: [{"time": number, "text": string}].`;

  const rawOutput = await enqueueJob({
    type: MESSAGE_TYPES.GENERATE_LIVE_NOTES,
    priority: 2, // normal priority
    systemPrompt,
    userPrompt
  });

  const notes = parseNotesResponse(rawOutput, chunkStartTime);
  return notes;
}

/**
 * Handle PROCESS_VOICE_EDIT request
 * Maintains persistent document state, context-aware editing, and version history.
 */
async function handleProcessVoiceEdit(payload) {
  const { videoId, userTime = 0, instruction, existingNotes = [], selectedNoteId = null, transcriptContext = '' } = payload;

  if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
    throw new Error('User edit instruction cannot be empty.');
  }

  const cleanInstruction = instruction.trim();

  const systemPrompt =
    'You are VoiceNotes Intelligent Document Editor. You perform persistent, context-aware editing on an active document of notes.\n\n' +
    'CORE RULES:\n' +
    '1. The latest document provided in <existing_notes> is the absolute source of truth. Every edit must build on this document without deleting or overwriting previous user edits or unrelated notes.\n' +
    '2. You MUST NOT regenerate the document from scratch or wipe existing notes.\n' +
    '3. Understand natural voice editing instructions including:\n' +
    '   - Adding new information or examples (e.g., "Add an example of supervised learning")\n' +
    '   - Rewriting existing paragraphs or notes (e.g., "Rewrite note 2 to be clearer")\n' +
    '   - Correcting grammar, spelling, or terminology\n' +
    '   - Simplifying complex explanations (e.g., "Explain unsupervised learning in simple language")\n' +
    '   - Creating headings and subheadings\n' +
    '   - Expanding or shortening explanations\n' +
    '   - Removing specific content only when explicitly asked (e.g., "Delete the part about...")\n' +
    '   - Reorganizing notes when instructed\n' +
    '4. Target the correct note or section accurately by matching ID, section heading, or content context.\n' +
    '5. If the voice instruction is ambiguous or refers to multiple possible sections, ask for clarification by returning:\n' +
    '   {"status": "clarification_needed", "summary": "Clarification needed", "clarificationPrompt": "Which section would you like to update?", "operations": []}\n' +
    '6. When successful, return structured JSON with:\n' +
    '   {\n' +
    '     "status": "success",\n' +
    '     "summary": "Clear 1-sentence description of modification",\n' +
    '     "operation": "add|update|delete|reorganize|multiple",\n' +
    '     "targetSection": "Target section name or heading",\n' +
    '     "operations": [\n' +
    '       {"action": "add", "note": {"time": number, "text": "..."}},\n' +
    '       {"action": "update", "id": "...", "text": "..."},\n' +
    '       {"action": "delete", "id": "..."},\n' +
    '       {"action": "reorganize", "order": ["id1", "id2", ...]}\n' +
    '     ]\n' +
    '   }\n' +
    '7. Output valid JSON only. No markdown fences, no conversational preambles.';

  const notesContext = existingNotes
    .map((n, idx) => `[#${idx + 1} ID: "${n.id}"] @${n.time}s (${n.source}${n.edited ? ', edited' : ''}):\n${n.text}`)
    .join('\n\n');

  const selectedContext = selectedNoteId
    ? `Target note selected by user: ID "${selectedNoteId}"\n`
    : '';

  const userPrompt =
    `Current playback time: ${userTime}s\n` +
    selectedContext +
    `<existing_notes>\n${notesContext || '(no notes yet)'}\n</existing_notes>\n\n` +
    (transcriptContext ? `<transcript_context>\n${transcriptContext}\n</transcript_context>\n\n` : '') +
    `<user_voice_instruction>\n${cleanInstruction}\n</user_voice_instruction>\n\n` +
    'Return structured JSON editing result:';

  const rawOutput = await enqueueJob({
    type: MESSAGE_TYPES.PROCESS_VOICE_EDIT,
    priority: 1, // HIGH priority: user is waiting actively
    systemPrompt,
    userPrompt
  });

  const changeset = parseChangesetResponse(rawOutput, userTime, cleanInstruction, existingNotes);

  if (changeset.status === 'clarification_needed') {
    return {
      success: true,
      status: 'clarification_needed',
      summary: changeset.summary || 'Clarification needed',
      clarificationPrompt: changeset.clarificationPrompt || 'Could you please clarify your edit instruction?',
      updatedNotes: existingNotes,
      affectedIds: [],
      inversePatch: []
    };
  }

  // Apply changeset to existing notes while preserving previous edits
  const result = editEngine.applyChangeset(existingNotes, changeset, userTime, {
    command: cleanInstruction,
    summary: changeset.summary,
    operation: changeset.operation,
    targetSection: changeset.targetSection
  });

  // Persist updated notes directly to storage
  if (videoId && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({
        [`notes:${videoId}`]: result.updatedNotes,
        [`history:${videoId}`]: editEngine.getEditHistory()
      });
    } catch (saveErr) {
      console.warn(`${TAG} Error persisting notes after voice edit:`, saveErr.message);
    }
  }

  return {
    success: true,
    status: changeset.status || 'success',
    summary: changeset.summary || 'Notes updated',
    operation: changeset.operation || 'update',
    targetSection: changeset.targetSection || '',
    changeset,
    updatedNotes: result.updatedNotes,
    affectedIds: result.affectedIds,
    inversePatch: result.inversePatch
  };
}

/**
 * Handle EXPORT_NOTES request
 */
async function handleExportNotes(payload) {
  const { title, videoId, videoUrl, notes, downloadFile = false } = payload;
  const markdown = formatNotesToMarkdown({ title, videoId, videoUrl, notes });
  const filename = generateExportFilename(title);

  if (downloadFile && chrome.downloads) {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const reader = new FileReader();

    const dataUrl = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: true
    });
  }

  return { markdown, filename };
}

// -----------------------------------------------------------------------------
// Message Listener Hub
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    console.warn(`${TAG} Rejected message from unauthorized sender:`, sender);
    return false;
  }

  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    return false;
  }

  const { type, payload } = message;

  switch (type) {
    case MESSAGE_TYPES.GENERATE_LIVE_NOTES:
      handleGenerateLiveNotes(payload)
        .then((notes) => sendResponse({ success: true, notes }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case MESSAGE_TYPES.PROCESS_VOICE_EDIT:
      handleProcessVoiceEdit(payload)
        .then((res) => sendResponse({ success: true, ...res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case MESSAGE_TYPES.CANCEL_JOB:
      sendResponse({ success: true, ...cancelCurrentJob() });
      break;

    case MESSAGE_TYPES.GET_SETTINGS:
      getConfig()
        .then((config) => {
          // Never return raw API key back to content script
          const safeConfig = { ...config, apiKey: Boolean(config.apiKey) };
          sendResponse({ success: true, config: safeConfig });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case MESSAGE_TYPES.UPDATE_SETTINGS:
      chrome.storage.local
        .set(payload)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case MESSAGE_TYPES.LOAD_NOTES: {
      const videoId = payload?.videoId;
      if (!videoId) {
        sendResponse({ success: false, error: 'Missing videoId' });
        return;
      }
      chrome.storage.local
        .get(`notes:${videoId}`)
        .then((data) => sendResponse({ success: true, notes: data[`notes:${videoId}`] || [] }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case MESSAGE_TYPES.SAVE_NOTES: {
      const { videoId, notes } = payload || {};
      if (!videoId || !Array.isArray(notes)) {
        sendResponse({ success: false, error: 'Invalid save payload' });
        return;
      }
      chrome.storage.local
        .set({ [`notes:${videoId}`]: notes })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case MESSAGE_TYPES.CLEAR_NOTES: {
      const videoId = payload?.videoId;
      if (videoId) {
        chrome.storage.local.remove(`notes:${videoId}`).then(() => sendResponse({ success: true }));
      } else {
        sendResponse({ success: false, error: 'Missing videoId' });
      }
      return true;
    }

    case MESSAGE_TYPES.LOAD_TRANSCRIPT: {
      const videoId = payload?.videoId;
      if (!videoId) {
        sendResponse({ success: false, error: 'Missing videoId' });
        return true;
      }
      chrome.storage.local
        .get(`transcript:${videoId}`)
        .then((data) => sendResponse({ success: true, transcript: data[`transcript:${videoId}`] || [] }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case MESSAGE_TYPES.SAVE_TRANSCRIPT: {
      const { videoId, transcript } = payload || {};
      if (!videoId || !Array.isArray(transcript)) {
        sendResponse({ success: false, error: 'Invalid save payload' });
        return true;
      }
      chrome.storage.local
        .set({ [`transcript:${videoId}`]: transcript })
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case MESSAGE_TYPES.GET_EDIT_HISTORY: {
      const videoId = payload?.videoId;
      if (!videoId) {
        sendResponse({ success: true, history: editEngine.getEditHistory() });
        return true;
      }
      chrome.storage.local
        .get(`history:${videoId}`)
        .then((data) => {
          const stored = data[`history:${videoId}`];
          const history = Array.isArray(stored) && stored.length > 0 ? stored : editEngine.getEditHistory();
          sendResponse({ success: true, history });
        })
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case MESSAGE_TYPES.RESTORE_VERSION: {
      const { videoId, versionId, notes = [] } = payload || {};
      const restored = editEngine.restoreVersion(versionId, notes);
      if (!restored) {
        sendResponse({ success: false, error: 'Version not found' });
        return true;
      }
      if (videoId && chrome.storage?.local) {
        chrome.storage.local.set({ [`notes:${videoId}`]: restored.updatedNotes }).catch(console.error);
      }
      sendResponse({ success: true, ...restored });
      return true;
    }

    case 'FETCH_CAPTIONS': {
      const fetchUrl = payload?.url;
      if (!fetchUrl) {
        sendResponse({ success: false, error: 'Missing caption URL' });
        return true;
      }

      const fetchTimedText = async () => {
        // Attempt 1: Fetch with &fmt=json3 (lighter, reliable, avoids XML 429)
        const sep = fetchUrl.includes('?') ? '&' : '?';
        try {
          const json3Res = await fetch(fetchUrl + sep + 'fmt=json3');
          if (json3Res.ok) {
            const text = await json3Res.text();
            if (text && text.trim().startsWith('{')) return text;
          }
        } catch (e) {}

        // Attempt 2: Standard URL
        const res = await fetch(fetchUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      };

      fetchTimedText()
        .then((text) => sendResponse({ success: true, text }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case MESSAGE_TYPES.EXPORT_NOTES:
      handleExportNotes(payload)
        .then((res) => sendResponse({ success: true, ...res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case MESSAGE_TYPES.TEST_PROVIDER:
      testConnection(payload)
        .then((res) => sendResponse({ success: true, ...res }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case MESSAGE_TYPES.OPEN_OPTIONS:
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
      }
      sendResponse({ success: true });
      break;

    case MESSAGE_TYPES.PING:
      sendResponse({ success: true, timestamp: Date.now() });
      break;

    default:
      sendResponse({ success: false, error: `Unhandled message type: ${type}` });
      break;
  }

  return true;
});

// Route manifest Alt+V command to active tab
chrome.commands.onCommand.addListener(async (command) => {
  console.log(`${TAG} Command received: ${command}`);
  if (command === 'toggle-pause-edit') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: MESSAGE_TYPES.COMMAND_TRIGGERED,
          payload: { command }
        }).catch((err) => {
          console.log(`${TAG} Command message could not be delivered:`, err.message);
        });
      }
    } catch (err) {
      console.error(`${TAG} Error routing command:`, err);
    }
  }
});

// Toolbar extension icon clicked -> toggle VoiceNotes panel on YouTube, or open options
if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    console.log(`${TAG} Action icon clicked on tab:`, tab?.url);
    if (tab?.id && tab.url && (tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/'))) {
      chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' }, () => {
        if (chrome.runtime.lastError) {
          chrome.runtime.openOptionsPage();
        }
      });
    } else {
      chrome.runtime.openOptionsPage();
    }
  });
}

// Run config validation & auto-heal on installation and startup
chrome.runtime.onInstalled.addListener(() => {
  console.log(`${TAG} Extension installed / updated, running config heal.`);
  getConfig().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  console.log(`${TAG} Browser startup, running config heal.`);
  getConfig().catch(console.error);
});

// Initial boot heal
getConfig().catch(console.error);

console.log(`${TAG} Background worker ready.`);
