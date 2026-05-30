'use client';

import { useEffect, useState } from 'react';
import styles from './chat.module.css';

type Props = {
  open: boolean;
  error?: string | null;
  onSave: (key: string) => void;
};

export function AccessKeyDialog({ open, error, onSave }: Props) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key) return;
    onSave(key);
  };

  return (
    <div className={styles.apiKeyOverlay} role="dialog" aria-modal="true" aria-labelledby="access-key-title">
      <div className={styles.apiKeyDialog}>
        <h2 id="access-key-title" className={styles.apiKeyTitle}>
          Enter access key
        </h2>
        <p className={styles.apiKeyDesc}>
          This chat is protected. Enter the access key to continue. It is stored
          in your browser and sent with each request.
        </p>
        <form className={styles.apiKeyForm} onSubmit={submit}>
          <label className={styles.apiKeyLabel} htmlFor="access-key-input">
            Access key
          </label>
          <input
            id="access-key-input"
            className={styles.apiKeyInput}
            type="password"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="••••••••••••"
          />
          {error ? <p className={styles.apiKeyError}>{error}</p> : null}
          <button type="submit" className={styles.apiKeySubmit} disabled={!value.trim()}>
            Unlock chat
          </button>
        </form>
      </div>
    </div>
  );
}
