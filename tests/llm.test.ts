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
    expect(requestBody?.reasoning_effort).toBe("minimal");
  });

  it("passes an output cap to OpenAI", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const client = new OpenAiLlmClient({
      openaiApiKey: async () => "test-key",
      fetcher: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }), { status: 200 });
      },
    });

    await client.complete({ ...input, maxOutputTokens: 700 });
    expect(requestBody?.max_completion_tokens).toBe(700);
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

  it("reports a useful error when OpenAI stops at the output limit", async () => {
    const client = new OpenAiLlmClient({
      openaiApiKey: async () => "test-key",
      fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }] }), { status: 200 }),
    });

    await expect(client.complete({ ...input, maxOutputTokens: 10 })).rejects.toThrow("OPENAI_OUTPUT_LIMIT_REACHED");
  });

  it("retries a length-limited GPT-5 response with a larger budget", async () => {
    let calls = 0;
    let retryBody: Record<string, unknown> | undefined;
    const client = new OpenAiLlmClient({
      openaiApiKey: async () => "test-key",
      fetcher: async (_url, init) => {
        calls += 1;
        retryBody = JSON.parse(String(init?.body));
        const body = calls === 1
          ? { choices: [{ message: { content: "", refusal: null }, finish_reason: "length" }] }
          : { choices: [{ message: { content: "recovered answer" }, finish_reason: "stop" }] };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    await expect(client.complete({ ...input, maxOutputTokens: 10 })).resolves.toBe("recovered answer");
    expect(calls).toBe(2);
    expect(retryBody?.max_completion_tokens).toBe(40);
  });
});
