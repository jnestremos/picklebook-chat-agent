'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './chat.module.css';

type Props = {
  open: boolean;
  onSave: (apiKey: string) => void;
};

export function ApiKeyDialog({ open, onSave }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue('');
    setError(null);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('API key is required.');
      return;
    }
    onSave(trimmed);
  };

  return (
    <div className={styles.apiKeyOverlay} role="presentation">
      <div
        className={styles.apiKeyDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="api-key-dialog-title"
        aria-describedby="api-key-dialog-desc"
      >
        <h2 id="api-key-dialog-title" className={styles.apiKeyTitle}>
          API key required
        </h2>
        <p id="api-key-dialog-desc" className={styles.apiKeyDesc}>
          Enter your LLM API key to use the chat. It is stored in a cookie on this
          device for one week.
        </p>
        <form className={styles.apiKeyForm} onSubmit={submit}>
          <label className={styles.apiKeyLabel} htmlFor="api-key-input">
            API key
          </label>
          <input
            ref={inputRef}
            id="api-key-input"
            className={styles.apiKeyInput}
            type="password"
            name="apiKey"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder="sk-… or your provider key"
            autoComplete="off"
            required
          />
          {error ? <p className={styles.apiKeyError}>{error}</p> : null}
          <button type="submit" className={styles.apiKeySubmit}>
            Continue
          </button>
        </form>
      </div>
    </div>
  );
}
