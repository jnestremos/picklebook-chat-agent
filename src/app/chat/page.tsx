'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantMessageBody } from './assistant-message';
import { AccessKeyDialog } from './access-key-dialog';
import { CHAT_ACCESS_KEY_HEADER } from '@/lib/chat/access-key';
import {
  clearAccessKeyCookie,
  getAccessKeyCookie,
  setAccessKeyCookie,
} from '@/lib/chat/access-key-cookie';
import styles from './chat.module.css';

type ChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  sentAt: number;
};

function formatClock(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ts));
}

function isAssistantError(text: string): boolean {
  return text.startsWith('Request failed');
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [accessKey, setAccessKey] = useState<string | null>(null);
  const [accessKeyChecked, setAccessKeyChecked] = useState(false);
  const [accessKeyError, setAccessKeyError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    setAccessKey(getAccessKeyCookie());
    setAccessKeyChecked(true);
  }, []);

  const chatUnlocked = accessKey !== null;

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, loading]);

  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 96;
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || !accessKey) return;

    const now = Date.now();
    setInput('');
    stickToBottomRef.current = true;
    setMessages((m) => [...m, { role: 'user', text, sentAt: now }]);
    setLoading(true);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [CHAT_ACCESS_KEY_HEADER]: accessKey,
        },
        body: JSON.stringify({ message: text }),
      });

      const json: Record<string, unknown> = await res.json().catch(() => ({}));
      const replyAt = Date.now();

      if (res.status === 401) {
        clearAccessKeyCookie();
        setAccessKey(null);
        setAccessKeyError(
          typeof json.error === 'string' ? json.error : 'Invalid access key.',
        );
        setMessages((m) => m.filter((mm) => mm.sentAt !== now));
        setInput(text);
        return;
      }

      if (!res.ok) {
        const detail =
          typeof json.error === 'string'
            ? json.error
            : JSON.stringify(json, null, 2);
        setMessages((m) => [
          ...m,
          {
            role: 'assistant',
            text: `Request failed (${res.status})\n${detail}`,
            sentAt: replyAt,
          },
        ]);
        return;
      }

      const msg =
        typeof json.message === 'string'
          ? json.message
          : JSON.stringify(json, null, 2);

      setMessages((m) => [
        ...m,
        { role: 'assistant', text: msg, sentAt: replyAt },
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
  }, [input, loading, accessKey]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={styles.wrap}>
      <AccessKeyDialog
        open={accessKeyChecked && !chatUnlocked}
        error={accessKeyError}
        onSave={(key) => {
          setAccessKeyCookie(key);
          setAccessKey(key);
          setAccessKeyError(null);
        }}
      />

      <div
        className={`${styles.chatMain} ${chatUnlocked ? '' : styles.chatLocked}`.trim()}
        aria-hidden={!chatUnlocked}
      >
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.headerBrand}>
              <h1 className={styles.headerTitle}>Messages</h1>
              <p className={styles.headerSubtitle}>
                Ask about court availability — answers come from the live court
                service.
              </p>
            </div>
            <a className={styles.headerHome} href="/">
              Home
            </a>
          </div>
        </header>

        <div className={styles.thread} ref={threadRef} onScroll={onThreadScroll}>
          {messages.length === 0 && !loading ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon} aria-hidden>
                💬
              </div>
              <h2 className={styles.emptyTitle}>Hi there</h2>
              <p className={styles.emptyBody}>
                Ask about pickleball court availability — say{' '}
                <strong>where</strong> and <strong>which day</strong> to check.
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
                      <AssistantMessageBody text={msg.text} />
                    )}
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
            Ask about a <strong>venue</strong> and a <strong>day</strong> to
            check availability.
          </p>
          <div className={styles.composer}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Venue + calendar day (e.g. City Pickle May 15…)"
              rows={2}
              disabled={loading || !chatUnlocked}
              aria-label="Message"
              aria-describedby="composer-hint"
            />
            <button
              type="button"
              className={styles.sendBtn}
              onClick={() => void send()}
              disabled={loading || !input.trim() || !chatUnlocked}
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
    </div>
  );
}
