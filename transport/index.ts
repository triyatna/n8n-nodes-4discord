import type {
  IHttpRequestOptions,
  IWebhookFunctions,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  IHttpRequestMethods,
  JsonObject,
} from "n8n-workflow";
import { NodeApiError, NodeOperationError } from "n8n-workflow";

const RETRY_STATUS = new Set([429, 502, 503, 504]);

export interface DiscordRequestOptions {
  sendAsForm?: boolean;
  formData?: Record<string, any>;
  headers?: Record<string, string>;
  noAuth?: boolean;
}

/**
 * Helper utama untuk request REST ke Discord v10.
 * - Credential: "discordApp" (Application ID, Public Key, Bot Token, Shared Secret)
 * - Authorization: Bot <token> (kecuali opts.noAuth = true)
 * - Retry: 429 & 5xx dengan backoff
 * - JSON & multipart/form-data
 */
export async function discordApiRequest(
  that: IExecuteFunctions | IWebhookFunctions | ILoadOptionsFunctions,
  method: string,
  endpoint: string,
  body: JsonObject = {},
  qs: JsonObject = {},
  opts: DiscordRequestOptions = {}
) {
  let creds: any;
  try {
    creds = await (that as any).getCredentials("discordApp");
  } catch {
    throw new NodeOperationError(
      (that as any).getNode(),
      "The 'Discord App Credential' credential is not configured."
    );
  }

  const baseURL = "https://discord.com/api/v10";
  const url = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const httpMethod = method.toUpperCase() as IHttpRequestMethods;

  const headers: Record<string, string> = {
    "User-Agent":
      "n8n-community-discord (+https://github.com/triyatna/n8n-nodes-discord)",
    ...(opts.headers || {}),
  };

  if (!opts.noAuth) {
    const raw = (creds?.botToken as string) || "";
    if (!raw) {
      throw new NodeOperationError(
        (that as any).getNode(),
        "Bot Token is required to be filled in the 'Discord App Credential' credential'."
      );
    }
    headers.Authorization = raw.startsWith("Bot ") ? raw : `Bot ${raw}`;
  }

  let attempt = 0;
  const maxAttempts = 6;

  while (attempt < maxAttempts) {
    attempt++;

    const options: IHttpRequestOptions = {
      method: httpMethod,
      baseURL,
      url,
      qs,
      headers,
      json: !opts.sendAsForm,
      body,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    };

    if (opts.sendAsForm) {
      (options as any).formData = opts.formData ?? body;
      delete (options as any).body;
    }

    let resp: any;
    try {
      resp = await (that as any).helpers.httpRequest(options);
    } catch (error) {
      throw new NodeApiError((that as any).getNode(), error as any);
    }

    const status = resp?.statusCode ?? 0;

    if (status >= 200 && status < 300) {
      return (resp?.body ?? {}) as unknown;
    }

    if (RETRY_STATUS.has(status)) {
      let delayMs = 0;
      if (status === 429) {
        const retryAfter =
          Number(
            resp?.headers?.["retry-after"] ?? resp?.body?.retry_after ?? 0
          ) || 0;
        delayMs = Math.max(0, Math.floor(retryAfter * 1000));
      } else {
        delayMs = Math.min(30_000, 2 ** attempt * 250);
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const errBody: JsonObject =
      (resp && typeof resp.body === "object" && resp.body) ||
      ({ status, message: "Discord API error" } as JsonObject);

    throw new NodeApiError((that as any).getNode(), errBody);
  }

  throw new NodeApiError((that as any).getNode(), {
    message: "Discord API request failed after multiple retries",
  } as JsonObject);
}

export const encodeEmoji = (emoji: string) => encodeURIComponent(emoji);
