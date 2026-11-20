// backend/src/domains/ai/providers/http-model-provider.ts
// Additive region-pinned, SSRF-guarded HTTP ModelProvider adapter (Completion Plan §6 / G-30).
// Keeps DeterministicMockProvider intact as default in local/test; enabled explicitly via env when
// Legal & Product approve a model provider and region.

import { AppError } from "../../../platform/errors";
import { assertSafeOutboundUrl } from "../../../platform/ssrf";
import type { ModelMessage, ModelProvider } from "../gateway";

export interface HttpModelProviderConfig {
  name: string;
  region: string;
  endpointUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Region-pinned HTTP model provider compatible with OpenAI/Vertex/gateway chat-completion JSON contracts.
 * Enforces SSRF protection, strict AbortSignal timeout, bounded max_tokens, and zero raw-prompt logging.
 */
export class HttpModelProvider implements ModelProvider {
  public readonly name: string;
  public readonly region: string;
  private readonly endpointUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: HttpModelProviderConfig) {
    this.name = config.name;
    this.region = config.region;
    this.endpointUrl = config.endpointUrl;
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async generate(req: {
    model: string;
    system: string;
    messages: ModelMessage[];
    schema?: any;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<{ text: string; usage: { tokensIn: number; tokensOut: number; costMinor: number } }> {
    if (req.signal.aborted) {
      throw new AppError("UNAVAILABLE", "Model request aborted due to timeout.");
    }

    // Enforce SSRF & HTTPS policy before outbound call
    const safeUrl = assertSafeOutboundUrl(this.endpointUrl, {
      label: `AI model provider endpoint (${this.name})`,
      allowLocalInDev: true
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Abate-Provider-Region": this.region
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const payload = {
      model: req.model,
      max_tokens: req.maxOutputTokens,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: req.system },
        ...req.messages
      ]
    };

    let res: Response;
    try {
      res = await this.fetchImpl(safeUrl.toString(), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: req.signal
      });
    } catch (err: any) {
      if (req.signal.aborted || err?.name === "AbortError") {
        throw new AppError("UNAVAILABLE", "Model request aborted due to timeout.");
      }
      throw new AppError("UNAVAILABLE", `Model provider ${this.name} is unreachable; continue with the manual workflow.`);
    }

    if (!res.ok) {
      throw new AppError("UNAVAILABLE", `Model provider ${this.name} returned HTTP ${res.status}; continue with the manual workflow.`);
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new AppError("UNAVAILABLE", `Model provider ${this.name} returned non-JSON payload.`);
    }

    const text =
      typeof data?.text === "string"
        ? data.text
        : typeof data?.choices?.[0]?.message?.content === "string"
          ? data.choices[0].message.content
          : "";

    if (!text) {
      throw new AppError("UNAVAILABLE", `Model provider ${this.name} returned an empty response.`);
    }

    const tokensIn = Number(data?.usage?.tokensIn ?? data?.usage?.prompt_tokens ?? 0);
    const tokensOut = Number(data?.usage?.tokensOut ?? data?.usage?.completion_tokens ?? 0);
    const costMinor = Number(data?.usage?.costMinor ?? Math.max(1, Math.ceil((tokensIn + tokensOut) / 200)));

    return {
      text,
      usage: { tokensIn, tokensOut, costMinor }
    };
  }
}
