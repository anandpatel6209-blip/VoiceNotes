import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatApiError, callLLMWithRetry } from '../src/shared/provider-adapters.js';
import { PROVIDERS } from '../src/shared/types.js';

describe('Provider Adapters', () => {
  it('formats 401/403 errors and redacts potential API keys', () => {
    const err = formatApiError(401, 'Anthropic', JSON.stringify({ error: { message: 'Invalid key sk-ant-api03-secret12345678' } }));
    assert.ok(err.message.includes('Invalid or unauthorized API key'));
    assert.ok(!err.message.includes('secret12345678'));
  });

  it('formats 429 rate limit errors with user guidance', () => {
    const err = formatApiError(429, 'OpenAI', 'Too many requests');
    assert.ok(err.message.includes('Rate Limit'));
    assert.ok(err.message.includes('429'));
  });

  it('formats 500 server errors cleanly', () => {
    const err = formatApiError(500, 'Gemini', 'Internal server error');
    assert.ok(err.message.includes('Server Error (500)'));
  });

  it('fails fast when API key is missing without making network calls', async () => {
    await assert.rejects(
      async () => {
        await callLLMWithRetry({
          provider: PROVIDERS.OPENAI,
          apiKey: '',
          model: 'gpt-4o-mini',
          systemPrompt: 'System',
          userPrompt: 'User'
        });
      },
      /API key not configured/
    );
  });
});
