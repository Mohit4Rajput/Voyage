// Deno Edge Function: user authentication and validation; expensive work runs in worker.mjs.
import { AppError, readJsonLimited } from '../_shared/domain.mjs';
import { buildCommand, mapDatabaseError } from '../_shared/commands.mjs';

const env = (name: string) => Deno.env.get(name) ?? '';
const supabaseUrl = env('SUPABASE_URL').replace(/\/$/, '');
const publishableKey = env('SUPABASE_ANON_KEY');
const origins = env('ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean);

function cors(origin: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  if (origin && origins.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin'), headers = cors(origin), requestId = crypto.randomUUID();
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (origin && !origins.includes(origin)) return reply({ data: null, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not configured.' }, requestId }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  try {
    if (request.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', 'Use POST.', 405);
    if (!supabaseUrl || !publishableKey) throw new AppError('CONFIGURATION_ERROR', 'Backend is not configured.', 503);
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || authorization.length > 10000) throw new AppError('UNAUTHORIZED', 'Sign in or start a guest session.', 401);
    // Verify with Auth, rather than trusting an unverified JWT payload.
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: publishableKey, Authorization: authorization }, signal: AbortSignal.timeout(10000) });
    if (!userResponse.ok) throw new AppError('UNAUTHORIZED', 'Session is invalid or expired.', 401);
    const user = await userResponse.json();
    if (!user.id) throw new AppError('UNAUTHORIZED', 'Session is invalid.', 401);
    const body = await readJsonLimited(request);
    const { name, args, issuedToken } = await buildCommand(body);
    // Preserve user context so SQL ownership checks use auth.uid(). No service role here.
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: publishableKey, Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw mapDatabaseError(String(error.message ?? ''));
    }
    let data = response.status === 204 ? null : await response.json();
    if (issuedToken) data = { id: data, token: issuedToken };
    return reply({ data, error: null, requestId }, body.action === 'research-options' || body.action === 'build-itinerary' ? 202 : 200);
  } catch (error) {
    const safe = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', 'Request could not be completed.', 500);
    return reply({ data: null, error: { code: safe.code, message: safe.message }, requestId }, safe.status);
  }
});
