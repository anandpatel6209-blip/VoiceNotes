/**
 * VoiceNotes - Shared Types, Message Contracts and Default Configurations
 */

export const MESSAGE_TYPES = {
  // Live notes and AI jobs
  GENERATE_LIVE_NOTES: 'GENERATE_LIVE_NOTES',
  PROCESS_VOICE_EDIT: 'PROCESS_VOICE_EDIT',
  CANCEL_JOB: 'CANCEL_JOB',
  GET_QUEUE_STATUS: 'GET_QUEUE_STATUS',

  // Provider testing
  TEST_PROVIDER: 'TEST_PROVIDER',

  // Settings
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',

  // Persistence & History
  LOAD_NOTES: 'LOAD_NOTES',
  SAVE_NOTES: 'SAVE_NOTES',
  CLEAR_NOTES: 'CLEAR_NOTES',
  LOAD_TRANSCRIPT: 'LOAD_TRANSCRIPT',
  SAVE_TRANSCRIPT: 'SAVE_TRANSCRIPT',
  GET_EDIT_HISTORY: 'GET_EDIT_HISTORY',
  RESTORE_VERSION: 'RESTORE_VERSION',
  FETCH_CAPTIONS: 'FETCH_CAPTIONS',

  // Export
  EXPORT_NOTES: 'EXPORT_NOTES',

  // System & Navigation
  PING: 'PING',
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  COMMAND_TRIGGERED: 'COMMAND_TRIGGERED',
  TOGGLE_PANEL: 'TOGGLE_PANEL'
};

export const PROVIDERS = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai',
  GEMINI: 'gemini',
  GROQ: 'groq'
};

export const DEFAULT_MODELS = {
  [PROVIDERS.ANTHROPIC]: 'claude-3-5-sonnet-latest',
  [PROVIDERS.OPENAI]: 'gpt-4o-mini',
  [PROVIDERS.GEMINI]: 'gemini-3.5-flash-lite',
  [PROVIDERS.GROQ]: 'llama-3.3-70b-versatile'
};

export const DEFAULT_SETTINGS = {
  vn_provider: PROVIDERS.GEMINI,
  vn_model: DEFAULT_MODELS[PROVIDERS.GEMINI],
  vn_api_key: '',
  vn_chunk_interval: 15, // seconds
  vn_auto_resume: true,
  vn_live_enabled: true,
  vn_speech_lang: 'auto',
  vn_preferred_caption_lang: 'en',
  vn_debug_mode: false
};

export const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};
