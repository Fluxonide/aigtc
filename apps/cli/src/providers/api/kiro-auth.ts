import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { log, spinner } from "@clack/prompts";
import pc from "picocolors";

// ==============================================================================
// KIRO AUTH — Device Code OAuth & Credential Management
// ==============================================================================

/**
 * Kiro authentication details stored after successful OAuth.
 */
export interface KiroAuthDetails {
  refresh: string;
  access: string;
  expires: number;
  authMethod: "idc" | "desktop";
  region: string;
  oidcRegion?: string;
  clientId?: string;
  clientSecret?: string;
  email?: string;
  profileArn?: string;
}

/** Cached auth for the current session. */
let cachedAuth: KiroAuthDetails | null = null;

// ==============================================================================
// KIRO CLI DB PATH
// ==============================================================================

function getCliDbPath(): string {
  const override = process.env.KIROCLI_DB_PATH;
  if (override) return override;
  const p = platform();
  if (p === "win32")
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "kiro-cli",
      "data.sqlite3",
    );
  if (p === "darwin")
    return join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  return join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
}

// ==============================================================================
// READ FROM KIRO CLI DATABASE
// ==============================================================================

interface KiroCliToken {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  authMethod: "idc" | "desktop";
  region: string;
  clientId?: string;
  clientSecret?: string;
  profileArn?: string;
}

function safeJsonParse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeExpiresAt(input: unknown): number {
  if (typeof input === "number") {
    return input < 10_000_000_000 ? input * 1000 : input;
  }
  if (typeof input === "string" && input.trim()) {
    const t = new Date(input).getTime();
    if (!Number.isNaN(t) && t > 0) return t;
    const n = Number(input);
    if (Number.isFinite(n) && n > 0) return normalizeExpiresAt(n);
  }
  return 0;
}

/**
 * Recursively search an object for clientId/clientSecret pairs.
 */
function findClientCreds(input: unknown): { clientId?: string; clientSecret?: string } {
  const root = input as Record<string, unknown>;
  if (!root || typeof root !== "object") return {};

  const stack: unknown[] = [root];
  const visited = new Set<unknown>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (visited.has(cur)) continue;
    visited.add(cur);

    const obj = cur as Record<string, unknown>;
    const clientId = (obj.client_id || obj.clientId) as string | undefined;
    const clientSecret = (obj.client_secret || obj.clientSecret) as string | undefined;
    if (typeof clientId === "string" && typeof clientSecret === "string") {
      if (clientId && clientSecret) return { clientId, clientSecret };
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
      continue;
    }
    for (const v of Object.values(obj)) stack.push(v);
  }
  return {};
}

/**
 * Try to read valid Kiro credentials from the installed Kiro CLI's SQLite DB.
 */
