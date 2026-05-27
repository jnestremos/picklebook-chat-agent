import { NextResponse } from 'next/server';
import { runAgent } from '@/lib/agent/openai-tool-agent';
import type { ChatTurn } from '@/lib/agent/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type AgentBody = {
  message?: unknown;
  conversation_history?: unknown;
};

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const role = r.role;
    const content = r.content;
    if (
      (role === 'user' || role === 'assistant' || role === 'system') &&
      typeof content === 'string' &&
      content.trim()
    ) {
      out.push({ role, content });
    }
  }
  return out;
}

export async function POST(req: Request) {
  let body: AgentBody = {};
  try {
    body = (await req.json()) as AgentBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ error: 'Missing `message` (string).' }, { status: 400 });
  }
  const history = parseHistory(body.conversation_history);

  try {
    const result = await runAgent(message, history);
    return NextResponse.json(result);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[/api/agent] failed', errMsg);
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
