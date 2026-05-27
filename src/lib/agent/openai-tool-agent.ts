import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { getAnonSupabase } from '@/lib/supabase/server';
import { readRuntimeEnv } from '@/lib/env/runtime-env';
import { ALL_TOOLS, listLocations, searchCourts } from './tools';
import { buildSystemPrompt } from './system-prompt';
import type { AgentMeta, AgentResponse, ChatTurn, SearchToolArgs, SlotRow } from './types';

const MAX_TOOL_ITERATIONS = 5;

/** OpenAI-compatible servers (Ollama, vLLM, …) expect base URL to end with `/v1`. */
function normalizeCompatBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/v1')) return trimmed;
  return `${trimmed}/v1`;
}

function buildOpenAIClient(userApiKey?: string): { client: OpenAI; model: string } {
  const keyFromUser = userApiKey?.trim();
  if (keyFromUser) {
    const compatBase = readRuntimeEnv('OPENAI_COMPAT_BASE_URL');
    const compatModel = readRuntimeEnv('OPENAI_COMPAT_MODEL');
    if (!compatBase) {
      throw new Error(
        'OPENAI_COMPAT_BASE_URL is not set. Add it to wrangler.jsonc vars or Cloudflare dashboard runtime variables.',
      );
    }
    // User key is sent as Authorization: Bearer … for the Express auth layer.
    return {
      client: new OpenAI({
        apiKey: keyFromUser,
        baseURL: normalizeCompatBaseUrl(compatBase),
      }),
      model: compatModel || 'gpt-4o-mini',
    };
  }

  // Prefer OpenAI-compatible config when present (Ollama, vLLM, OpenRouter, …)
  const compatBase = readRuntimeEnv('OPENAI_COMPAT_BASE_URL');
  const compatKey = readRuntimeEnv('OPENAI_COMPAT_API_KEY');
  const compatModel = readRuntimeEnv('OPENAI_COMPAT_MODEL');
  if (compatBase) {
    return {
      client: new OpenAI({
        apiKey: compatKey || 'ollama',
        baseURL: normalizeCompatBaseUrl(compatBase),
      }),
      model: compatModel || 'gpt-4o-mini',
    };
  }

  const apiKey = readRuntimeEnv('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error(
      'No LLM credentials. Provide an API key in the chat dialog or set OPENAI_COMPAT_BASE_URL (+ OPENAI_COMPAT_API_KEY, OPENAI_COMPAT_MODEL) or OPENAI_API_KEY.',
    );
  }
  return {
    client: new OpenAI({ apiKey }),
    model: readRuntimeEnv('OPENAI_MODEL') || 'gpt-4o-mini',
  };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function pickSearchArgs(raw: unknown): SearchToolArgs {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: SearchToolArgs = {};
  if (typeof r.location === 'string' && r.location.trim()) out.location = r.location.trim();
  if (typeof r.manilaDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.manilaDate.trim()))
    out.manilaDate = r.manilaDate.trim();
  if (typeof r.datetime === 'string' && r.datetime.trim()) out.datetime = r.datetime.trim();
  return out;
}

async function runTool(
  toolCall: ChatCompletionMessageToolCall,
): Promise<{ content: string; capturedSearch?: SearchToolArgs; lastRows?: SlotRow[] }> {
  const supabase = getAnonSupabase();
  const name = toolCall.function.name;
  const args = safeJsonParse(toolCall.function.arguments ?? '{}');

  if (name === 'search_courts') {
    const picked = pickSearchArgs(args);
    const rows = await searchCourts(supabase, picked);
    return {
      content: JSON.stringify({ rows, count: rows.length }),
      capturedSearch: picked,
      lastRows: rows,
    };
  }

  if (name === 'list_locations') {
    const rows = await listLocations(supabase);
    return { content: JSON.stringify({ locations: rows, count: rows.length }) };
  }

  return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
}

export async function runAgent(
  userMessage: string,
  history: ChatTurn[],
  userApiKey?: string,
): Promise<AgentResponse> {
  const { client, model } = buildOpenAIClient(userApiKey);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    {
      role: 'user',
      content: `[Reply language: English]\n${userMessage}`,
    },
  ];

  let lastSearchArgs: SearchToolArgs | undefined;
  let lastRows: SlotRow[] | undefined;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: ALL_TOOLS,
      tool_choice: 'auto',
      temperature: 0.2,
    });

    const choice = completion.choices[0];
    if (!choice?.message) {
      return { message: 'I could not generate a reply just now. Please try again.' };
    }

    const msg = choice.message;
    const toolCalls = msg.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const meta: AgentMeta = {};
      if (lastSearchArgs) meta.search = lastSearchArgs;
      return {
        message: msg.content?.toString().trim() || '…',
        data: lastRows,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      };
    }

    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      try {
        const result = await runTool(tc);
        if (result.capturedSearch) lastSearchArgs = result.capturedSearch;
        if (result.lastRows) lastRows = result.lastRows;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.content,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: message }),
        });
      }
    }
  }

  return {
    message:
      'I had to stop after several tool calls without reaching a final answer. Please rephrase or try a tighter venue + date.',
    data: lastRows,
    meta: lastSearchArgs ? { search: lastSearchArgs } : undefined,
  };
}