async function readFromKiroCli(): Promise<KiroCliToken | null> {
  const dbPath = getCliDbPath();
  if (!existsSync(dbPath)) return null;

  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    db.run("PRAGMA busy_timeout = 5000");

    const rows = db.prepare("SELECT key, value FROM auth_kv").all() as Array<{
      key: string;
      value: string;
    }>;

    // Find device registration for client creds
    const deviceRegRow = rows.find(
      (r) => typeof r?.key === "string" && r.key.includes("device-registration"),
    );
    const deviceReg = safeJsonParse(deviceRegRow?.value);
    const regCreds = deviceReg ? findClientCreds(deviceReg) : {};

    // Find active profile ARN
    let activeProfileArn: string | undefined;
    try {
      const stateRow = db
        .prepare("SELECT value FROM state WHERE key = ?")
        .get("api.codewhisperer.profile") as { value: string } | undefined;
      const parsed = safeJsonParse(stateRow?.value);
      const arn =
        (parsed?.arn as string) ||
        (parsed?.profileArn as string) ||
        (parsed?.profile_arn as string);
      if (typeof arn === "string" && arn.trim()) activeProfileArn = arn.trim();
    } catch {
      // Ignore state read failures
    }

    for (const row of rows) {
      if (!row.key.includes(":token")) continue;

      const data = safeJsonParse(row.value);
      if (!data) continue;

      const isIdc = row.key.includes("odic");
      const authMethod = isIdc ? "idc" : "desktop";
      const region = (data.region as string) || "us-east-1";

      const accessToken = ((data.access_token || data.accessToken) as string) || "";
      const refreshToken = (data.refresh_token || data.refreshToken) as string;
      if (!refreshToken) continue;

      const clientId =
        (data.client_id as string) ||
        (data.clientId as string) ||
        (isIdc ? regCreds.clientId : undefined);
      const clientSecret =
        (data.client_secret as string) ||
        (data.clientSecret as string) ||
        (isIdc ? regCreds.clientSecret : undefined);

      if (authMethod === "idc" && (!clientId || !clientSecret)) continue;

      const expiresAt =
        normalizeExpiresAt(data.expires_at ?? data.expiresAt) || Date.now() + 3600000;

      let profileArn = (data.profile_arn || data.profileArn) as string | undefined;
      if (!profileArn && isIdc) profileArn = activeProfileArn;

      db.close();

      return {
        refreshToken,
        accessToken,
        expiresAt,
        authMethod: authMethod as "idc" | "desktop",
        region,
        clientId,
        clientSecret,
        profileArn,
      };
    }

    db.close();
  } catch {
    // SQLite read failed — fall through to OAuth flow
  }

  return null;
}

// ==============================================================================
// ENCODE / DECODE REFRESH TOKEN
// ==============================================================================

interface RefreshParts {
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  authMethod: "idc" | "desktop";
}

function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split("|");
  if (parts.length < 2) return { refreshToken: parts[0]!, authMethod: "desktop" };
  const refreshToken = parts[0]!;
  const authMethod = parts[parts.length - 1] as "idc" | "desktop";
  if (authMethod === "idc")
    return { refreshToken, clientId: parts[1], clientSecret: parts[2], authMethod: "idc" };
  return { refreshToken, authMethod: "desktop" };
}

