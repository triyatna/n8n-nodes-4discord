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
function customUUID() {
  const rand = () => Math.random().toString(36).substring(2, 10);
  return `${rand()}-${rand()}-${rand()}-${rand()}`;
}

export class DiscordInteractionsTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Discord Interactions",
    name: "discordInteractionsTrigger",
    icon: "file:../../icons/discord.svg",
    group: ["trigger"],
    version: 1,
    description: "Receive Discord Interactions via HTTP Webhook.",
    eventTriggerDescription: "Waiting for you to call the Test URL",
    activationMessage: "You can now make calls to your production webhook URL.",
    defaults: { name: "Discord Interactions" },
    inputs: [],
    outputs: ["main"],
    credentials: [{ name: "discordApp", required: true }],

    webhooks: [
      {
        name: "default",
        httpMethod: "POST",
        responseMode: "onReceived",
        path: '={{$parameter["path"] + "/discord-interactions"}}',
      },
    ],

    properties: [
      // Basic route
      {
        displayName: "Path",
        name: "path",
        type: "string",
        default: customUUID(),
        placeholder: "Path",
        required: true,
        description:
          "Custom segment before '/discord-interactions'. Full URL appears once the node is added.",
      },

      // Verification (top-level)
      {
        displayName: "Verify Discord Signatures (Ed25519)",
        name: "verifyInteractions",
        type: "boolean",
        noDataExpression: true,
        default: true,
      },
      {
        displayName: "Require JSON Content-Type",
        name: "requireJson",
        type: "boolean",
        noDataExpression: true,
        default: false,
      },
      {
        displayName: "Include Raw Body",
        name: "includeRawBody",
        type: "boolean",
        noDataExpression: true,
        default: true,
      },
      {
        displayName: "Max Signature Timestamp Age (seconds, 0=off)",
        name: "maxTimestampAge",
        type: "number",
        noDataExpression: true,
        default: 0,
        typeOptions: { minValue: 0, maxValue: 3600 },
      },
      {
        displayName: "Verify Forwarded Shared Secret (HMAC)",
        name: "verifyForwardedSecret",
        type: "boolean",
        noDataExpression: true,
        default: false,
        description:
          "Validate X-Timestamp/X-Signature = HMAC-SHA256(`${ts}.${rawBody}`) using credential's shared secret.",
      },
      {
        displayName: "Enforce Application ID Match",
        name: "enforceApplicationIdMatch",
        type: "boolean",
        noDataExpression: true,
        default: false,
        description:
          "Reject when request application_id does not match credentials.applicationId.",
      },

      // Response (top-level, simpler UX)
      {
        displayName: "Response Mode",
        name: "responseMode",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "On Received (immediate)", value: "onReceived" },
          { name: "Last Node", value: "lastNode" },
        ],
        default: "onReceived",
        description:
          "Immediate reply (good for building) or wait for last node (good for production).",
      },
      {
        displayName: "Split Into Items (if body is array)",
        name: "splitIntoItems",
        type: "boolean",
        noDataExpression: true,
        default: false,
      },
      {
        displayName: "Interaction Auto-Response",
        name: "interactionAutoResponse",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "None", value: "none" },
          { name: "PONG", value: "pong" },
          { name: "Deferred (ACK)", value: "deferred" },
          { name: "Message (ACK + content)", value: "message" },
        ],
        default: "deferred",
        description: "Auto-ACK within 3s window.",
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
        noDataExpression: true,
        default: true,
        description: "flags=64 (visible only to the invoker).",
        displayOptions: { show: { interactionAutoResponse: ["message"] } },
      },
      // Advanced group (sub-collection)
      {
        displayName: "Advanced",
        name: "advanced",
        type: "collection",
        default: {},
        options: [
          {
            displayName: "Immediate ACK (Message) if None",
            name: "immediateAck",
            type: "boolean",
            noDataExpression: true,
            default: false,
            description:
              "When auto-response=None, prefer message over deferred for speed.",
          },
          {
            displayName: "204 No Content When Filtered (non-interaction)",
            name: "noContentWhenFiltered",
            type: "boolean",
            noDataExpression: true,
            default: false,
          },
        ],
      },
      // Options (as nested collections — no more invalid "values" under collection)
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        placeholder: "Add Option Group",
        default: {},
        options: [
          // Filters group (sub-collection)
          {
            displayName: "Filters",
            name: "filters",
            type: "collection",
            default: {},
            options: [
              {
                displayName: "Interaction Types",
                name: "allowTypes",
                type: "multiOptions",
                noDataExpression: true,
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
                displayName: "Allow Command IDs",
                name: "allowCommandIds",
                type: "string",
                default: "",
                description: "Comma/space/newline separated (exact ids).",
              },
              {
                displayName: "Allow Custom ID Prefixes",
                name: "allowCustomIdPrefixes",
                type: "string",
                default: "",
                description: "For components/modals (prefix match).",
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
              {
                displayName: "Guild Only",
                name: "guildOnly",
                type: "boolean",
                noDataExpression: true,
                default: false,
                description: "Reject interactions without guild_id when ON.",
              },
            ],
          },

          // Follow-ups group (sub-collection)
          {
            displayName: "Follow-ups",
            name: "followups",
            type: "collection",
            default: {},
            options: [
              {
                displayName: "Auto Follow-up after ACK",
                name: "autoFollowup",
                type: "boolean",
                noDataExpression: true,
                default: true,
              },
              {
                displayName: "Auto Follow-up Content",
                name: "autoFollowupContent",
                type: "string",
                default: "✅ Received by n8n",
                displayOptions: { show: { autoFollowup: [true] } },
              },
              {
                displayName: "Follow-up Delay (ms)",
                name: "followupDelayMs",
                type: "number",
                noDataExpression: true,
                default: 0,
                typeOptions: { minValue: 0, maxValue: 60000 },
                displayOptions: { show: { autoFollowup: [true] } },
              },
              {
                displayName: "Silent when filtered",
                name: "silentWhenFiltered",
                type: "boolean",
                noDataExpression: true,
                default: false,
                description:
                  "Do not send follow-up if the event was filtered out.",
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

    // Top-level flags
    const verifyInteractions = this.getNodeParameter(
      "verifyInteractions",
      0
    ) as boolean;
    const requireJson = this.getNodeParameter("requireJson", 0) as boolean;
    const includeRawBody = this.getNodeParameter(
      "includeRawBody",
      0
    ) as boolean;
    const maxTimestampAge =
      Number(this.getNodeParameter("maxTimestampAge", 0)) || 0;
    const verifyForwardedSecret = this.getNodeParameter(
      "verifyForwardedSecret",
      0
    ) as boolean;
    const enforceAppIdMatch = this.getNodeParameter(
      "enforceApplicationIdMatch",
      0
    ) as boolean;

    // Response (top-level)
    const respMode = this.getNodeParameter("responseMode", 0) as string;
    const splitIntoItems = this.getNodeParameter(
      "splitIntoItems",
      0
    ) as boolean;
    const autoResp = this.getNodeParameter(
      "interactionAutoResponse",
      0
    ) as InteractionAutoResponse;
    const respMsg = this.getNodeParameter(
      "interactionMessageContent",
      0
    ) as string;
    const respEphemeral = this.getNodeParameter(
      "interactionEphemeral",
      0
    ) as boolean;

    // Optional groups
    const opts = (this.getNodeParameter("options", 0, {}) as any) || {};

    const filters = {
      allowTypes: new Set<number>(
        (get<any[]>(opts, "filters.allowTypes", []) as number[]) || []
      ),
      allowCommandNames: parseList(
        get<string>(opts, "filters.allowCommandNames", "")
      ),
      allowCommandIds: parseList(
        get<string>(opts, "filters.allowCommandIds", "")
      ),
      allowCustomIdPrefixes: parseList(
        get<string>(opts, "filters.allowCustomIdPrefixes", "")
      ),
      allowGuildIds: parseList(get<string>(opts, "filters.allowGuildIds", "")),
      allowChannelIds: parseList(
        get<string>(opts, "filters.allowChannelIds", "")
      ),
      allowUserIds: parseList(get<string>(opts, "filters.allowUserIds", "")),
      guildOnly: !!get<boolean>(opts, "filters.guildOnly", false),
    };

    const autoFollowup = !!get<boolean>(opts, "followups.autoFollowup", false);
    const autoFollowupContent = get<string>(
      opts,
      "followups.autoFollowupContent",
      "✅ Received by n8n"
    );
    const followupDelayMs =
      Number(get<number>(opts, "followups.followupDelayMs", 0)) || 0;
    const silentWhenFiltered = !!get<boolean>(
      opts,
      "followups.silentWhenFiltered",
      false
    );

    const immediateAck = !!get<boolean>(opts, "advanced.immediateAck", false);
    const noContentWhenFiltered = !!get<boolean>(
      opts,
      "advanced.noContentWhenFiltered",
      false
    );

    // Validation / verification
    const ct = String(headers["content-type"] || "").toLowerCase();
    const hasSig =
      !!headers["x-signature-ed25519"] && !!headers["x-signature-timestamp"];
    const isInteractionShape =
      body && typeof body.type === "number" && typeof body.token === "string";

    // Optional HMAC (proxy/CDN)
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
      // allow via signed proxies with wrong content-type
    } else if (requireJson && !ct.includes("application/json")) {
      response.status(415).json({ error: "unsupported_media_type" });
      return { noWebhookResponse: true };
    }

    if (verifyInteractions) {
      const raw = (request as any).rawBody as Buffer | undefined;
      const ts = String(headers["x-signature-timestamp"] || "");
      const sigHex = String(headers["x-signature-ed25519"] || "");
      if (!hasSig || !raw || !ts || !sigHex) {
        response.status(401).json({ error: "invalid_request" });
        return { noWebhookResponse: true };
      }
      if (!publicKey) {
        response
          .status(401)
          .json({ error: "missing_public_key_in_credentials" });
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

    if (isInteractionShape && enforceAppIdMatch) {
      const appFromReq = String(body?.application_id || "");
      if (
        applicationIdFromCred &&
        appFromReq &&
        appFromReq !== applicationIdFromCred
      ) {
        response.status(401).json({ error: "application_id_mismatch" });
        return { noWebhookResponse: true };
      }
    }

    // PING first
    if (isInteractionShape && body.type === 1) {
      response.json({ type: 1 });
      const appId =
        applicationIdFromCred || (body.application_id as string) || "";
      const payloadPing = {
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
      const itemsPing = toItems(payloadPing, splitIntoItems);
      return { noWebhookResponse: true, workflowData: [itemsPing] };
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

    // Filtering
    let matched = true;
    if (filters.guildOnly && !body?.guild_id) matched = false;
    if (filters.allowTypes.size && !filters.allowTypes.has(Number(body?.type)))
      matched = false;
    if (
      matched &&
      filters.allowGuildIds.size &&
      body?.guild_id &&
      !filters.allowGuildIds.has(String(body.guild_id))
    )
      matched = false;
    if (
      matched &&
      filters.allowChannelIds.size &&
      body?.channel_id &&
      !filters.allowChannelIds.has(String(body.channel_id))
    )
      matched = false;
    const userId = body?.member?.user?.id || body?.user?.id;
    if (
      matched &&
      filters.allowUserIds.size &&
      userId &&
      !filters.allowUserIds.has(String(userId))
    )
      matched = false;

    if (matched && Number(body?.type) === 2) {
      if (filters.allowCommandNames.size) {
        const cmdName = String(body?.data?.name || "");
        if (!filters.allowCommandNames.has(cmdName)) matched = false;
      }
      if (matched && filters.allowCommandIds.size) {
        const cmdId = String(body?.data?.id || "");
        if (!filters.allowCommandIds.has(cmdId)) matched = false;
      }
    }
    if (
      matched &&
      (Number(body?.type) === 3 || Number(body?.type) === 5) &&
      filters.allowCustomIdPrefixes.size
    ) {
      const cid = String(body?.data?.custom_id || "");
      if (
        !Array.from(filters.allowCustomIdPrefixes).some((p) =>
          cid.startsWith(p)
        )
      )
        matched = false;
    }
    payload.filteredOut = !matched;

    // Auto-response
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

      // Optional follow-up
      if (
        autoFollowup &&
        payload.followupUrl &&
        !(silentWhenFiltered && payload.filteredOut)
      ) {
        const content = autoFollowupContent;
        const delay = Math.max(0, followupDelayMs | 0);
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
        }, delay);
      }

      const items = toItems(payload, splitIntoItems);
      return { noWebhookResponse: true, workflowData: [items] };
    }

    // Non-interaction request
    const items = toItems(payload, splitIntoItems);
    if (noContentWhenFiltered && payload.filteredOut) {
      response.status(204).send();
      return { noWebhookResponse: true, workflowData: [items] };
    }
    if (respMode === "onReceived") {
      response.json({ ok: true });
      return { noWebhookResponse: true, workflowData: [items] };
    }
    return { workflowData: [items] };
  }
}
