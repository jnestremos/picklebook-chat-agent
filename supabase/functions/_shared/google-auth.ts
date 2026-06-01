import { SignJWT, importPKCS8 } from 'https://esm.sh/jose@5.9.6';

export type GoogleServiceAccount = {
  client_email: string;
  private_key: string;
};

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export function parseGoogleServiceAccount(): GoogleServiceAccount | null {
  const raw = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON')?.trim();
  if (!raw) {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  const client_email = typeof parsed.client_email === 'string' ? parsed.client_email : '';
  const private_key = typeof parsed.private_key === 'string' ? parsed.private_key : '';
  if (!client_email || !private_key) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON must include client_email and private_key',
    );
  }

  return { client_email, private_key };
}

export async function getGoogleAccessToken(
  serviceAccount: GoogleServiceAccount,
): Promise<string> {
  const key = await importPKCS8(
    serviceAccount.private_key.replace(/\\n/g, '\n'),
    'RS256',
  );

  const assertion = await new SignJWT({ scope: SHEETS_SCOPE })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(serviceAccount.client_email)
    .setAudience('https://oauth2.googleapis.com/token')
    .setExpirationTime('1h')
    .sign(key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed ${res.status}: ${text.slice(0, 300)}`);
  }

  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error('Google token response missing access_token');
  }

  return body.access_token;
}
