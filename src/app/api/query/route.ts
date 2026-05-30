import { NextResponse } from 'next/server';
import { readRuntimeEnv } from '@/lib/env/runtime-env';
import { CHAT_ACCESS_KEY_HEADER, safeKeyEquals } from '@/lib/chat/access-key';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_SCRAPER_URL = 'http://localhost:8787';

type QueryBody = {
  message?: unknown;
};

/**
 * Gate access to the chat with a shared secret (`CHAT_ACCESS_KEY`). Returns an
 * error `NextResponse` when access should be denied, or `null` when allowed.
 */
function checkAccessKey(req: Request): NextResponse | null {
  const expected = readRuntimeEnv('CHAT_ACCESS_KEY');
  if (!expected) {
    console.error('[/api/query] CHAT_ACCESS_KEY is not configured');
    return NextResponse.json(
      { error: 'Chat access is not configured. Set CHAT_ACCESS_KEY on the server.' },
      { status: 503 },
    );
  }

  const provided = req.headers.get(CHAT_ACCESS_KEY_HEADER)?.trim() ?? '';
  if (!provided) {
    return NextResponse.json(
      { error: 'Missing access key. Enter it to continue.' },
      { status: 401 },
    );
  }
  if (!safeKeyEquals(provided, expected)) {
    return NextResponse.json({ error: 'Invalid access key.' }, { status: 401 });
  }
  return null;
}

type ScraperResponse = {
  ok?: boolean;
  answer?: unknown;
  error?: unknown;
};

function resolveScraperBaseUrl(): string {
  const raw = readRuntimeEnv('COURT_SCRAPER_URL') ?? DEFAULT_SCRAPER_URL;
  return raw.trim().replace(/\/$/, '');
}

export async function POST(req: Request) {
  const denied = checkAccessKey(req);
  if (denied) return denied;

  let body: QueryBody = {};
  try {
    body = (await req.json()) as QueryBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'Missing `message` (string).' }, { status: 400 });
  }

  const base = resolveScraperBaseUrl();

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: message }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Network error';
    console.error('[/api/query] upstream fetch failed', detail, err);
    return NextResponse.json(
      { error: `Could not reach the court service at ${base}. ${detail}` },
      { status: 502 },
    );
  }

  const json = (await upstream.json().catch(() => ({}))) as ScraperResponse;

  if (!upstream.ok) {
    const errMsg =
      typeof json.error === 'string' && json.error.trim()
        ? json.error
        : `Court service responded with ${upstream.status}.`;
    console.error('[/api/query] upstream error', upstream.status, errMsg);
    return NextResponse.json({ error: errMsg }, { status: upstream.status });
  }

  const answer = typeof json.answer === 'string' ? json.answer.trim() : '';
  return NextResponse.json({
    message: answer || 'I could not find an answer just now. Please try again.',
  });
}
