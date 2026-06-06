import type { APIProviderAdapter, APIModelDefinition, InvokeOptions } from "../types.ts";
import {
  createTimeoutController,
  COMMON_HEADERS,
} from "./utils.ts";
import {
  getKiroAuth,
  refreshKiroToken,
  type KiroAuthDetails,
} from "./kiro-auth.ts";

// ==============================================================================
// KIRO API ADAPTER
// ==============================================================================

/**
 * Kiro uses the AWS CodeWhisperer streaming API behind AWS Builder ID / IAM
 * Identity Center authentication. Unlike other API providers that use a simple
 * API key, Kiro authenticates via OAuth device code flow and reads credentials
 * from the Kiro CLI's local SQLite database.
 *
 * Reference: https://github.com/tickernelz/opencode-kiro-auth/
 */

const KIRO_USER_AGENT = "aigtc-cli";
const KIRO_SDK_VERSION = "3.738.0";

/** Models available through Kiro's free tier / Builder ID. */
const KIRO_MODELS: APIModelDefinition[] = [
  { id: "auto", name: "Auto (Kiro picks best)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
];

/** Map aigtc model IDs to Kiro's internal model identifiers. */
const MODEL_MAPPING: Record<string, string> = {
  auto: "auto",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4": "claude-sonnet-4",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-7": "claude-opus-4.7",
};

function resolveKiroModel(model: string): string {
  return MODEL_MAPPING[model] ?? model;
}

/**
 * Build a CodeWhisperer generateAssistantResponse request body.
 * Simplified version for commit-message generation (single-turn, no tools).
 */
function buildKiroRequestBody(
  system: string,
  prompt: string,
  model: string,
  conversationId: string,
  profileArn?: string,
) {
  const resolved = resolveKiroModel(model);

  const request: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: {
        userInputMessage: {
          content: `${system}\n\n${prompt}`,
          modelId: resolved,
          origin: "AI_EDITOR",
        },
      },
    },
  };

  if (profileArn) {
    request.profileArn = profileArn;
  }

  return request;
}

/**
 * Extract a balanced JSON object string starting at `jsonStart`.
 * Uses brace-counting with proper string/escape handling.
 */
function extractJsonObject(buffer: string, jsonStart: number): string | null {
  let braceCount = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = jsonStart; i < buffer.length; i++) {
    const char = buffer[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          return buffer.substring(jsonStart, i + 1);
        }
      }
    }
  }
  return null;
}

/**
 * Parse the AWS event stream buffer by scanning for embedded JSON objects.
 *
 * The CodeWhisperer API returns `application/vnd.amazon.eventstream` binary
 * data. JSON payloads like `{"content":"..."}` are embedded within binary
 * frames. Rather than parsing the binary frame headers (which are unreliable
 * with plain fetch), we scan the raw text representation for JSON patterns —
 * matching the approach used by opencode-kiro-auth.
 */
function parseAwsEventStreamBuffer(buffer: string): string {
  const chunks: string[] = [];
  let searchStart = 0;

  while (searchStart < buffer.length) {
    // Look for the next JSON object that starts with {"content":
    const contentStart = buffer.indexOf('{"content":', searchStart);
    if (contentStart < 0) break;

    const jsonStr = extractJsonObject(buffer, contentStart);
    if (!jsonStr) break;

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      // Skip followup prompts — we only want content chunks
      if (parsed.content !== undefined && !parsed.followupPrompt) {
        chunks.push(parsed.content as string);
      }
    } catch {
      // Malformed JSON — skip and continue
    }

    searchStart = contentStart + (jsonStr?.length ?? 1);
  }

  return chunks.join("");
}

/**
 * Parse the Kiro API response.
 *
 * The CodeWhisperer API always returns an AWS event stream, even when
 * Accept: application/json is set. We always read the raw bytes and scan
 * for JSON content chunks — never call response.json().
 */
async function parseKiroStreamResponse(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  return parseAwsEventStreamBuffer(rawText);
}

/**
 * Kiro API adapter.
 *
 * Authentication flow:
 * 1. Try reading stored credentials from the Kiro CLI SQLite database.
 * 2. If no stored credentials, initiate AWS Builder ID OAuth device code flow.
 * 3. Refresh access tokens automatically when expired.
 */
export const kiroAdapter: APIProviderAdapter = {
  providerId: "kiro",
  mode: "api",

  async invoke({ model, system, prompt }: InvokeOptions): Promise<string> {
    let auth = await getKiroAuth();
    if (!auth) {
      throw new Error("Kiro authentication failed. Run 'aigtc configure' to set up Kiro.");
    }

    // Refresh token if expired (2 min buffer)
    if (Date.now() >= auth.expires - 120_000) {
      auth = await refreshKiroToken(auth);
    }

    const conversationId = crypto.randomUUID();
    const region = auth.region;
    const url = `https://q.${region}.amazonaws.com/generateAssistantResponse`;

    const requestBody = buildKiroRequestBody(
      system,
      prompt,
      model,
      conversationId,
      auth.profileArn,
    );

    const osName =
      process.platform === "win32"
        ? `windows#${Bun.version}`
        : process.platform === "darwin"
          ? `macos#${Bun.version}`
          : `${process.platform}#${Bun.version}`;

    const ua = `aws-sdk-js/${KIRO_SDK_VERSION} ua/2.1 os/${osName} lang/js md/bun#${Bun.version} api/codewhisperer#${KIRO_SDK_VERSION} m/E ${KIRO_USER_AGENT}`;

    const { controller, cleanup } = createTimeoutController(120_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${auth.access}`,
          "amz-sdk-invocation-id": crypto.randomUUID(),
          "amz-sdk-request": "attempt=1; max=1",
          "x-amzn-kiro-agent-mode": "vibe",
          "x-amz-user-agent": `aws-sdk-js/${KIRO_SDK_VERSION} KiroIDE`,
          "user-agent": ua,
          Connection: "close",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `Kiro API error (${response.status}): ${errorText.slice(0, 500) || response.statusText}`,
        );
      }

      const text = await parseKiroStreamResponse(response);
      if (!text) {
        throw new Error(
          "Kiro returned an empty response. The model may not have generated any content.",
        );
      }

      return text;
    } finally {
      cleanup();
    }
  },

  async checkAvailable(): Promise<boolean> {
    try {
      const auth = await getKiroAuth({ noPrompt: true });
      return auth !== null;
    } catch {
      return false;
    }
  },

  async fetchModels(_apiKey?: string): Promise<APIModelDefinition[]> {
    // Kiro models are fixed (not dynamically fetched from an API).
    // Validate that we have valid auth before returning the list.
    const auth = await getKiroAuth();
    if (!auth) {
      throw new Error("Kiro authentication failed. Run 'aigtc configure' to set up Kiro.");
    }
    return KIRO_MODELS;
  },
};

