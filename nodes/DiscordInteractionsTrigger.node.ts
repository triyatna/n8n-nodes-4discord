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

function toItems(payload: any, split: boolean): Array<{ json: any }> {
  if (Array.isArray(payload?.body) && split) {
    return payload.body.map((b: any) => ({ json: { ...payload, body: b } }));
  }
  return [{ json: payload }];
}
function parseList(input?: string): Set<string> {
  if (typeof input !== "string") return new Set();
  return new Set(
    input
      .split(/[\s,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}
function get<T>(o: any, path: string, d: T): T {
  const v = path
    .split(".")
    .reduce<any>((a, k) => (a && k in a ? a[k] : undefined), o);
  return (v === undefined ? d : v) as T;
}

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
        // URL efektif: https://<host>/webhook/<pathSecret>/<pathSuffix>
        path: '={{$parameter["pathSecret"] + "/" + $parameter["pathSuffix"]}}',
      },
    ],
    properties: [
      {
        displayName: "Path Secret",
        name: "pathSecret",
        type: "string",
        default: "secret-segment",
        description: "A random/secret segment in the middle of the URL.",
      },
      {
        displayName: "Path Suffix",
        name: "pathSuffix",
        type: "string",
        default: "discord-interactions",
        description:
          "The last segment of the path. Usually left at the default: discord-interactions",
      },
      {
        displayName: "Options",
        name: "options",
        type: "fixedCollection",
        default: {},
        typeOptions: { multipleValues: true },
        options: [
          {
            displayName: "Response",
            name: "response",
            values: [
              {
                displayName: "Response Mode",
                name: "responseMode",
                noDataExpression: true,
                type: "options",
                options: [
                  { name: "On Received (immediate)", value: "onReceived" },
                  { name: "Last Node", value: "lastNode" },
                ],
                default: "onReceived",
              },
              {
                displayName: "Split Into Items (if body is array)",
                name: "splitIntoItems",
                noDataExpression: true,
                type: "boolean",
                default: false,
              },
              {
                displayName: "Interaction Auto-Response",
                name: "interactionAutoResponse",
                noDataExpression: true,
                type: "options",
                options: [
                  { name: "None", value: "none" },
                  { name: "PONG", value: "pong" },
                  { name: "Deferred", value: "deferred" },
                  { name: "Message", value: "message" },
                ],
                default: "deferred",
                description: "Auto-ACK to avoid 3s timeout.",
              },
              {
                displayName: "Message Content",
                name: "interactionMessageContent",
                type: "string",
                default: "Working on it...",
                displayOptions: {
                  show: { interactionAutoResponse: ["message"] },
                },
              },
              {
                displayName: "Ephemeral",
                name: "interactionEphemeral",
                noDataExpression: true,
                type: "boolean",
                default: true,
                description: "flags=64.",
                displayOptions: {
                  show: { interactionAutoResponse: ["message"] },
                },
              },
              {
                displayName: "Auto Follow-up after ACK",
                name: "autoFollowup",
                noDataExpression: true,
                type: "boolean",
                default: true,
              },
              {
                displayName: "Auto Follow-up Content",
                name: "autoFollowupContent",
                type: "string",
                default: "✅ Received by n8n",
                displayOptions: { show: { autoFollowup: [true] } },
              },
            ],
          },
          {
            displayName: "Verification",
            name: "verify",
            values: [
              {
                displayName: "Verify Discord Signatures (Ed25519)",
                name: "verifyInteractions",
                noDataExpression: true,
                type: "boolean",
                default: true,
              },
              {
                displayName: "Require JSON Content-Type",
                name: "requireJson",
                noDataExpression: true,
                type: "boolean",
                default: false,
              },
              {
                displayName: "Include Raw Body",
                name: "includeRawBody",
                noDataExpression: true,
                type: "boolean",
                default: true,
              },
              {
                displayName: "Max Signature Timestamp Age (seconds, 0=off)",
                name: "maxTimestampAge",
                type: "number",
                default: 0,
                typeOptions: { minValue: 0, maxValue: 3600 },
              },
              {
                displayName: "Verify Forwarded Shared Secret (HMAC)",
                name: "verifyForwardedSecret",
                noDataExpression: true,
                type: "boolean",
                default: false,
              },
            ],
          },
          {
            displayName: "Filters",
            name: "filters",
            values: [
              {
                displayName: "Interaction Types",
                name: "allowTypes",
                noDataExpression: true,
                type: "multiOptions",
                options: [
                  { name: "Application Command", value: 2 },
                  { name: "Message Component", value: 3 },
                  { name: "Autocomplete", value: 4 },
                  { name: "Modal Submit", value: 5 },
                ],
                default: [],
              },
              {
                displayName: "Allow Command Names",
                name: "allowCommandNames",
                type: "string",
                default: "",
                description: "Comma/space/newline separated.",
              },
              {
                displayName: "Allow Custom ID Prefixes",
                name: "allowCustomIdPrefixes",
                type: "string",
                default: "",
                description: "For components/modals.",
              },
              {
                displayName: "Allow Guild IDs",
                name: "allowGuildIds",
                type: "string",
                default: "",
              },
              {
                displayName: "Allow Channel IDs",
                name: "allowChannelIds",
                type: "string",
                default: "",
              },
              {
                displayName: "Allow User IDs",
                name: "allowUserIds",
                type: "string",
                default: "",
              },
            ],
          },
          {
            displayName: "Advanced",
            name: "advanced",
            values: [
              {
                displayName: "Immediate ACK (Message) if None",
                name: "immediateAck",
                noDataExpression: true,
                type: "boolean",
                default: false,
                description:
                  "If auto-response=None, choose message over deferred for speed.",
              },
            ],
          },
        ],
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
    const headers = this.getHeaderData();
    const body = this.getBodyData() as any;

    const cred = await (this as any).getCredentials("discordApp");
    const applicationIdFromCred = (cred?.applicationId as string) || "";
    const publicKey = (cred?.publicKey as string) || "";
    const sharedSecret = (cred?.sharedSecret as string) || "";

    const opts = (this.getNodeParameter("options", 0, {}) as any) || {};
    const respMode = get<string>(opts, "response.responseMode", "onReceived");
    const splitIntoItems = !!get<boolean>(
      opts,
      "response.splitIntoItems",
      false
    );
    const autoResp = get<InteractionAutoResponse>(
      opts,
      "response.interactionAutoResponse",
      "deferred"
    );
    const respMsg = get<string>(
      opts,
      "response.interactionMessageContent",
      "Working on it..."
    );
    const respEphemeral = !!get<boolean>(
      opts,
      "response.interactionEphemeral",
      true
    );
    const autoFollowup = !!get<boolean>(opts, "response.autoFollowup", true);
    const autoFollowupContent = get<string>(
      opts,
      "response.autoFollowupContent",
      "✅ Received by n8n"
    );

    const verifyInteractions = !!get<boolean>(
      opts,
      "verify.verifyInteractions",
      true
    );
    const requireJson = !!get<boolean>(opts, "verify.requireJson", false);
    const includeRawBody = !!get<boolean>(opts, "verify.includeRawBody", true);
    const maxTimestampAge =
      Number(get<number>(opts, "verify.maxTimestampAge", 0)) || 0;
    const verifyForwardedSecret = !!get<boolean>(
      opts,
      "verify.verifyForwardedSecret",
      false
    );
    const immediateAck = !!get<boolean>(opts, "advanced.immediateAck", false);

    const allowTypes = new Set<number>(
      (get<any[]>(opts, "filters.allowTypes", []) as number[]) || []
    );
    const allowCommandNames = parseList(
      get<string>(opts, "filters.allowCommandNames", "")
    );
    const allowCustomIdPrefixes = parseList(
      get<string>(opts, "filters.allowCustomIdPrefixes", "")
    );
    const allowGuildIds = parseList(
      get<string>(opts, "filters.allowGuildIds", "")
    );
    const allowChannelIds = parseList(
      get<string>(opts, "filters.allowChannelIds", "")
    );
    const allowUserIds = parseList(
      get<string>(opts, "filters.allowUserIds", "")
    );

    const ct = String(headers["content-type"] || "").toLowerCase();
    const hasSig =
      !!headers["x-signature-ed25519"] && !!headers["x-signature-timestamp"];
    const isInteractionShape =
      body && typeof body.type === "number" && typeof body.token === "string";

    if (isInteractionShape && body.type === 1) {
      response.json({ type: 1 });
      const appId =
        applicationIdFromCred || (body.application_id as string) || "";
      const payload = {
        headers,
        query: this.getQueryData(),
        body,
        receivedAt: new Date().toISOString(),
        source: "interactions",
        applicationId: appId || undefined,
        followupUrl:
          appId && body?.token
            ? `https://discord.com/api/v10/webhooks/${appId}/${body.token}`
            : undefined,
      };
      const items = toItems(payload, splitIntoItems);
      return { noWebhookResponse: true, workflowData: [items] };
    }

    if (!hasSig && verifyForwardedSecret && sharedSecret) {
      const tsFwd = String(headers["x-timestamp"] || "");
      const sigFwd = String(headers["x-signature"] || "");
      const raw = (request as any).rawBody as Buffer | undefined;
      if (!raw || !tsFwd || !sigFwd) {
        response
          .status(401)
          .json({ error: "missing_forward_signature_headers" });
        return { noWebhookResponse: true };
      }
      const h = crypto.createHmac("sha256", sharedSecret);
      h.update(`${tsFwd}.${raw.toString("utf8")}`);
      const expected = h.digest("hex");
      if (expected !== sigFwd) {
        response.status(401).json({ error: "bad_forward_signature" });
        return { noWebhookResponse: true };
      }
    }

    if (requireJson && !ct.includes("application/json") && hasSig) {
      // allow signed requests even if content-type is altered by proxy
    } else if (requireJson && !ct.includes("application/json")) {
      response.status(415).json({ error: "unsupported_media_type" });
      return { noWebhookResponse: true };
    }

    if (verifyInteractions && hasSig) {
      const raw = (request as any).rawBody as Buffer | undefined;
      const ts = String(headers["x-signature-timestamp"] || "");
      const sigHex = String(headers["x-signature-ed25519"] || "");
      if (!publicKey) {
        response
          .status(401)
          .json({ error: "missing_public_key_in_credentials" });
        return { noWebhookResponse: true };
      }
      if (!raw || !ts || !sigHex) {
        response.status(401).json({ error: "invalid_request" });
        return { noWebhookResponse: true };
      }
      if (maxTimestampAge > 0) {
        const tsNum = Number(ts);
        if (Number.isFinite(tsNum)) {
          const now = Math.floor(Date.now() / 1000);
          if (Math.abs(now - tsNum) > maxTimestampAge) {
            response.status(401).json({ error: "timestamp_out_of_range" });
            return { noWebhookResponse: true };
          }
        }
      }
      const msg = Buffer.concat([Buffer.from(ts, "utf8"), raw]);
      const hexToBytes = (hex: string) =>
        new Uint8Array(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      const ok = nacl.sign.detached.verify(
        new Uint8Array(msg),
        hexToBytes(sigHex),
        hexToBytes(publicKey)
      );
      if (!ok) {
        response.status(401).json({ error: "bad_signature" });
        return { noWebhookResponse: true };
      }
    }

    const applicationId =
      applicationIdFromCred ||
      (isInteractionShape ? (body.application_id as string) : "") ||
      "";

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

    let matched = true;
    if (allowTypes.size && !allowTypes.has(Number(body?.type))) matched = false;
    if (
      matched &&
      allowGuildIds.size &&
      body?.guild_id &&
      !allowGuildIds.has(String(body.guild_id))
    )
      matched = false;
    if (
      matched &&
      allowChannelIds.size &&
      body?.channel_id &&
      !allowChannelIds.has(String(body.channel_id))
    )
      matched = false;
    const userId = body?.member?.user?.id || body?.user?.id;
    if (
      matched &&
      allowUserIds.size &&
      userId &&
      !allowUserIds.has(String(userId))
    )
      matched = false;
    if (matched && Number(body?.type) === 2 && allowCommandNames.size) {
      const cmd = String(body?.data?.name || "");
      if (!allowCommandNames.has(cmd)) matched = false;
    }
    if (
      matched &&
      (Number(body?.type) === 3 || Number(body?.type) === 5) &&
      allowCustomIdPrefixes.size
    ) {
      const cid = String(body?.data?.custom_id || "");
      if (!Array.from(allowCustomIdPrefixes).some((p) => cid.startsWith(p)))
        matched = false;
    }
    payload.filteredOut = !matched;

    if (isInteractionShape) {
      let mode = autoResp;
      if (mode === "none") {
        mode = immediateAck ? "message" : "deferred";
        if (respMode === "lastNode") mode = "deferred";
      }
      if (mode === "pong") {
        response.json({ type: 1 });
      } else if (mode === "deferred") {
        response.json({ type: 5 });
      } else if (mode === "message") {
        response.json({
          type: 4,
          data: {
            content: payload.filteredOut ? "Received." : respMsg,
            flags: respEphemeral ? 64 : 0,
          },
        });
      } else {
        response.json({ type: 5 });
      }

      if (autoFollowup && payload.followupUrl) {
        const content = autoFollowupContent;
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

      const items = toItems(payload, splitIntoItems);
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
