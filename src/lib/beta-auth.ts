export const BETA_COOKIE_NAME = "demobro_beta_access";

const TOKEN_MESSAGE = "demobro-private-beta-v1";

export function betaGateEnabled(): boolean {
  return process.env.BETA_GATE_ENABLED === "true";
}

export function betaPassword(): string {
  return process.env.BETA_PASSWORD?.trim() ?? "";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function createBetaAccessToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(TOKEN_MESSAGE),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

function equalLengthConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function validBetaPassword(candidate: string): Promise<boolean> {
  const configured = betaPassword();
  if (!configured || !candidate) return false;
  const [candidateToken, configuredToken] = await Promise.all([
    createBetaAccessToken(candidate),
    createBetaAccessToken(configured),
  ]);
  return equalLengthConstantTime(candidateToken, configuredToken);
}

export async function validBetaCookie(cookieValue?: string): Promise<boolean> {
  const configured = betaPassword();
  if (!configured || !cookieValue) return false;
  const expected = await createBetaAccessToken(configured);
  return equalLengthConstantTime(cookieValue, expected);
}
