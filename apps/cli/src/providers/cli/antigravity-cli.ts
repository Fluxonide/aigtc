import type { CLIProviderAdapter, InvokeOptions, APIModelDefinition } from "../types.ts";

/**
 * Parse output from `agy models` into model definitions.
 * Example line: "gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)"
 */
export function parseAntigravityModels(output: string): APIModelDefinition[] {
  const models: APIModelDefinition[] = [];
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes("Fetching available models")) continue;
    const match = trimmed.match(/^([a-z0-9_.-]+)\s{2,}(.+)$/i);
    if (match?.[1] && match[2]) {
      models.push({
        id: match[1].trim(),
        name: match[2].trim(),
        provider: "google",
      });
    }
  }
  return models;
}

/**
 * Antigravity CLI adapter.
 * Handles invocation of the `agy` CLI tool.
 *
 * CLI Pattern:
 *   agy --model <model> --output-format text --dangerously-skip-permissions --disable-slash-commands -p "<combined-prompt>"
 *
 * - `-p <prompt>` runs in non-interactive (headless) mode with the given prompt
 * - `--output-format text` ensures clean text output
 * - `--dangerously-skip-permissions` avoids tool permission confirmation prompts
 * - `--disable-slash-commands` disables slash command and skill expansion
 */
export const antigravityCliAdapter: CLIProviderAdapter = {
  providerId: "antigravity-cli",
  mode: "cli",
  binary: "agy",

  async invoke({ model, system, prompt }: InvokeOptions): Promise<string> {
    const combinedPrompt = system ? `${system}\n\n${prompt}` : prompt;

    const proc = Bun.spawn(
      [
        "agy",
        "--model",
        model,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
        "-p",
        combinedPrompt,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const errorMessage = stderr.trim() || stdout.trim() || "Unknown error";
      throw new Error(`Antigravity CLI error (exit code ${exitCode}):\n${errorMessage}`);
    }

    return stdout;
  },

  async checkAvailable(): Promise<boolean> {
    return !!(await Bun.which("agy"));
  },

  async fetchModels(): Promise<APIModelDefinition[]> {
    try {
      const proc = Bun.spawn(["agy", "models"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) return [];
      return parseAntigravityModels(stdout || stderr);
    } catch {
      return [];
    }
  },
};
