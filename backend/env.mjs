import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function loadEnv() {
  const env = { ...process.env };
  for (const file of ['.env', 'frontend/.env', 'frontend/env.txt']) {
    let content;
    try { content = await fs.readFile(path.join(root, file), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    env.OPENROUTER_API_KEY ||= content.match(/\bsk-or-v1-[A-Za-z0-9_-]+/)?.[0];
    env.TAVILY_API_KEY ||= content.match(/\btvly-[A-Za-z0-9_-]+/)?.[0];
  }
  return env;
}
export function requireEnv(env, names) {
  const missing = names.filter(name => !env[name]);
  if (missing.length) throw new Error(`Missing server configuration: ${missing.join(', ')}. See .env.example.`);
}
