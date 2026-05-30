/** Header the chat client sends so the server can gate access to /api/query. */
export const CHAT_ACCESS_KEY_HEADER = 'x-chat-access-key';

/**
 * Constant-time-ish string comparison so an attacker cannot learn the key
 * length / prefix from response timing.
 */
export function safeKeyEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
