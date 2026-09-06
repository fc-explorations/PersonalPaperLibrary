export type LlmProvider = "openai" | "ollama";
export type LlmMessage = { role: "system" | "user"; content: string };

export interface LlmClient {
  complete(input: { model: string; messages: LlmMessage[]; temperature: number }): Promise<string>;
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

  async complete(input: { model: string; messages: LlmMessage[]; temperature: number }): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) throw new Error("OPENAI_KEY_NOT_CONFIGURED");
    const requestBody: Record<string, unknown> = { model: input.model, messages: input.messages };
    // GPT-5 nano only accepts its default sampling configuration and rejects
    // an explicit temperature value, unlike older chat-completions models.
    if (!/^gpt-5(?:$|[-.])/i.test(input.model)) requestBody.temperature = input.temperature;
    const response = await this.fetcher("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("OPENAI_EMPTY_RESPONSE");
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
