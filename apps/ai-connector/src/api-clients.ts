import type { ModelSettings } from "../../../contracts/ai-models.js";
import type {
  AgentTurnClient,
  AgentTurnOptions,
} from "./app-server-client.js";
import type {
  AccountReadResult,
  AvailableModel,
} from "./types.js";

function openAiModels(): AvailableModel[] {
  return [
    {
      provider: "openai_api",
      model: "gpt-4o",
      displayName: "GPT-4o (OpenAI API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "기본" }],
      isDefault: true,
    },
    {
      provider: "openai_api",
      model: "gpt-4o-mini",
      displayName: "GPT-4o mini (OpenAI API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "기본" }],
      isDefault: false,
    },
    {
      provider: "openai_api",
      model: "o3-mini",
      displayName: "o3-mini (OpenAI API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "빠르게" },
        { reasoningEffort: "medium", description: "보통" },
        { reasoningEffort: "high", description: "꼼꼼하게" },
      ],
      isDefault: false,
    },
  ];
}

function anthropicModels(): AvailableModel[] {
  return [
    {
      provider: "anthropic_api",
      model: "claude-3-7-sonnet-20250219",
      displayName: "Claude 3.7 Sonnet (Anthropic API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "빠르게" },
        { reasoningEffort: "medium", description: "보통" },
        { reasoningEffort: "high", description: "꼼꼼하게" },
      ],
      isDefault: true,
    },
    {
      provider: "anthropic_api",
      model: "claude-3-5-sonnet-20241022",
      displayName: "Claude 3.5 Sonnet (Anthropic API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "기본" }],
      isDefault: false,
    },
    {
      provider: "anthropic_api",
      model: "claude-3-5-haiku-20241022",
      displayName: "Claude 3.5 Haiku (Anthropic API)",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "기본" }],
      isDefault: false,
    },
  ];
}

export class OpenAiApiClient implements AgentTurnClient {
  readonly supportsImageGeneration = false;
  constructor(private readonly apiKey: string) {}

  async accountRead(): Promise<AccountReadResult> {
    return {
      account: { type: "openai_api", email: null, planType: "API Key" },
      requiresOpenaiAuth: false,
    };
  }

  async models(): Promise<AvailableModel[]> {
    return openAiModels();
  }

  async runStructuredTurn(
    input: Array<Record<string, unknown>>,
    _outputSchema: Record<string, unknown>,
    _timeoutMs = 300_000,
    options?: AgentTurnOptions,
  ): Promise<string> {
    const selectedModel = options?.modelSettings?.model || "gpt-4o";
    const tools = options?.tools?.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    const messages: any[] = [];
    const systemPrompt = input.find((item) => item.type === "text")?.text;
    if (typeof systemPrompt === "string") {
      messages.push({ role: "system", content: systemPrompt });
    }

    let finalAnswer = "";
    for (let step = 0; step < 40; step++) {
      if (options?.signal?.aborted) throw new Error("AI turn aborted.");

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          tool_choice: tools && tools.length > 0 ? "auto" : undefined,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        let errJson: any = null;
        try {
          errJson = await response.json();
        } catch {}
        const errorMsg = errJson?.error?.message || response.statusText;
        if (response.status === 429) {
          if (errJson?.error?.code === "insufficient_quota" || /quota|billing/i.test(errorMsg)) {
            throw new Error(
              "OpenAI API 잔액(Quota)이 부족합니다. OpenAI 대시보드(platform.openai.com)에서 크레딧 충전 및 결제 수단을 확인해 주세요.",
            );
          }
          throw new Error(
            "OpenAI API 사용량 한도(Rate limit)에 도달했습니다. 잠시 후 다시 시도해 주세요.",
          );
        }
        if (response.status === 401) {
          throw new Error(
            "OpenAI API 키가 올바르지 않거나 만료되었습니다. 설정에서 API 키를 다시 확인해 주세요.",
          );
        }
        throw new Error(`OpenAI API 오류 (${response.status}): ${errorMsg}`);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw new Error("OpenAI API로부터 응답을 받지 못했습니다.");

      const message = choice.message;
      messages.push(message);

      if (message.content) {
        finalAnswer = message.content;
        options?.onText?.(message.content);
      }

      const toolCalls = message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        break;
      }

      for (const call of toolCalls) {
        const name = call.function.name;
        let args = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {}

        let resultString = "{}";
        try {
          const toolResult = await options?.onTool?.(
            name,
            args,
            call.id,
            options.signal ?? new AbortController().signal,
          );
          resultString = JSON.stringify(toolResult ?? { success: true });
        } catch (callErr: any) {
          resultString = JSON.stringify({
            success: false,
            error: callErr?.message ?? "tool_call_failed",
          });
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultString,
        });
      }
    }

    return finalAnswer;
  }
}

export class AnthropicApiClient implements AgentTurnClient {
  readonly supportsImageGeneration = false;
  constructor(private readonly apiKey: string) {}

  async accountRead(): Promise<AccountReadResult> {
    return {
      account: { type: "anthropic_api", email: null, planType: "API Key" },
      requiresOpenaiAuth: false,
    };
  }

  async models(): Promise<AvailableModel[]> {
    return anthropicModels();
  }

  async runStructuredTurn(
    input: Array<Record<string, unknown>>,
    _outputSchema: Record<string, unknown>,
    _timeoutMs = 300_000,
    options?: AgentTurnOptions,
  ): Promise<string> {
    const selectedModel = options?.modelSettings?.model || "claude-3-7-sonnet-20250219";
    const tools = options?.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    const systemPrompt = input.find((item) => item.type === "text")?.text;
    const messages: any[] = [{ role: "user", content: "프레젠테이션 작업을 시작해 주세요." }];

    let finalAnswer = "";
    for (let step = 0; step < 40; step++) {
      if (options?.signal?.aborted) throw new Error("AI turn aborted.");

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: 4096,
          system: typeof systemPrompt === "string" ? systemPrompt : undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        let errJson: any = null;
        try {
          errJson = await response.json();
        } catch {}
        const errorMsg = errJson?.error?.message || response.statusText;
        if (response.status === 429) {
          throw new Error(
            "Anthropic API 사용량 한도(Rate limit)에 도달했습니다. 잠시 후 다시 시도해 주세요.",
          );
        }
        if (response.status === 401) {
          throw new Error(
            "Anthropic API 키가 올바르지 않습니다. 설정에서 API 키를 다시 확인해 주세요.",
          );
        }
        throw new Error(`Anthropic API 오류 (${response.status}): ${errorMsg}`);
      }

      const data = await response.json();
      messages.push({ role: "assistant", content: data.content });

      const textBlock = data.content.find((b: any) => b.type === "text");
      if (textBlock?.text) {
        finalAnswer = textBlock.text;
        options?.onText?.(textBlock.text);
      }

      const toolUses = data.content.filter((b: any) => b.type === "tool_use");
      if (!toolUses || toolUses.length === 0) {
        break;
      }

      const toolResults: any[] = [];
      for (const block of toolUses) {
        const name = block.name;
        const args = block.input ?? {};
        let resultString = "{}";
        try {
          const toolResult = await options?.onTool?.(
            name,
            args,
            block.id,
            options.signal ?? new AbortController().signal,
          );
          resultString = JSON.stringify(toolResult ?? { success: true });
        } catch (callErr: any) {
          resultString = JSON.stringify({
            success: false,
            error: callErr?.message ?? "tool_call_failed",
          });
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: resultString,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return finalAnswer;
  }
}
