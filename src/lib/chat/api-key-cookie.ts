export const API_KEY_COOKIE_NAME = 'pb_llm_api_key';

const ONE_WEEK_SECONDS = 7 * 24 * 60 * 60;

export function getApiKeyCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const prefix = `${API_KEY_COOKIE_NAME}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    if (!raw) return null;
    try {
      const decoded = decodeURIComponent(raw);
      return decoded.trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function setApiKeyCookie(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed) return;
  const encoded = encodeURIComponent(trimmed);
  const secure =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? '; Secure'
      : '';
  document.cookie = `${API_KEY_COOKIE_NAME}=${encoded}; Max-Age=${ONE_WEEK_SECONDS}; Path=/; SameSite=Lax${secure}`;
}
