'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantMessageBody } from './assistant-message';
import { SearchDataPreview } from './search-data-preview';
import { CourtDirectoryPanel } from './court-directory';
import { useCourtsRealtimePulse } from './use-realtime-pulse';
import styles from './chat.module.css';

type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  data?: unknown;
  meta?: Record<string, unknown>;
  sentAt: number;
};

/**
 * All agent/courts traffic now lives in Next.js route handlers under `/api`,
 * so the base is empty (same origin).
 */
function apiBase(): string {
  return '';
}

function formatClock(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

function isAssistantError(text: string): boolean {
  return text.startsWith('Request failed');
}

const CONVERSATION_HISTORY_CAP = 24;
const CONVERSATION_CHUNK = 6000;

function buildConversationHistoryPayload(
  msgs: ChatMessage[],
): { role: string; content: string }[] {
  return msgs.slice(-CONVERSATION_HISTORY_CAP).map((m) => ({
    role: m.role,
    content:
      m.text.length > CONVERSATION_CHUNK
        ? `${m.text.slice(0, CONVERSATION_CHUNK)}…`
        : m.text,
  }));
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  /**
   * Supabase realtime pulse — increments whenever `courts` or `slots` change.
   * The directory + search preview can listen for this to refetch; the next
   * `/api/agent` call also implicitly hits fresh data because the agent reads
   * Supabase server-side on every turn.
   */
  const realtimePulse = useCourtsRealtimePulse();

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    const base = apiBase();
    setConfigError(null);
    const now = Date.now();
    setInput('');
    setMessages((m) => [...m, { role: 'user', text, sentAt: now }]);
    setLoading(true);

    try {
      const conversation_history = buildConversationHistoryPayload(
        messagesRef.current,
      );

      const res = await fetch(`${base}/api/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          conversation_history,
        }),
      });

      const json: Record<string, unknown> = await res.json().catch(() => ({}));
      const replyAt = Date.now();

      if (!res.ok) {
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            text: `Request failed (${res.status})\n${JSON.stringify(json, null, 2)}`,
            sentAt: replyAt,
          },
        ]);
        return;
      }

      const msg =
        typeof json.message === 'string'
          ? json.message
          : JSON.stringify(json, null, 2);
      const data = 'data' in json ? json.data : undefined;
      const meta =
        json.meta && typeof json.meta === 'object' && !Array.isArray(json.meta)
          ? (json.meta as Record<string, unknown>)
          : undefined;

      setMessages((m) => [
        ...m,
        { role: 'assistant', text: msg, data, meta, sentAt: replyAt },
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        {
          role: 'assistant',
          text: e instanceof Error ? e.message : 'Network error',
          sentAt: Date.now(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.headerBrand}>
            <h1 className={styles.headerTitle}>Messages</h1>
            <p className={styles.headerSubtitle}>
              Tool-backed search in Supabase · each reply uses transcript +
              fresh DB snapshot (realtime).
            </p>
          </div>
          <a className={styles.headerHome} href="/">
            Home
          </a>
        </div>
      </header>

      <CourtDirectoryPanel
        apiBase={apiBase()}
        refreshKey={realtimePulse}
        onInsertVenue={(phrase) => {
          setInput((prev) => {
            const p = prev.trim();
            return p ? `${p} ${phrase}` : phrase;
          });
        }}
      />

      {configError ? <p className={styles.error}>{configError}</p> : null}

      <div className={styles.thread}>
        {messages.length === 0 && !loading ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon} aria-hidden>
              💬
            </div>
            <h2 className={styles.emptyTitle}>Hi there</h2>
            <p className={styles.emptyBody}>
              Say <strong>where</strong> and <strong>which day</strong> to check
              availability. Follow-ups rely on this thread—the agent rereads
              Supabase on each question.
            </p>
          </div>
        ) : null}

        {messages.map((msg, i) => {
          const isUser = msg.role === 'user';
          const rowClass = isUser ? styles.rowUser : styles.rowAssistant;
          const bubbleClass = `${styles.bubble} ${isUser ? styles.bubbleUser : styles.bubbleAssistant} ${
            !isUser && isAssistantError(msg.text) ? styles.bubbleError : ''
          }`;

          return (
            <div key={i} className={`${styles.row} ${rowClass}`}>
              {!isUser ? <div className={styles.avatar}>🏸</div> : null}
              <div className={styles.bubbleCol}>
                <div className={bubbleClass}>
                  {isUser ? (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{msg.text}</span>
                  ) : (
                    <>
                      <AssistantMessageBody text={msg.text} />
                      {msg.data !== undefined ? (
                        <SearchDataPreview data={msg.data} meta={msg.meta} />
                      ) : null}
                    </>
                  )}
                  {typeof msg.meta?.hint === 'string' ? (
                    <p className={styles.metaHint}>{msg.meta.hint}</p>
                  ) : null}
                  {msg.data !== undefined ? (
                    <details className={styles.dataDetails}>
                      <summary className={styles.dataSummary}>
                        Developer JSON
                      </summary>
                      <pre className={styles.dataBlock}>
                        {JSON.stringify(msg.data, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
                <time
                  className={styles.timestamp}
                  dateTime={new Date(msg.sentAt).toISOString()}
                >
                  {formatClock(msg.sentAt)}
                </time>
              </div>
            </div>
          );
        })}

        {loading ? (
          <div className={styles.typingRow}>
            <div className={styles.avatar} aria-hidden>
              🏸
            </div>
            <div className={styles.typingBubble}>
              <div
                className={styles.typingDots}
                aria-label="Assistant is typing"
              >
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <div className={styles.composerWrap}>
        <p id="composer-hint" className={styles.promptHint}>
          First message: <strong>venue</strong> + <strong>day</strong>. Short
          follow-ups stay in-chat; tools query Supabase fresh each turn.
        </p>
        <div className={styles.composer}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Venue + calendar day (e.g. City Pickle May 15…)"
            rows={2}
            disabled={loading}
            aria-label="Message"
            aria-describedby="composer-hint"
          />
          <button
            type="button"
            className={styles.sendBtn}
            onClick={() => void send()}
            disabled={loading || !input.trim()}
            aria-label="Send message"
          >
            <svg
              className={styles.sendIcon}
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