function encodeRefreshToken(parts: RefreshParts): string {
  if (parts.authMethod === "idc") {
    if (!parts.clientId || !parts.clientSecret) throw new Error("Missing credentials");
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`;
  }
  return `${parts.refreshToken}|desktop`;
}

// ==============================================================================
// TOKEN REFRESH
// ==============================================================================

/**
 * Refresh an expired Kiro access token using the stored refresh token.
 */
export async function refreshKiroToken(auth: KiroAuthDetails): Promise<KiroAuthDetails> {
  const p = decodeRefreshToken(auth.refresh);
  const isIdc = auth.authMethod === "idc";
  const oidcRegion = auth.oidcRegion || auth.region;
  const url = isIdc
    ? `https://oidc.${oidcRegion}.amazonaws.com/token`
    : `https://prod.${auth.region}.auth.desktop.kiro.dev/refreshToken`;

  if (isIdc && (!p.clientId || !p.clientSecret)) {
    throw new Error("Kiro IDC refresh failed: missing client credentials.");
  }

  const requestBody = isIdc
    ? {
        refreshToken: p.refreshToken,
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        grantType: "refresh_token",
      }
    : { refreshToken: p.refreshToken };

  const ua = isIdc
    ? `aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE`
    : `aws-sdk-js/3.0.0 KiroIDE-0.1.0 os/macos lang/js md/nodejs/18.0.0`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "amz-sdk-request": "attempt=1; max=1",
      "x-amzn-kiro-agent-mode": "vibe",
      "user-agent": ua,
      Connection: "close",
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Kiro token refresh failed (${res.status}): ${txt.slice(0, 300)}`);
  }

  const d = (await res.json()) as Record<string, unknown>;
  const accessToken = (d.access_token || d.accessToken) as string;
  if (!accessToken) throw new Error("Kiro token refresh: no access token in response.");

  const updatedParts: RefreshParts = {
    refreshToken: ((d.refresh_token || d.refreshToken) as string) || p.refreshToken,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    authMethod: auth.authMethod,
  };

  const newAuth: KiroAuthDetails = {
    refresh: encodeRefreshToken(updatedParts),
    access: accessToken,
    expires: Date.now() + ((d.expires_in || d.expiresIn || 3600) as number) * 1000,
    authMethod: auth.authMethod,
    region: auth.region,
    oidcRegion: auth.oidcRegion,
    profileArn: auth.profileArn,
    clientId: auth.clientId,
    clientSecret: auth.clientSecret,
    email: auth.email,
  };

  cachedAuth = newAuth;
  return newAuth;
}

// ==============================================================================
// OAUTH DEVICE CODE FLOW
// ==============================================================================

const SSO_OIDC_ENDPOINT = "https://oidc.us-east-1.amazonaws.com";
const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];

/**
 * Run the OAuth device code flow for Kiro / AWS Builder ID authentication.
 * Opens a browser URL for the user to authorize, then polls for the token.
 */
async function runOAuthDeviceCodeFlow(): Promise<KiroAuthDetails> {
  const region = "us-east-1";

  // Step 1: Register OIDC client
  const registerRes = await fetch(`${SSO_OIDC_ENDPOINT}/client/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "aigtc-cli" },
    body: JSON.stringify({
      clientName: "aigtc CLI",
      clientType: "public",
      scopes: SCOPES,
      grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    }),
  });

  if (!registerRes.ok) {
    const errText = await registerRes.text().catch(() => "");
    throw new Error(`Kiro client registration failed (${registerRes.status}): ${errText}`);
  }

  const registerData = (await registerRes.json()) as Record<string, string>;
  const { clientId, clientSecret } = registerData;
  if (!clientId || !clientSecret) {
    throw new Error("Kiro client registration: missing clientId or clientSecret.");
  }

  // Step 2: Start device authorization
  const deviceRes = await fetch(`${SSO_OIDC_ENDPOINT}/device_authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "aigtc-cli" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      startUrl: BUILDER_ID_START_URL,
    }),
  });

  if (!deviceRes.ok) {
    const errText = await deviceRes.text().catch(() => "");
    throw new Error(`Kiro device authorization failed (${deviceRes.status}): ${errText}`);
  }

  const deviceData = (await deviceRes.json()) as Record<string, unknown>;
  const {
    verificationUri,
    verificationUriComplete,
    userCode,
    deviceCode,
    interval = 5,
    expiresIn = 600,
  } = deviceData as Record<string, string | number>;

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Kiro device authorization: missing required fields.");
  }

  // Step 3: Show user the verification URL and code
  log.info("");
  log.info(pc.bold("🔐 Kiro / AWS Builder ID Authentication"));
  log.info("");
  log.info(`  Open this URL in your browser:`);
  log.info(`  ${pc.cyan(verificationUriComplete as string || verificationUri as string)}`);
  log.info("");
  log.info(`  Your code: ${pc.bold(pc.yellow(userCode as string))}`);
  log.info("");

  // Try to open the URL in the default browser
  try {
    const openCmd =
      process.platform === "win32"
        ? ["cmd", "/c", "start", (verificationUriComplete || verificationUri) as string]
        : process.platform === "darwin"
          ? ["open", (verificationUriComplete || verificationUri) as string]
          : ["xdg-open", (verificationUriComplete || verificationUri) as string];

    Bun.spawn(openCmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Browser open is best-effort
  }

  // Step 4: Poll for token
  const s = spinner();
  s.start("Waiting for authorization...");

  const maxAttempts = Math.floor((expiresIn as number) / (interval as number));
  let currentInterval = (interval as number) * 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, currentInterval));

    try {
      const tokenRes = await fetch(`${SSO_OIDC_ENDPOINT}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "aigtc-cli" },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode,
          grantType: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });

      const tokenText = await tokenRes.text().catch(() => "");
      let tokenData: Record<string, unknown> = {};
      if (tokenText) {
        try {
          tokenData = JSON.parse(tokenText);
        } catch {
          continue;
        }
      }

      if (tokenData.error) {
        const errorType = tokenData.error as string;
        if (errorType === "authorization_pending") continue;
        if (errorType === "slow_down") {
          currentInterval += 5000;
          continue;
        }
        if (errorType === "expired_token") {
          s.stop(pc.red("Authorization expired."));
          throw new Error("Device code expired. Please try again.");
        }
        if (errorType === "access_denied") {
          s.stop(pc.red("Authorization denied."));
          throw new Error("Authorization was denied.");
        }
        s.stop(pc.red("Authorization failed."));
        throw new Error(`Token polling failed: ${errorType}`);
      }

      const accessToken = (tokenData.access_token || tokenData.accessToken) as string;
      const refreshToken = (tokenData.refresh_token || tokenData.refreshToken) as string;
      const tokenExpiresIn = (tokenData.expires_in || tokenData.expiresIn || 3600) as number;

      if (accessToken && refreshToken) {
        s.stop(pc.green("Authenticated successfully!"));

        const parts: RefreshParts = {
          refreshToken,
          clientId,
          clientSecret,
          authMethod: "idc",
        };

        return {
          refresh: encodeRefreshToken(parts),
          access: accessToken,
          expires: Date.now() + tokenExpiresIn * 1000,
          authMethod: "idc",
          region,
          clientId,
          clientSecret,
          email: "builder-id@aws.amazon.com",
        };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("expired") ||
          error.message.includes("denied") ||
          error.message.includes("failed"))
      ) {
        throw error;
      }
    }
  }

  s.stop(pc.red("Authorization timed out."));
  throw new Error("Token polling timed out. Please try again.");
}

