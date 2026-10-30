/**
 * VoiceNotes - Options Page Logic
 * Manages user API keys, provider/model selection, playback preferences,
 * provider testing, and data storage.
 *
 * Strictly adheres to security requirements:
 * - Never log or leak raw API keys
 * - Masked password field with toggle
 * - Local storage only (no remote telemetry)
 */

(() => {
  const TAG = '[VoiceNotes:options]';
  if (window.location.search.includes('reload=1')) {
    console.log(`${TAG} Reloading extension via chrome.runtime.reload()...`);
    chrome.runtime.reload();
    return;
  }

  const PROVIDER_MODELS = {
    gemini: [
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite (Recommended, Fast)' },
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }
    ],
    anthropic: [
      { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet (Recommended)' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku (Fast)' }
    ],
    openai: [
      { id: 'gpt-4o-mini', name: 'GPT-4o mini (Fast & Economical, Recommended)' },
      { id: 'gpt-4o', name: 'GPT-4o' }
    ],
    groq: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile (Recommended)' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant (Ultra Fast)' }
    ]
  };

  const providerSelect = document.getElementById('provider-select');
  const modelSelect = document.getElementById('model-select');
  const apiKeyInput = document.getElementById('api-key-input');
  const toggleKeyBtn = document.getElementById('toggle-key-visibility');
  const testConnBtn = document.getElementById('test-connection-btn');
  const removeKeyBtn = document.getElementById('remove-key-btn');
  const liveToggle = document.getElementById('live-toggle');
  const intervalSelect = document.getElementById('interval-select');
  const autoResumeToggle = document.getElementById('auto-resume-toggle');
  const speechLangSelect = document.getElementById('speech-lang-select');
  const debugToggle = document.getElementById('debug-toggle');
  const saveBtn = document.getElementById('save-btn');
  const statusBox = document.getElementById('status-box');
  const connStatusBox = document.getElementById('connection-status');
  const clearDataBtn = document.getElementById('clear-data-btn');

  function populateModels(provider, selectedModel) {
    modelSelect.textContent = '';
    const models = PROVIDER_MODELS[provider] || [];
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      if (m.id === selectedModel || (!selectedModel && opt === models[0])) {
        opt.selected = true;
      }
      modelSelect.appendChild(opt);
    });
  }

  function showStatus(box, msg, isSuccess = true, duration = 4500) {
    box.textContent = msg;
    box.className = `status-msg ${isSuccess ? 'success' : 'error'}`;
    box.style.display = 'block';
    if (duration > 0) {
      setTimeout(() => {
        box.style.display = 'none';
      }, duration);
    }
  }

  // Direct connection test fallback for standalone preview mode
  async function testDirectly(provider, apiKey, model) {
    if (provider === 'gemini') {
      const targetModel = model || 'gemini-3.5-flash-lite';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Respond with OK' }] }] })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini API Error (${res.status}): ${text.slice(0, 100)}`);
      }
      return { ok: true };
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'Ping' }] })
      });
      if (!res.ok) throw new Error(`OpenAI API Error (${res.status})`);
      return { ok: true };
    } else if (provider === 'groq') {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model || 'llama-3.3-70b-versatile', max_tokens: 5, messages: [{ role: 'user', content: 'Ping' }] })
      });
      if (!res.ok) throw new Error(`Groq API Error (${res.status})`);
      return { ok: true };
    } else if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: model || 'claude-3-5-sonnet-latest', max_tokens: 5, messages: [{ role: 'user', content: 'Ping' }] })
      });
      if (!res.ok) throw new Error(`Anthropic API Error (${res.status})`);
      return { ok: true };
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  // Load configuration
  async function loadSettings() {
    let provider = 'gemini';
    let model = 'gemini-3.5-flash-lite';
    let apiKey = '';
    let chunkInterval = 30;
    let autoResume = true;
    let liveEnabled = true;
    let speechLang = 'auto';
    let debugMode = false;

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const data = await chrome.storage.local.get([
          'vn_provider',
          'vn_model',
          'vn_api_key',
          'vn_chunk_interval',
          'vn_auto_resume',
          'vn_live_enabled',
          'vn_speech_lang',
          'vn_debug_mode'
        ]);

        if (data.vn_provider) provider = data.vn_provider;
        if (data.vn_model) model = data.vn_model;
        if (data.vn_api_key) apiKey = data.vn_api_key;
        if (data.vn_chunk_interval) chunkInterval = data.vn_chunk_interval;
        if (data.vn_auto_resume !== undefined) autoResume = data.vn_auto_resume;
        if (data.vn_live_enabled !== undefined) liveEnabled = data.vn_live_enabled;
        if (data.vn_speech_lang) speechLang = data.vn_speech_lang;
        if (data.vn_debug_mode !== undefined) debugMode = data.vn_debug_mode;
      } catch (err) {
        console.warn(`${TAG} Error reading chrome.storage, using defaults:`, err);
      }
    } else if (typeof localStorage !== 'undefined') {
      provider = localStorage.getItem('vn_provider') || provider;
      model = localStorage.getItem('vn_model') || model;
      apiKey = localStorage.getItem('vn_api_key') || apiKey;
    }

    // Fallback to local secrets.json if key is empty
    if (!apiKey) {
      try {
        const res = await fetch(chrome.runtime.getURL('secrets.json'));
        if (res.ok) {
          const secret = await res.json();
          if (secret.apiKey) {
            apiKey = secret.apiKey.trim();
            if (secret.provider) provider = secret.provider;
            if (secret.model) model = secret.model;
            if (typeof chrome !== 'undefined' && chrome.storage?.local) {
              await chrome.storage.local.set({
                vn_api_key: apiKey,
                vn_provider: provider,
                vn_model: model
              });
            }
          }
        }
      } catch (e) {}
    }

    providerSelect.value = provider;
    populateModels(provider, model);
    apiKeyInput.value = apiKey;
    intervalSelect.value = String(chunkInterval);
    autoResumeToggle.checked = Boolean(autoResume);
    liveToggle.checked = Boolean(liveEnabled);
    speechLangSelect.value = speechLang;
    debugToggle.checked = Boolean(debugMode);

    console.log(`${TAG} Settings loaded.`);
  }

  // Change model list on provider selection
  providerSelect.addEventListener('change', () => {
    populateModels(providerSelect.value);
  });

  // Toggle API key visibility
  toggleKeyBtn.addEventListener('click', () => {
    if (apiKeyInput.type === 'password') {
      apiKeyInput.type = 'text';
      toggleKeyBtn.textContent = 'Hide';
    } else {
      apiKeyInput.type = 'password';
      toggleKeyBtn.textContent = 'Show';
    }
  });

  // Test provider connection
  testConnBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
      showStatus(connStatusBox, 'Please enter an API key first.', false);
      return;
    }

    testConnBtn.disabled = true;
    testConnBtn.textContent = 'Testing...';
    showStatus(connStatusBox, 'Testing connection with provider endpoint...', true, 0);

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'TEST_PROVIDER',
            payload: { provider, apiKey, model }
          },
          (res) => {
            testConnBtn.disabled = false;
            testConnBtn.textContent = 'Test Connection';

            if (chrome.runtime.lastError) {
              // Fallback directly via fetch
              testDirectly(provider, apiKey, model)
                .then(() => showStatus(connStatusBox, `Connected successfully to ${provider} (${model})!`, true))
                .catch((err) => showStatus(connStatusBox, err.message, false));
              return;
            }

            if (res?.success && res.ok) {
              showStatus(connStatusBox, `Connected successfully to ${provider} (${model})!`, true);
            } else {
              showStatus(connStatusBox, res?.error || 'Connection failed. Check API key and quota.', false);
            }
          }
        );
      } catch (sendErr) {
        testDirectly(provider, apiKey, model)
          .then(() => showStatus(connStatusBox, `Connected successfully to ${provider} (${model})!`, true))
          .catch((err) => showStatus(connStatusBox, err.message, false))
          .finally(() => {
            testConnBtn.disabled = false;
            testConnBtn.textContent = 'Test Connection';
          });
      }
    } else {
      // Direct browser fallback
      try {
        await testDirectly(provider, apiKey, model);
        showStatus(connStatusBox, `Connected successfully to ${provider} (${model})!`, true);
      } catch (err) {
        showStatus(connStatusBox, err.message, false);
      } finally {
        testConnBtn.disabled = false;
        testConnBtn.textContent = 'Test Connection';
      }
    }
  });

  // Remove Key button
  removeKeyBtn.addEventListener('click', async () => {
    apiKeyInput.value = '';
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.remove('vn_api_key');
    }
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('vn_api_key');
    }
    showStatus(connStatusBox, 'API Key cleared.', true);
  });

  // Save settings
  saveBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const chunkInterval = parseInt(intervalSelect.value, 10) || 30;
    const autoResume = autoResumeToggle.checked;
    const liveEnabled = liveToggle.checked;
    const speechLang = speechLangSelect.value;
    const debugMode = debugToggle.checked;

    const payload = {
      vn_provider: provider,
      vn_model: model,
      vn_api_key: apiKey,
      vn_chunk_interval: chunkInterval,
      vn_auto_resume: autoResume,
      vn_live_enabled: liveEnabled,
      vn_speech_lang: speechLang,
      vn_debug_mode: debugMode
    };

    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set(payload);
    }
    if (typeof localStorage !== 'undefined') {
      for (const [k, v] of Object.entries(payload)) {
        localStorage.setItem(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }

    showStatus(statusBox, 'Preferences saved successfully.', true);
    console.log(`${TAG} Preferences saved.`);
  });

  // Clear all saved notes data
  clearDataBtn.addEventListener('click', async () => {
    const confirmed = window.confirm(
      'Are you sure you want to delete all saved video notes? This cannot be undone.'
    );
    if (!confirmed) return;

    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        const allKeys = await chrome.storage.local.get(null);
        const notesKeys = Object.keys(allKeys).filter((k) => k.startsWith('notes:'));
        if (notesKeys.length > 0) {
          await chrome.storage.local.remove(notesKeys);
        }
        showStatus(statusBox, `Deleted notes for ${notesKeys.length} video(s).`, true);
      } else {
        showStatus(statusBox, 'Data cleared.', true);
      }
    } catch (err) {
      showStatus(statusBox, 'Failed to clear data.', false);
    }
  });

  // Reload Extension
  const reloadExtBtn = document.getElementById('reload-ext-btn');
  if (reloadExtBtn) {
    reloadExtBtn.addEventListener('click', () => {
      showStatus(statusBox, 'Reloading extension...', true, 2000);
      setTimeout(() => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.reload) {
          chrome.runtime.reload();
        } else {
          window.location.reload();
        }
      }, 400);
    });
  }

  document.addEventListener('DOMContentLoaded', loadSettings);
})();
