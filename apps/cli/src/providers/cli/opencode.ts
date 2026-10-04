import type { CLIProviderAdapter, InvokeOptions } from "../types.ts";
import { readProcessOutput, type DynamicCLIModel } from "./dynamic.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonBlock(
  lines: string[],
  startIndex: number,
): { json: string; nextIndex: number } | null {
  const parts: string[] = [];
  let depth = 0;
  let started = false;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!started && !line.trim()) continue;
    if (!started && !line.trim().startsWith("{")) return null;

    started = true;
    parts.push(line);

    for (const char of line) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
    }

    if (started && depth <= 0) {
      return { json: parts.join("\n"), nextIndex: i + 1 };
    }
  }

  return null;
}

export function parseOpenCodeModels(output: string): DynamicCLIModel[] {
  const lines = output.split(/\r?\n/);
  const models: DynamicCLIModel[] = [];

  for (let i = 0; i < lines.length; ) {
    const baseId = (lines[i] ?? "").trim();
    i += 1;

    if (!baseId || baseId.startsWith("{") || baseId.startsWith("[") || baseId.startsWith("#"))
      continue;

    const block = readJsonBlock(lines, i);
    if (block) {
      i = block.nextIndex;

      let metadata: unknown;
      try {
        metadata = JSON.parse(block.json);
      } catch {
        metadata = null;
      }

      if (isPlainObject(metadata)) {
        const displayName =
          typeof metadata.name === "string" && metadata.name ? metadata.name : baseId;
        const variants = isPlainObject(metadata.variants) ? Object.keys(metadata.variants) : [];

        if (variants.length === 0) {
          models.push({ id: baseId, name: displayName });
        } else {
          for (const variant of variants) {
            models.push({ id: `${baseId}#${variant}`, name: `${displayName} (${variant})` });
          }
        }
        continue;
      }
    }

    models.push({ id: baseId, name: baseId });
  }

  return models;
}

export const parseOpenCodeModelsVerbose = parseOpenCodeModels;

export function parseOpenCodeJsonText(output: string): string {
  const chunks: string[] = [];
  let errorMessage: string | null = null;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const event = JSON.parse(trimmed) as unknown;
      if (!isPlainObject(event)) continue;
      if (
        event.type === "error" &&
        isPlainObject(event.error) &&
        typeof event.error.message === "string"
      ) {
        errorMessage = event.error.message;
      }
      if (event.type !== "text" || !isPlainObject(event.part)) continue;
      const text = event.part.text;
      if (typeof text === "string") chunks.push(text);
    } catch {
      // Ignore non-JSON progress lines. OpenCode --format json emits NDJSON text events.
    }
  }

  const result = chunks.join("");
  if (!result && errorMessage) {
    throw new Error(errorMessage);
  }
  return result;
}

export const opencodeAdapter: CLIProviderAdapter = {
  providerId: "opencode",
  mode: "cli",
  binary: "opencode",

  async invoke({ model, system, prompt }: InvokeOptions): Promise<string> {
    const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
    const args = ["opencode", "run", "--model", model, "--format", "json", fullPrompt];

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const { stdout, stderr, exitCode } = await readProcessOutput(proc);
    if (exitCode !== 0) {
      const errorMessage = stderr.trim() || stdout.trim() || "Unknown error";
      throw new Error(`OpenCode CLI error (exit code ${exitCode}):\n${errorMessage}`);
    }

    return parseOpenCodeJsonText(stdout);
  },

  async checkAvailable(): Promise<boolean> {
    return !!(await Bun.which("opencode"));
  },

  async fetchModels(): Promise<DynamicCLIModel[]> {
    const proc = Bun.spawn(["opencode", "models"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const { stdout, stderr, exitCode } = await readProcessOutput(proc);
    if (exitCode !== 0) {
      const errorMessage = stderr.trim() || stdout.trim() || "Unknown error";
      throw new Error(`OpenCode model listing failed (exit code ${exitCode}): ${errorMessage}`);
    }

    const models = parseOpenCodeModels(stdout);
    if (models.length === 0) {
      throw new Error("OpenCode returned no usable models. Run `opencode models` to verify setup.");
    }

    return models;
  },
};
