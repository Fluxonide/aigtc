import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getProviderById } from "../registry.ts";

const verboseModels = `opencode/gpt-5-nano
{
  "name": "GPT-5 Nano",
  "variants": {
    "none": {},
    "low": {},
    "medium": {},
    "high": {},
    "xhigh": {},
    "max": {}
  }
}
anthropic/claude-haiku
{
  "name": "Claude Haiku",
  "variants": {}
}
`;

describe("parseOpenCodeModelsVerbose", () => {
  it("flattens runtime variants using # and keeps base models without variants", async () => {
    const { parseOpenCodeModelsVerbose } = await import("./opencode.ts");

    expect(parseOpenCodeModelsVerbose(verboseModels)).toEqual([
      { id: "opencode/gpt-5-nano#none", name: "GPT-5 Nano (none)" },
      { id: "opencode/gpt-5-nano#low", name: "GPT-5 Nano (low)" },
      { id: "opencode/gpt-5-nano#medium", name: "GPT-5 Nano (medium)" },
      { id: "opencode/gpt-5-nano#high", name: "GPT-5 Nano (high)" },
      { id: "opencode/gpt-5-nano#xhigh", name: "GPT-5 Nano (xhigh)" },
      { id: "opencode/gpt-5-nano#max", name: "GPT-5 Nano (max)" },
      { id: "anthropic/claude-haiku", name: "Claude Haiku" },
    ]);
  });

  it("parses plain model list without metadata blocks", async () => {
    const { parseOpenCodeModels } = await import("./opencode.ts");
    const output = "opencode/nemotron-3.5-lightning-free\nopencode/space-bunny-free\n";
    expect(parseOpenCodeModels(output)).toEqual([
      { id: "opencode/nemotron-3.5-lightning-free", name: "opencode/nemotron-3.5-lightning-free" },
      { id: "opencode/space-bunny-free", name: "opencode/space-bunny-free" },
    ]);
  });
});

describe("parseOpenCodeJsonText", () => {
  it("concatenates text events and ignores non-text events", async () => {
    const { parseOpenCodeJsonText } = await import("./opencode.ts");
    const output = [
      JSON.stringify({ type: "start" }),
      JSON.stringify({ type: "text", part: { text: "feat: add" } }),
      JSON.stringify({ type: "text", part: { text: " provider" } }),
    ].join("\n");

    expect(parseOpenCodeJsonText(output)).toBe("feat: add provider");
  });

  it("throws error message from error event if no text output", async () => {
    const { parseOpenCodeJsonText } = await import("./opencode.ts");
    const output = JSON.stringify({
      type: "error",
      error: { message: "Model quota exceeded" },
    });

    expect(() => parseOpenCodeJsonText(output)).toThrow("Model quota exceeded");
  });
});

describe("opencodeAdapter.invoke", () => {
  let spawnCalls: { cmd: string[] }[] = [];
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    spawnCalls = [];
    originalSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[]) => {
      spawnCalls.push({ cmd });
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ type: "text", part: { text: "feat: opencode" } }),
              ),
            );
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
      };
    };
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  it("invokes opencode run with model and combined prompt", async () => {
    const { opencodeAdapter } = await import("./opencode.ts");

    const result = await opencodeAdapter.invoke({
      model: "opencode/gpt-5-nano#low",
      system: "system rules",
      prompt: "diff context",
    });

    expect(result).toBe("feat: opencode");
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toEqual([
      "opencode",
      "run",
      "--model",
      "opencode/gpt-5-nano#low",
      "--format",
      "json",
      "system rules\n\ndiff context",
    ]);
  });
});

describe("opencodeAdapter.fetchModels", () => {
  let spawnCalls: { cmd: string[] }[] = [];
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    spawnCalls = [];
    originalSpawn = Bun.spawn;
    (Bun as any).spawn = (cmd: string[]) => {
      spawnCalls.push({ cmd });
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("opencode/nemotron-3.5-lightning-free\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exited: Promise.resolve(0),
      };
    };
  });

  afterEach(() => {
    (Bun as any).spawn = originalSpawn;
  });

  it("calls opencode models without --verbose", async () => {
    const { opencodeAdapter } = await import("./opencode.ts");

    const models = await opencodeAdapter.fetchModels!();
    expect(models).toEqual([
      { id: "opencode/nemotron-3.5-lightning-free", name: "opencode/nemotron-3.5-lightning-free" },
    ]);
    expect(spawnCalls[0]!.cmd).toEqual(["opencode", "models"]);
  });
});

describe("opencode registry", () => {
  it("registers OpenCode as a live-model CLI provider", () => {
    expect(getProviderById("opencode")).toMatchObject({
      id: "opencode",
      name: "OpenCode",
      mode: "cli",
      binary: "opencode",
      dynamicModels: true,
    });
  });
});