// ==============================================================================
// PUBLIC API
// ==============================================================================

/**
 * Get valid Kiro authentication details.
 * Tries: 1) cached auth → 2) Kiro CLI DB → 3) OAuth device code flow.
 */
export async function getKiroAuth(): Promise<KiroAuthDetails> {
  // 1. Return cached auth if still valid
  if (cachedAuth && Date.now() < cachedAuth.expires - 60_000) {
    return cachedAuth;
  }

  // If cached auth exists but expired, try refreshing it
  if (cachedAuth) {
    try {
      cachedAuth = await refreshKiroToken(cachedAuth);
      return cachedAuth;
    } catch {
      cachedAuth = null;
    }
  }

  // 2. Try reading from Kiro CLI SQLite database
  const cliToken = await readFromKiroCli();
  if (cliToken) {
    const parts: RefreshParts = {
      refreshToken: cliToken.refreshToken,
      clientId: cliToken.clientId,
      clientSecret: cliToken.clientSecret,
      authMethod: cliToken.authMethod,
    };

    const auth: KiroAuthDetails = {
      refresh: encodeRefreshToken(parts),
      access: cliToken.accessToken,
      expires: cliToken.expiresAt,
      authMethod: cliToken.authMethod,
      region: cliToken.region,
      clientId: cliToken.clientId,
      clientSecret: cliToken.clientSecret,
      profileArn: cliToken.profileArn,
    };

    // If the access token is expired, refresh it
    if (Date.now() >= auth.expires - 120_000) {
      try {
        cachedAuth = await refreshKiroToken(auth);
        return cachedAuth;
      } catch {
        // Refresh failed — fall through to OAuth
      }
    } else {
      cachedAuth = auth;
      return auth;
    }
  }

  // 3. Run OAuth device code flow
  cachedAuth = await runOAuthDeviceCodeFlow();
  return cachedAuth;
}

/**
 * Clear cached Kiro auth (used when re-authenticating).
 */
export function clearKiroAuth(): void {
  cachedAuth = null;
}
