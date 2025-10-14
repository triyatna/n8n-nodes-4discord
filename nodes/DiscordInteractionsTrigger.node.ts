import type {
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  IHookFunctions,
} from "n8n-workflow";
import nacl from "tweetnacl";
import * as crypto from "crypto";

type InteractionAutoResponse = "none" | "pong" | "deferred" | "message";

export class DiscordInteractionsTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Discord Interactions",
    name: "discordInteractionsTrigger",
    icon: "file:../../icons/discord.svg",
    group: ["trigger"],
    version: 1,
    description: "Receive Discord Interactions via HTTP Webhook.",
    defaults: { name: "Discord Interactions" },
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
      {
        displayName: "Path",
        name: "path",
        type: "string",
        default: "discord",
        description:
          "Endpoint path. n8n displays Test/Production URLs when Listen/Activate.",
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
      },
      {
        displayName: "Include Raw Body",
        name: "includeRawBody",
        type: "boolean",
        default: true,
      },
      {
        displayName: "Require JSON Content-Type",
        name: "requireJson",
        type: "boolean",
        default: true,
      },
      {
        displayName: "Split Into Items (if body is array)",
        name: "splitIntoItems",
        type: "boolean",
        default: false,
      },
      {
        displayName: "Immediate ACK (Message)",
        name: "immediateAck",
        type: "boolean",
        default: false,
        description: "Reply directly with a message; if OFF use deferred ACK.",
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
      },
      {
        displayName: "Message Content",
        name: "interactionMessageContent",
        type: "string",
        default: "Working on it...",
        displayOptions: { show: { interactionAutoResponse: ["message"] } },
      },
      {
        displayName: "Ephemeral",
        name: "interactionEphemeral",
        type: "boolean",
        default: true,
        description:
          "Use flags=64 to make the message visible only to the invoker.",
        displayOptions: { show: { interactionAutoResponse: ["message"] } },
      },
      {
        displayName: "Verify Discord Signatures (Ed25519)",
        name: "verifyInteractions",
        type: "boolean",
        default: true,
        description:
          "Verify X-Signature-Ed25519/Timestamp using Public Key (credential).",
      },
      {
        displayName: "Max Signature Timestamp Age (seconds)",
        name: "maxTimestampAge",
        type: "number",
        default: 300,
        description: "Reject if X-Signature-Timestamp expires (anti-replay).",
        displayOptions: { show: { verifyInteractions: [true] } },
      },
      {
        displayName: "Verify Forwarded Shared Secret (HMAC)",
        name: "verifyForwardedSecret",
        type: "boolean",
        default: false,
        description:
          "Verify X-Timestamp/X-Signature (HMAC-SHA256 of `${ts}.${rawBody}`) if shared secret in credential is filled.",
      },
      {
        displayName: "Auto Follow-up after ACK",
        name: "autoFollowup",
        type: "boolean",
        default: true,
        description:
          "Send a simple follow-up to the interaction webhook (without auth).",
      },
      {
        displayName: "Auto Follow-up Content",
        name: "autoFollowupContent",
        type: "string",
        default: "✅ Received by n8n",
        displayOptions: { show: { autoFollowup: [true] } },
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        return true;
      },
      async create(this: IHookFunctions): Promise<boolean> {
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
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
      if (Number.isFinite(tsNum)) {
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
      source: "interactions",
      applicationId: applicationId || undefined,
    };

    if (includeRawBody) {
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
        } else mode = override;

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

      const items = toItems(
        payload,
        this.getNodeParameter("splitIntoItems", 0) as boolean
      );
      return { noWebhookResponse: true, workflowData: [items] };
    }

    const items = toItems(payload, splitIntoItems);
    if (respMode === "onReceived") {
      response.json({ ok: true });
      return { noWebhookResponse: true, workflowData: [items] };
    }
    return { workflowData: [items] };
  }
}

function toItems(payload: any, split: boolean): Array<{ json: any }> {
  if (Array.isArray(payload?.body) && split) {
    return payload.body.map((b: any) => ({ json: { ...payload, body: b } }));
  }
  return [{ json: payload }];
}
