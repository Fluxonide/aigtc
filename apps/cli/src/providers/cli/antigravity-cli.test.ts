import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { antigravityCliAdapter, parseAntigravityModels } from "./antigravity-cli.ts";
import { PROVIDERS } from "../registry.ts";

describe("parseAntigravityModels", () => {
  it("should parse standard agy models table output", () => {
    const rawOutput = `
⠋ Fetching available models...
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;
    const models = parseAntigravityModels(rawOutput);
    expect(models).toEqual([
      { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", provider: "google" },
      { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", provider: "google" },
      { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", provider: "google" },
      { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", provider: "google" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", provider: "google" },
      { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", provider: "google" },
    ]);
  });

  it("should handle empty or whitespace-only output", () => {
    expect(parseAntigravityModels("")).toEqual([]);
    expect(parseAntigravityModels("   \n\n  ")).toEqual([]);
  });
});

describe("antigravityCliAdapter.invoke", () => {
  let originalSpawn: typeof Bun.spawn;
  let spawnCalls: Array<{ cmd: string[]; opts?: any }>;

  beforeEach(() => {
    spawnCalls = [];
    originalSpawn = Bun.spawn;

    (Bun as any).spawn = (cmd: string[], opts: any) => {
      spawnCalls.push({ cmd, opts });
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("feat: test commit message"));
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

  it("should invoke agy with expected flags and combined prompt", async () => {
    const result = await antigravityCliAdapter.invoke({
      model: "gemini-3.7-flash-medium",
      system: "System instructions here",
      prompt: "User prompt here",
    });

    expect(result).toBe("feat: test commit message");
    expect(spawnCalls).toHaveLength(1);

    const cmd = spawnCalls[0]!.cmd;
    expect(cmd[0]).toBe("agy");
    expect(cmd).toContain("--model");
    expect(cmd).toContain("gemini-3.7-flash-medium");
    expect(cmd).toContain("--output-format");
    expect(cmd).toContain("text");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).toContain("--disable-slash-commands");
    expect(cmd).toContain("-p");

    const pIndex = cmd.indexOf("-p");
    expect(pIndex).toBeGreaterThan(-1);
    expect(cmd[pIndex + 1]).toBe("System instructions here\n\nUser prompt here");
  });

  it("should handle empty system prompt", async () => {
    await antigravityCliAdapter.invoke({
      model: "gemini-3.7-flash-medium",
      system: "",
      prompt: "User prompt only",
    });

    expect(spawnCalls).toHaveLength(1);
    const cmd = spawnCalls[0]!.cmd;
    const pIndex = cmd.indexOf("-p");
    expect(cmd[pIndex + 1]).toBe("User prompt only");
  });

  it("should throw formatted error on non-zero exit code", async () => {
    (Bun as any).spawn = () => ({
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("Model not found"));
          controller.close();
        },
      }),
      exited: Promise.resolve(1),
    });

    await expect(
      antigravityCliAdapter.invoke({
        model: "invalid-model",
        system: "sys",
        prompt: "user",
      }),
    ).rejects.toThrow("Antigravity CLI error (exit code 1):\nModel not found");
  });
});

describe("antigravity-cli registry", () => {
  it("registers Antigravity CLI provider with binary agy", () => {
    const provider = PROVIDERS.find((p) => p.id === "antigravity-cli");
    expect(provider).toBeDefined();
    expect(provider?.name).toBe("Antigravity CLI");
    expect(provider?.mode).toBe("cli");
    expect(provider?.binary).toBe("agy");
  });

  it("has gemini-3.7-flash-medium as recommended model", () => {
    const provider = PROVIDERS.find((p) => p.id === "antigravity-cli");
    const recommended = provider?.models.find((m) => m.isRecommended);
    expect(recommended).toBeDefined();
    expect(recommended?.id).toBe("gemini-3.7-flash-medium");
  });
});
