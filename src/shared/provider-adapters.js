/**
 * VoiceNotes - AI Provider Adapters & Resilience Layer
 * Direct, privileged background calls to Anthropic, OpenAI, Gemini, Groq
 * with exponential backoff, jitter, AbortController timeout, and key redaction.
 */

import { PROVIDERS } from './types.js';

export function formatApiError(status, provider, errorBody = '') {
  let snippet = '';
  try {
    const parsed = JSON.parse(errorBody);
    snippet = parsed.error?.message || parsed.message || '';
  } catch (e) {
    snippet = errorBody.slice(0, 100);
  }

  // Never leak potential keys or headers in snippet
  snippet = snippet.replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED_KEY]');

  if (status === 401 || status === 403) {
    return new Error(`${provider} API Error (${status}): Invalid or unauthorized API key. Check settings.`);
  }
  if (status === 404) {
    return new Error(`${provider} API Error (404): Specified model not found or unsupported.`);
  }
  if (status === 429) {
    return new Error(`${provider} Rate Limit (429): Quota exceeded or too many requests. Please wait.`);
  }
  if (status >= 500) {
    return new Error(`${provider} Server Error (${status}): Service temporarily unavailable.`);
  }
  return new Error(`${provider} Error (${status}): ${snippet || 'Request failed'}`);
}

/**
 * Exponential backoff with random jitter
 */
async function waitWithBackoff(attempt, baseDelayMs = 600) {
  const delay = Math.floor(baseDelayMs * Math.pow(2, attempt) + Math.random() * 200);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * 1. Anthropic API Call
 */
export async function callAnthropic({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw formatApiError(res.status, 'Anthropic', errorBody);
  }

  const data = await res.json();
  return data?.content?.[0]?.text || '';
}

/**
 * 2. OpenAI API Call
 */
export async function callOpenAI({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw formatApiError(res.status, 'OpenAI', errorBody);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * 3. Gemini API Call
 */
export async function callGemini({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const primaryModel = model || 'gemini-3.5-flash-lite';
  const modelsToTry = [primaryModel];
  if (primaryModel === 'gemini-3.5-flash-lite') {
    modelsToTry.push('gemini-3.8-flash');
  } else if (primaryModel === 'gemini-3.8-flash') {
    modelsToTry.push('gemini-3.5-flash-lite');
  }

  let lastError = null;
  for (const targetModel of modelsToTry) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            parts: [{ text: userPrompt }]
          }
        ],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      })
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      lastError = formatApiError(res.status, 'Gemini', errorBody);
      // If 429 rate limit and we have an alternate model, try fallback
      if (res.status === 429 && modelsToTry.length > 1 && targetModel !== modelsToTry[modelsToTry.length - 1]) {
        console.warn(`[VoiceNotes:provider] Model ${targetModel} rate limit reached, attempting fallback to ${modelsToTry[1]}...`);
        continue;
      }
      throw lastError;
    }

    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  throw lastError || new Error('Gemini API request failed on all attempted models.');
}

/**
 * 4. Groq API Call
 */
export async function callGroq({ apiKey, model, systemPrompt, userPrompt, signal }) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw formatApiError(res.status, 'Groq', errorBody);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * Unified dispatch with retry and exponential backoff
 */
export async function callLLMWithRetry({
  provider,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  timeoutMs = 30000,
  maxRetries = 2
}) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('API key not configured. Open VoiceNotes settings (•••) and enter your key.');
  }

  const cleanKey = apiKey.trim();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let result = '';
      if (provider === PROVIDERS.ANTHROPIC) {
        result = await callAnthropic({ apiKey: cleanKey, model, systemPrompt, userPrompt, signal: controller.signal });
      } else if (provider === PROVIDERS.OPENAI) {
        result = await callOpenAI({ apiKey: cleanKey, model, systemPrompt, userPrompt, signal: controller.signal });
      } else if (provider === PROVIDERS.GEMINI) {
        result = await callGemini({ apiKey: cleanKey, model, systemPrompt, userPrompt, signal: controller.signal });
      } else if (provider === PROVIDERS.GROQ) {
        result = await callGroq({ apiKey: cleanKey, model, systemPrompt, userPrompt, signal: controller.signal });
      } else {
        throw new Error(`Unsupported provider: ${provider}`);
      }

      return result;
    } catch (err) {
      const isTransient =
        err.name === 'AbortError' ||
        err.message.includes('429') ||
        err.message.includes('500') ||
        err.message.includes('502') ||
        err.message.includes('503') ||
        err.message.includes('504') ||
        err.message.includes('fetch');

      const isPermanentAuth =
        err.message.includes('401') ||
        err.message.includes('403') ||
        err.message.includes('not configured');

      if (attempt < maxRetries && isTransient && !isPermanentAuth) {
        await waitWithBackoff(attempt);
        continue;
      }

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Test provider connection with a 1-token test prompt
 */
export async function testConnection({ provider, apiKey, model }) {
  const systemPrompt = 'Respond with "OK" only.';
  const userPrompt = 'Ping';
  const res = await callLLMWithRetry({
    provider,
    apiKey,
    model,
    systemPrompt,
    userPrompt,
    timeoutMs: 15000,
    maxRetries: 0
  });
  return { ok: true, response: res.slice(0, 50) };
}
