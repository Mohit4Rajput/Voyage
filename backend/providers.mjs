import { AppError, ensure, safeUrl } from '../supabase/functions/_shared/domain.mjs';

export class ProviderError extends AppError {
  constructor(provider, status) {
    super(`${provider.toUpperCase()}_${status}`, `${provider} request failed (${status}).`, 502);
    this.retryable = status === 429 || status >= 500 || ['TIMEOUT','INVALID_JSON','INVALID_OUTPUT'].includes(status);
  }
}
export async function fetchJson(url, options = {}, provider = 'network', fetchImpl = fetch, timeoutMs = 90000) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new ProviderError(provider, 'TIMEOUT'); }
  if (!response.ok) throw new ProviderError(provider, response.status);
  try { return await response.json(); } catch { throw new ProviderError(provider, 'INVALID_JSON'); }
}

export class Providers {
  constructor(env, { fetchImpl = fetch, model, beforeCall = async()=>{} } = {}) {
    this.env = env; this.fetch = fetchImpl;
    this.model = env.OPENROUTER_MODEL || model;
    ensure(this.model?.endsWith(':free'), 'Only pinned :free model IDs are allowed.', 'MODEL_NOT_FREE');
    this.freeChecked = false;
    this.beforeCall = beforeCall;
  }
  async checkFreeModel() {
    const { data } = await fetchJson('https://openrouter.ai/api/v1/models', {}, 'openrouter', this.fetch);
    const found = data?.find(m => m.id === this.model);
    ensure(found && Number(found.pricing.prompt) === 0 && Number(found.pricing.completion) === 0, 'Pinned model is unavailable or no longer free; paid fallback is disabled.', 'MODEL_NOT_FREE');
    ensure(found.supported_parameters?.includes('response_format'), 'Pinned model no longer supports JSON output.', 'MODEL_FORMAT_UNSUPPORTED');
    this.supportsReasoningControl = found.supported_parameters.includes('reasoning');
    this.supportsReasoningBudget = found.reasoning?.supports_max_tokens === true;
    this.canDisableReasoning = found.reasoning?.mandatory === false;
    this.freeChecked = true;
  }
  async search(query) {
    await this.beforeCall('search');
    const result = await fetchJson('https://api.tavily.com/search', {
      method: 'POST', headers: { Authorization: `Bearer ${this.env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, search_depth: 'basic', auto_parameters: false, max_results: 4, include_answer: false, include_raw_content: false }),
    }, 'tavily', this.fetch);
    const checkedAt = new Date().toISOString();
    return (result.results ?? []).map(r => ({ url: safeUrl(r.url), title: String(r.title ?? '').slice(0, 250), content: String(r.content ?? '').slice(0, 1800), checked_at: checkedAt })).filter(r => r.url && r.title && r.content);
  }
  async generate(system, input, maxTokens = 6500) {
    if (!this.freeChecked) await this.checkFreeModel();
    await this.beforeCall('model');
    const result = await fetchJson('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Voyage Research Prototype' },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, response_format: { type: 'json_object' },
        ...(this.supportsReasoningControl ? { reasoning: this.canDisableReasoning ? { enabled: false, exclude: true } : this.supportsReasoningBudget ? { max_tokens: 1024, exclude: true } : { effort: 'low', exclude: true } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] }),
    }, 'openrouter', this.fetch, 240000);
    // Never enable OpenRouter search plugins or a paid model fallback implicitly.
    if (result.error) throw new ProviderError('openrouter', Number(result.error.code) || 'UPSTREAM_ERROR');
    const choice = result.choices?.[0];
    this.lastUsage = result.usage;
    if (choice?.finish_reason === 'length') throw new AppError('MODEL_TRUNCATED', `Model output exceeded its response budget (${result.usage?.completion_tokens ?? 'unknown'} output tokens, ${result.usage?.completion_tokens_details?.reasoning_tokens ?? 'unknown'} reasoning tokens).`);
    try { return JSON.parse(choice?.message?.content ?? ''); }
    catch { throw new ProviderError('openrouter', 'INVALID_OUTPUT'); }
  }
}
