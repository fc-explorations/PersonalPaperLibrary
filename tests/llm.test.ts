import { describe, expect, it } from "vitest";
import { OpenAiLlmClient } from "../src/services/llm.js";

const input = { model: "gpt-5-nano", messages: [{ role: "user" as const, content: "Answer this." }], temperature: 0.2 };

describe("OpenAI LLM client", () => {
  it("omits unsupported temperature for GPT-5 nano", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = new OpenAiLlmClient({
      openaiApiKey: async () => "test-key",
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 });
      },
    });

    await expect(client.complete(input)).resolves.toBe("answer");
    expect(requestBody).not.toHaveProperty("temperature");
  });

  it("keeps temperature for models that support it", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = new OpenAiLlmClient({
      openaiApiKey: async () => "test-key",
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 });
      },
    });

    await client.complete({ ...input, model: "gpt-4.1-mini" });
    expect(requestBody?.temperature).toBe(0.2);
  });
});
