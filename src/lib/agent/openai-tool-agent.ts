import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import { getAnonSupabase } from '@/lib/supabase/server';
import { readRuntimeEnv } from '@/lib/env/runtime-env';
import { LLM_REQUEST_TIMEOUT_MS, workerFetch } from '@/lib/env/worker-fetch';
import { augmentSearchArgsFromUserMessage } from './parse-user-query';
import { buildFormatterPrompt } from './format-prompt';
import { ALL_TOOLS, listLocations, searchCourts } from './tools';
import { buildSystemPrompt } from './system-prompt';
import {
  buildDeterministicReply,
  buildSlotSearchBriefing,
  filterSlotsByManilaTimeWindow,
  type SlotSearchBriefing,
} from './search-briefing';
import type { AgentMeta, AgentResponse, ChatTurn, SearchToolArgs, SlotRow } from './types';

const MAX_TOOL_ITERATIONS = 5;
const LLM_TEMPERATURE = 0;

const openAiTransport = {
  fetch: workerFetch,
  timeout: LLM_REQUEST_TIMEOUT_MS,
} as const;

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
    return {
      client: new OpenAI({
        apiKey: keyFromUser,
        baseURL: normalizeCompatBaseUrl(compatBase),
        ...openAiTransport,
      }),
      model: compatModel || 'gpt-4o-mini',
    };
  }

  const compatBase = readRuntimeEnv('OPENAI_COMPAT_BASE_URL');
  const compatKey = readRuntimeEnv('OPENAI_COMPAT_API_KEY');
  const compatModel = readRuntimeEnv('OPENAI_COMPAT_MODEL');
  if (compatBase) {
    return {
      client: new OpenAI({
        apiKey: compatKey || 'ollama',
        baseURL: normalizeCompatBaseUrl(compatBase),
        ...openAiTransport,
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
    client: new OpenAI({ apiKey, ...openAiTransport }),
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
  if (typeof r.manilaTimeFrom === 'string' && /^\d{2}:\d{2}$/.test(r.manilaTimeFrom.trim()))
    out.manilaTimeFrom = r.manilaTimeFrom.trim();
  if (typeof r.manilaTimeTo === 'string' && /^\d{2}:\d{2}$/.test(r.manilaTimeTo.trim()))
    out.manilaTimeTo = r.manilaTimeTo.trim();
  if (typeof r.datetime === 'string' && r.datetime.trim()) out.datetime = r.datetime.trim();
  return out;
}

type ToolRunResult = {
  content: string;
  capturedSearch?: SearchToolArgs;
  lastRows?: SlotRow[];
  briefing?: SlotSearchBriefing;
};

async function runTool(
  toolCall: ChatCompletionMessageToolCall,
  userMessage: string,
): Promise<ToolRunResult> {
  const supabase = getAnonSupabase();
  const name = toolCall.function.name;
  const args = safeJsonParse(toolCall.function.arguments ?? '{}');

  if (name === 'search_courts') {
    const picked = augmentSearchArgsFromUserMessage(pickSearchArgs(args), userMessage);
    let rows = await searchCourts(supabase, picked);
    rows = filterSlotsByManilaTimeWindow(rows, picked.manilaTimeFrom, picked.manilaTimeTo);
    const briefing = buildSlotSearchBriefing(rows, picked);
    return {
      content: JSON.stringify({
        status: briefing.found ? 'ok' : 'empty',
        slot_count: briefing.slot_count,
        court_count: briefing.court_count,
        venue_count: briefing.venue_count,
        message: 'Facts recorded. Do not summarize — the formatter will reply to the user.',
      }),
      capturedSearch: picked,
      lastRows: rows,
      briefing,
    };
  }

  if (name === 'list_locations') {
    const rows = await listLocations(supabase);
    return { content: JSON.stringify({ locations: rows, count: rows.length }) };
  }

  return { content: JSON.stringify({ error: `Unknown tool: ${name}` }) };
}

async function formatReplyFromBriefing(
  client: OpenAI,
  model: string,
  userMessage: string,
  briefing: SlotSearchBriefing,
): Promise<string> {
  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: LLM_TEMPERATURE,
      messages: [
        { role: 'system', content: buildFormatterPrompt() },
        {
          role: 'user',
          content: `USER QUESTION:\n${userMessage}\n\nVERIFIED FACTS:\n${briefing.facts_only}`,
        },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (text) return text;
  } catch {
    // Fall through to deterministic reply.
  }
  return buildDeterministicReply(briefing);
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
    { role: 'user', content: userMessage },
  ];

  let lastSearchArgs: SearchToolArgs | undefined;
  let lastRows: SlotRow[] | undefined;
  let lastBriefing: SlotSearchBriefing | undefined;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
    const completion = await client.chat.completions.create({
      model,
      messages,
      tools: ALL_TOOLS,
      tool_choice: 'auto',
      temperature: LLM_TEMPERATURE,
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

      let message: string;
      if (lastBriefing) {
        message = await formatReplyFromBriefing(client, model, userMessage, lastBriefing);
      } else {
        message = msg.content?.toString().trim() || 'How can I help you find a court?';
      }

      return {
        message,
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
        const result = await runTool(tc, userMessage);
        if (result.capturedSearch) lastSearchArgs = result.capturedSearch;
        if (result.lastRows) lastRows = result.lastRows;
        if (result.briefing) lastBriefing = result.briefing;
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result.content,
        });
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: errMessage }),
        });
      }
    }
  }

  if (lastBriefing) {
    return {
      message: await formatReplyFromBriefing(client, model, userMessage, lastBriefing),
      data: lastRows,
      meta: lastSearchArgs ? { search: lastSearchArgs } : undefined,
    };
  }

  return {
    message:
      'I had to stop after several tool calls without reaching a final answer. Please rephrase or try a tighter venue + date.',
    data: lastRows,
    meta: lastSearchArgs ? { search: lastSearchArgs } : undefined,
  };
}
