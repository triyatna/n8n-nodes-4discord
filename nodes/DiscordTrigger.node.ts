import type {
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  IHookFunctions,
  ITriggerFunctions,
  ITriggerResponse,
  INodeExecutionData,
} from "n8n-workflow";
import nacl from "tweetnacl";
import * as crypto from "crypto";
import WebSocket, { RawData } from "ws";

type InteractionAutoResponse = "none" | "pong" | "deferred" | "message";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
};

const DEFAULT_INTENTS =
  INTENTS.GUILDS |
  INTENTS.GUILD_MESSAGES |
  INTENTS.DIRECT_MESSAGES |
  INTENTS.MESSAGE_CONTENT |
  INTENTS.GUILD_MESSAGE_REACTIONS;

export class DiscordTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Discord Trigger",
    name: "discordTrigger",
    icon: "file:icons/discord.svg",
    group: ["trigger"],
    version: 1,
    description:
      "Receive Discord Interactions (HTTP Webhook) or all messages via Listening (Socket).",
    defaults: { name: "Discord Trigger" },
    inputs: [],
    outputs: ["main"],
    credentials: [{ name: "discordApp", required: true }],
    webhooks: [
      {
        name: "default",
        httpMethod: "POST",
        responseMode: "onReceived",
        path: '={{$parameter["path"]}}',
      },
    ],

    properties: [
      // ---- Mode ----
      {
        displayName: "Mode",
        name: "mode",
        type: "options",
        options: [
          { name: "Interactions", value: "interactions" },
          { name: "Listening", value: "listening" },
        ],
        default: "interactions",
        description:
          "HTTP Webhook for Interactions, or Socket Listening for all messages & events.",
      },

      // ---- Interactions (HTTP) ----
      {
        displayName: "Path",
        name: "path",
        type: "string",
        default: "discord",
        description:
          "Endpoint path. n8n displays Test/Production URLs when Listen/Activate.",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Response Mode",
        name: "responseMode",
        type: "options",
        options: [
          { name: "On Received (immediate)", value: "onReceived" },
          { name: "Last Node", value: "lastNode" },
        ],
        default: "onReceived",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Include Raw Body",
        name: "includeRawBody",
        type: "boolean",
        default: true,
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Require JSON Content-Type",
        name: "requireJson",
        type: "boolean",
        default: true,
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Split Into Items (if body is array)",
        name: "splitIntoItems",
        type: "boolean",
        default: false,
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Immediate ACK (Message)",
        name: "immediateAck",
        type: "boolean",
        default: false,
        description: "Reply directly with a message; if OFF use deferred ACK.",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Interaction Auto-Response (override)",
        name: "interactionAutoResponse",
        type: "options",
        options: [
          { name: "None", value: "none" },
          { name: "PONG", value: "pong" },
          { name: "Deferred", value: "deferred" },
          { name: "Message", value: "message" },
        ],
        default: "deferred",
        description:
          "If None + Response Mode=Last Node, still send deferred to avoid timeout.",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Message Content",
        name: "interactionMessageContent",
        type: "string",
        default: "Working on it...",
        displayOptions: {
          show: {
            mode: ["interactions"],
            interactionAutoResponse: ["message"],
          },
        },
      },
      {
        displayName: "Ephemeral",
        name: "interactionEphemeral",
        type: "boolean",
        default: true,
        description:
          "Use flags=64 to make the message visible only to the invoker.",
        displayOptions: {
          show: {
            mode: ["interactions"],
            interactionAutoResponse: ["message"],
          },
        },
      },
      {
        displayName: "Verify Discord Signatures (Ed25519)",
        name: "verifyInteractions",
        type: "boolean",
        default: true,
        description:
          "Verify X-Signature-Ed25519/Timestamp using Public Key (credential).",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Max Signature Timestamp Age (seconds)",
        name: "maxTimestampAge",
        type: "number",
        default: 300,
        description: "Reject if X-Signature-Timestamp expires (anti-replay).",
        displayOptions: {
          show: { mode: ["interactions"], verifyInteractions: [true] },
        },
      },
      {
        displayName: "Verify Forwarded Shared Secret (HMAC)",
        name: "verifyForwardedSecret",
        type: "boolean",
        default: false,
        description:
          "Verify X-Timestamp/X-Signature (HMAC-SHA256 of `${ts}.${rawBody}`) if shared secret in credential is filled.",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Auto Follow-up after ACK",
        name: "autoFollowup",
        type: "boolean",
        default: true,
        description:
          "Send a simple follow-up to the interaction webhook (without auth).",
        displayOptions: { show: { mode: ["interactions"] } },
      },
      {
        displayName: "Auto Follow-up Content",
        name: "autoFollowupContent",
        type: "string",
        default: "✅ Received by n8n",
        displayOptions: {
          show: { mode: ["interactions"], autoFollowup: [true] },
        },
      },

      // ---- Listening Socket ----
      {
        displayName: "Listening Intents",
        name: "listeningIntents",
        type: "multiOptions",
        options: [
          { name: "Guilds", value: INTENTS.GUILDS },
          { name: "Guild Messages", value: INTENTS.GUILD_MESSAGES },
          { name: "Direct Messages", value: INTENTS.DIRECT_MESSAGES },
          {
            name: "Message Content (privileged)",
            value: INTENTS.MESSAGE_CONTENT,
          },
          { name: "Message Reactions", value: INTENTS.GUILD_MESSAGE_REACTIONS },
        ],
        default: [
          INTENTS.GUILDS,
          INTENTS.GUILD_MESSAGES,
          INTENTS.DIRECT_MESSAGES,
          INTENTS.MESSAGE_CONTENT,
          INTENTS.GUILD_MESSAGE_REACTIONS,
        ],
        description:
          "Select an event. Enable the MESSAGE CONTENT intent in the Dev Portal if you need message content.",
        displayOptions: { show: { mode: ["listening"] } },
      },
      {
        displayName: "Auto Reconnect",
        name: "listeningAutoReconnect",
        type: "boolean",
        default: true,
        displayOptions: { show: { mode: ["listening"] } },
      },
      {
        displayName: "Include Bot's Own Events",
        name: "listeningIncludeSelf",
        type: "boolean",
        default: false,
        description:
          "If turned off (default), events carried out by the bot itself are not emitted to prevent loops/spam.",
        displayOptions: { show: { mode: ["listening"] } },
      },
      {
        displayName: "Self-filter Cache Size",
        name: "selfFilterCacheSize",
        type: "number",
        default: 2000,
        typeOptions: { minValue: 100, maxValue: 20000 },
        description:
          "The number of bot message IDs stored for filtering MESSAGE_UPDATE/DELETE/BULK.",
        displayOptions: { show: { mode: ["listening"] } },
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        return (this.getNodeParameter("mode", 0) as string) === "interactions";
      },
      async create(this: IHookFunctions): Promise<boolean> {
        return (this.getNodeParameter("mode", 0) as string) === "interactions";
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        return (this.getNodeParameter("mode", 0) as string) === "interactions";
      },
    },
  };

  // ========== HTTP WEBHOOK (INTERACTIONS) ==========
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const mode = this.getNodeParameter("mode", 0) as string;
    if (mode !== "interactions") {
      return { noWebhookResponse: true };
    }

    const request = this.getRequestObject();
    const response = this.getResponseObject();

    const cred = await (this as any).getCredentials("discordApp");
    const appIdFromCred = (cred?.applicationId as string) || "";
    const publicKeyFromCred = (cred?.publicKey as string) || "";
    const sharedSecretFromCred = (cred?.sharedSecret as string) || "";

    const respMode = this.getNodeParameter("responseMode", 0) as string;

    const includeRawBody = this.getNodeParameter(
      "includeRawBody",
      0
    ) as boolean;
    const requireJson = this.getNodeParameter("requireJson", 0) as boolean;
    const splitIntoItems = this.getNodeParameter(
      "splitIntoItems",
      0
    ) as boolean;

    const immediateAck = this.getNodeParameter("immediateAck", 0) as boolean;
    const interactionAutoResponse = this.getNodeParameter(
      "interactionAutoResponse",
      0
    ) as InteractionAutoResponse;
    const interactionMessageContent = this.getNodeParameter(
      "interactionMessageContent",
      0
    ) as string;
    const interactionEphemeral = this.getNodeParameter(
      "interactionEphemeral",
      0
    ) as boolean;

    const verifyInteractions = this.getNodeParameter(
      "verifyInteractions",
      0
    ) as boolean;
    const maxTimestampAge = this.getNodeParameter(
      "maxTimestampAge",
      0
    ) as number;
    const verifyForwardedSecret = this.getNodeParameter(
      "verifyForwardedSecret",
      0
    ) as boolean;

    const headers = this.getHeaderData();
    const body = this.getBodyData() as any;

    const hasSigHeaders =
      !!headers["x-signature-ed25519"] && !!headers["x-signature-timestamp"];
    const looksLikeInteraction =
      body && typeof body.type === "number" && typeof body.token === "string";
    const isInteraction = hasSigHeaders || looksLikeInteraction;

    // Content-Type guard
    if (requireJson) {
      const ct = String(headers["content-type"] || "").toLowerCase();
      if (!ct.includes("application/json")) {
        response.status(415).json({ error: "unsupported_media_type" });
        return { noWebhookResponse: true };
      }
    }

    if (!hasSigHeaders && verifyForwardedSecret && sharedSecretFromCred) {
      const tsFwd = String(headers["x-timestamp"] || "");
      const sigFwd = String(headers["x-signature"] || "");
      const raw = (request as any).rawBody as Buffer | undefined;
      if (!raw || !tsFwd || !sigFwd) {
        response
          .status(401)
          .json({ error: "missing_forward_signature_headers" });
        return { noWebhookResponse: true };
      }
      const h = crypto.createHmac("sha256", sharedSecretFromCred);
      h.update(`${tsFwd}.${raw.toString("utf8")}`);
      const expected = h.digest("hex");
      if (expected !== sigFwd) {
        response.status(401).json({ error: "bad_forward_signature" });
        return { noWebhookResponse: true };
      }
    }

    if (verifyInteractions && hasSigHeaders) {
      if (!publicKeyFromCred) {
        response
          .status(401)
          .json({ error: "missing_public_key_in_credentials" });
        return { noWebhookResponse: true };
      }
      const raw = (request as any).rawBody as Buffer | undefined;
      const ts = String(headers["x-signature-timestamp"] || "");
      const sigHex = String(headers["x-signature-ed25519"] || "");
      if (!raw || !ts || !sigHex) {
        response.status(401).json({ error: "invalid_request" });
        return { noWebhookResponse: true };
      }
      const tsNum = Number(ts);
      if (Number.isFinite(tsNum) && typeof maxTimestampAge === "number") {
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - tsNum) > Math.max(0, maxTimestampAge)) {
          response.status(401).json({ error: "timestamp_out_of_range" });
          return { noWebhookResponse: true };
        }
      }
      const msg = Buffer.concat([Buffer.from(ts, "utf8"), raw]);
      const toBytes = (hex: string) =>
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      const ok = nacl.sign.detached.verify(
        new Uint8Array(msg),
        toBytes(sigHex),
        toBytes(publicKeyFromCred)
      );
      if (!ok) {
        response.status(401).json({ error: "bad_signature" });
        return { noWebhookResponse: true };
      }
    }

    const applicationId =
      appIdFromCred || (body && (body.application_id as string)) || "";
    const payload: any = {
      headers,
      query: this.getQueryData(),
      body,
      receivedAt: new Date().toISOString(),
      source: isInteraction ? "interactions" : "webhook",
      applicationId: applicationId || undefined,
    };

    if (includeRawBody) {
      // @ts-ignore
      const raw = (request as any).rawBody;
      if (raw) payload.rawBody = raw.toString("utf8");
    }

    const token = body?.token as string | undefined;
    if (applicationId && token) {
      payload.followupUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${token}`;
    }

    if (isInteraction) {
      const t = body?.type;
      if (t === 1) {
        response.json({ type: 1 }); // PONG
      } else {
        const override = interactionAutoResponse;
        let mode: InteractionAutoResponse;
        if (override === "none") {
          mode = immediateAck ? "message" : "deferred";
          if (respMode === "lastNode") mode = "deferred";
        } else {
          mode = override;
        }

        if (mode === "pong") response.json({ type: 1 });
        else if (mode === "deferred") response.json({ type: 5 });
        else if (mode === "message")
          response.json({
            type: 4,
            data: {
              content: interactionMessageContent,
              flags: interactionEphemeral ? 64 : 0,
            },
          });
        else response.json({ type: 5 });

        if (this.getNodeParameter("autoFollowup", 0) && payload.followupUrl) {
          const content = this.getNodeParameter(
            "autoFollowupContent",
            0
          ) as string;
          setTimeout(() => {
            try {
              (this as any).helpers
                .httpRequest({
                  method: "POST",
                  url: payload.followupUrl,
                  body: { content },
                  json: true,
                } as any)
                .catch(() => {});
            } catch {}
          }, 0);
        }
      }

      const items = toItems(payload, splitIntoItems);
      return { noWebhookResponse: true, workflowData: [items] };
    }

    const items = toItems(payload, splitIntoItems);
    if (this.getNodeParameter("responseMode", 0) === "onReceived") {
      const response = this.getResponseObject();
      response.json({ ok: true });
      return { noWebhookResponse: true, workflowData: [items] };
    }
    return { workflowData: [items] };
  }

  // ========== LISTENING SOCKET ==========
  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const mode = this.getNodeParameter("mode", 0) as string;
    if (mode !== "listening") return { closeFunction: async () => {} };

    // Bot token
    const cred = await (this as any).getCredentials("discordApp");
    const tokenRaw = (cred?.botToken as string) || "";
    if (!tokenRaw) {
      throw new Error(
        "Token Bot is required in 'Discord App Credential' credential for listening mode."
      );
    }
    const token = tokenRaw.startsWith("Bot ") ? tokenRaw : `Bot ${tokenRaw}`;

    const intentsSelected = this.getNodeParameter(
      "listeningIntents",
      0
    ) as number[];
    const intents =
      Array.isArray(intentsSelected) && intentsSelected.length
        ? intentsSelected.reduce((a, b) => a | b, 0)
        : DEFAULT_INTENTS;

    const autoReconnect = this.getNodeParameter(
      "listeningAutoReconnect",
      0
    ) as boolean;

    const includeSelf = this.getNodeParameter(
      "listeningIncludeSelf",
      0
    ) as boolean;

    const cacheMax = Math.max(
      100,
      Math.min(
        20000,
        (this.getNodeParameter("selfFilterCacheSize", 0) as number) || 2000
      )
    );

    let ws: WebSocket | undefined;
    let heartbeatInterval: NodeJS.Timeout | undefined;
    let heartbeatAcked = true;
    let sessionId: string | undefined;
    let seq: number | null = null;
    let closed = false;
    let botId: string | undefined;

    const selfMsgIds = new Set<string>();
    const selfMsgQueue: string[] = [];
    const rememberSelfMsg = (id?: string) => {
      if (!id) return;
      if (selfMsgIds.has(id)) return;
      selfMsgIds.add(id);
      selfMsgQueue.push(id);
      if (selfMsgQueue.length > cacheMax) {
        const rm = selfMsgQueue.shift();
        if (rm) selfMsgIds.delete(rm);
      }
    };

    const identify = () => ({
      op: 2,
      d: {
        token,
        intents,
        properties: {
          os: "linux",
          browser: "n8n-discord-node",
          device: "n8n-discord-node",
        },
        large_threshold: 50,
        compress: false,
      },
    });

    const heartbeat = () => ({ op: 1, d: seq });
    const resume = () => ({ op: 6, d: { token, session_id: sessionId, seq } });

    const connect = () => {
      ws = new WebSocket(GATEWAY_URL);

      ws.on("message", (data: RawData) => {
        try {
          const payload = JSON.parse(data.toString());
          const { op, t, s } = payload;
          let d = payload.d;
          if (s !== null && s !== undefined) seq = s;

          switch (op) {
            case 10: {
              const interval = d.heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatAcked = true;
              heartbeatInterval = setInterval(() => {
                if (!heartbeatAcked) {
                  try {
                    ws?.close(4000, "Heartbeat not acknowledged");
                  } catch {}
                  return;
                }
                heartbeatAcked = false;
                try {
                  ws?.send(JSON.stringify(heartbeat()));
                } catch {}
              }, interval);

              if (sessionId) {
                try {
                  ws?.send(JSON.stringify(resume()));
                } catch {}
              } else {
                try {
                  ws?.send(JSON.stringify(identify()));
                } catch {}
              }
              break;
            }
            case 11: {
              heartbeatAcked = true;
              break;
            }
            case 0: {
              if (t === "READY") {
                sessionId = d.session_id;
                botId = d?.user?.id;
              }

              if (!includeSelf && botId) {
                if (t === "MESSAGE_CREATE") {
                  if (d?.author?.id === botId) {
                    rememberSelfMsg(d?.id);
                    return;
                  }
                } else if (t === "MESSAGE_UPDATE") {
                  const isSelf =
                    (d?.author?.id && d.author.id === botId) ||
                    (d?.id && selfMsgIds.has(d.id));
                  if (isSelf) return;
                } else if (t === "MESSAGE_DELETE") {
                  if (d?.id && selfMsgIds.has(d.id)) return;
                } else if (t === "MESSAGE_DELETE_BULK") {
                  if (Array.isArray(d?.ids)) {
                    const filtered = d.ids.filter(
                      (id: string) => !selfMsgIds.has(id)
                    );
                    if (filtered.length === 0) return;
                    d = { ...d, ids: filtered };
                  }
                } else if (
                  t === "MESSAGE_REACTION_ADD" ||
                  t === "MESSAGE_REACTION_REMOVE"
                ) {
                  if (d?.user_id && d.user_id === botId) return;
                } else if (t === "TYPING_START") {
                  if (d?.user_id && d.user_id === botId) return;
                }
              }

              if (
                t === "MESSAGE_CREATE" ||
                t === "MESSAGE_UPDATE" ||
                t === "MESSAGE_DELETE" ||
                t === "MESSAGE_DELETE_BULK" ||
                t === "MESSAGE_REACTION_ADD" ||
                t === "MESSAGE_REACTION_REMOVE" ||
                t === "MESSAGE_REACTION_REMOVE_ALL" ||
                t === "MESSAGE_REACTION_REMOVE_EMOJI" ||
                t === "CHANNEL_PINS_UPDATE" ||
                t === "TYPING_START"
              ) {
                const item: INodeExecutionData = {
                  json: {
                    op,
                    t,
                    s,
                    d,
                    receivedAt: new Date().toISOString(),
                    source: "listening",
                  },
                };
                this.emit([[item]]);
              }
              break;
            }
            case 7: {
              try {
                ws?.close(4000, "Server requested reconnect");
              } catch {}
              break;
            }
            case 9: {
              sessionId = undefined;
              setTimeout(() => {
                try {
                  ws?.send(JSON.stringify(identify()));
                } catch {}
              }, 1500);
              break;
            }
            default:
              break;
          }
        } catch {}
      });

      ws.on("close", () => {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        if (!closed && autoReconnect) setTimeout(connect, 2000);
      });

      ws.on("error", () => {});
    };

    connect();

    return {
      closeFunction: async () => {
        closed = true;
        try {
          ws?.close(1000, "Manual close");
        } catch {}
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      },
    };
  }
}

function toItems(payload: any, split: boolean): Array<{ json: any }> {
  if (Array.isArray(payload?.body) && split) {
    return payload.body.map((b: any) => ({ json: { ...payload, body: b } }));
  }
  return [{ json: payload }];
}
