import { AppError } from '../supabase/functions/_shared/domain.mjs';
export class SupabaseAdmin {
  constructor(env, fetchImpl = fetch) {
    this.url = env.SUPABASE_URL?.replace(/\/$/, ''); this.key = env.SUPABASE_SERVICE_ROLE_KEY; this.fetch = fetchImpl;
    if (!this.url || !this.key) throw new AppError('MISSING_SUPABASE_CONFIG', 'Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the root .env.');
    const u = new URL(this.url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname))) throw new AppError('INVALID_SUPABASE_URL', 'Supabase URL must use HTTPS or local development.');
  }
  async rpc(name, body) {
    let response;
    try {
      response = await this.fetch(`${this.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    } catch { throw new AppError('DATABASE_UNAVAILABLE', 'Database request failed.', 503); }
    if (!response.ok) throw new AppError('DATABASE_RPC_FAILED', `Database command ${name} failed (${response.status}).`, 503);
    return response.status === 204 ? null : response.json();
  }
}
