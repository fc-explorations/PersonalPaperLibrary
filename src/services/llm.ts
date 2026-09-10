export type LlmProvider = "openai" | "ollama";
export type LlmMessage = { role: "system" | "user"; content: string };
type OpenAiReasoningEffort = "minimal" | "low" | "medium" | "high";
export const MATH_FORMATTING_INSTRUCTION = "When writing mathematics, always use LaTeX delimiters: inline \\( ... \\) or display \\[ ... \\]. Use commands such as \\Sigma_T, v^\\top, \\rho, and \\lambda; never write raw forms such as v^T, ΣT, or ΣB.";

export interface LlmClient {
  complete(input: { model: string; messages: LlmMessage[]; temperature: number; maxOutputTokens?: number }): Promise<string>;
}

export interface LlmClientOptions {
  fetcher?: typeof fetch;
  openaiApiKey?: () => Promise<string | undefined>;
  ollamaBaseUrl?: string;
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(body.slice(0, 500) || `LLM_HTTP_${response.status}`);
}

export class OpenAiLlmClient implements LlmClient {
  private readonly fetcher: typeof fetch;
  private readonly getApiKey: () => Promise<string | undefined>;

  constructor(options: Pick<LlmClientOptions, "fetcher" | "openaiApiKey"> = {}) {
    this.fetcher = options.fetcher || fetch;
    this.getApiKey = options.openaiApiKey || (async () => process.env.OPENAI_API_KEY?.trim());
  }

  async complete(input: { model: string; messages: LlmMessage[]; temperature: number; maxOutputTokens?: number }): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("OPENAI_KEY_NOT_CONFIGURED");
    const requestBody: Record<string, unknown> = { model: input.model, messages: input.messages };
    // GPT-5 nano only accepts its default sampling configuration and rejects
    // an explicit temperature value, unlike older chat-completions models.
    const isReasoningModel = /^gpt-5(?:$|[-.])/i.test(input.model);
    if (!isReasoningModel) requestBody.temperature = input.temperature;
    else requestBody.reasoning_effort = "minimal" satisfies OpenAiReasoningEffort;
    if (input.maxOutputTokens) requestBody.max_completion_tokens = input.maxOutputTokens;
    const response = await this.fetcher("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string; refusal?: string | null }; finish_reason?: string }> };
    const choice = body.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (!content) {
      if (choice?.message?.refusal) throw new Error(`OPENAI_REFUSAL: ${choice.message.refusal}`);
      if (choice?.finish_reason === "length") throw new Error("OPENAI_OUTPUT_LIMIT_REACHED");
      throw new Error(`OPENAI_EMPTY_RESPONSE${choice?.finish_reason ? `:${choice.finish_reason}` : ""}`);
    }
    return content;
  }
}

export class OllamaLlmClient implements LlmClient {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: Pick<LlmClientOptions, "fetcher" | "ollamaBaseUrl"> = {}) {
    this.fetcher = options.fetcher || fetch;
    this.baseUrl = (options.ollamaBaseUrl || "http://localhost:11434").replace(/\/$/, "");
  }

  async complete(input: { model: string; messages: LlmMessage[]; temperature: number }): Promise<string> {
    const response = await this.fetcher(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: false, options: { temperature: input.temperature } }),
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new Error("OLLAMA_EMPTY_RESPONSE");
    return content;
  }
}
