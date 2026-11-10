import Anthropic from "@anthropic-ai/sdk";

export type StreamParams = Anthropic.Beta.MessageCreateParamsNonStreaming;

export interface StreamHandlers {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
}

/**
 * The single seam between the engine and the model provider. The default
 * implementation streams from the Anthropic API; tests and future providers
 * (Bedrock, Vertex, team gateway) implement the same interface.
 */
export interface ModelTransport {
  stream(params: StreamParams, handlers: StreamHandlers, signal?: AbortSignal): Promise<Anthropic.Beta.BetaMessage>;
}

/** Raised when a streamed tool input could not be parsed as JSON at all. */
export class ToolInputParseError extends Error {}

export class AnthropicTransport implements ModelTransport {
  constructor(private readonly client: Anthropic) {}

  async stream(params: StreamParams, handlers: StreamHandlers, signal?: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    const stream = this.client.beta.messages.stream(params, { signal });
    stream.on("streamEvent", (event) => {
      if (event.type !== "content_block_delta") return;
      if (event.delta.type === "text_delta") handlers.onText?.(event.delta.text);
      else if (event.delta.type === "thinking_delta") handlers.onThinking?.(event.delta.thinking);
    });
    try {
      return await stream.finalMessage();
    } catch (err) {
      // With eager input streaming the SDK rejects when a tool input is not
      // parseable JSON. Typed API errors are rethrown untouched.
      if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError) throw err;
      if (err instanceof SyntaxError || (err instanceof Anthropic.AnthropicError && /JSON/i.test(err.message))) {
        throw new ToolInputParseError(err.message);
      }
      throw err;
    }
  }
}
