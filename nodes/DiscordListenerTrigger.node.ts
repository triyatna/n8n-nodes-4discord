import type {
  INodeType,
  INodeTypeDescription,
  ITriggerFunctions,
  ITriggerResponse,
  INodeExecutionData,
} from "n8n-workflow";
import WebSocket, { RawData } from "ws";

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

function parseIdList(input?: string): Set<string> {
  if (typeof input !== "string") return new Set();
  return new Set(
    input
      .split(/[\s,;]+/g)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function stripMentionsToChat(content?: string): string {
  if (typeof content !== "string") return "";
  return content
    .replace(/<@!?\d+>/g, "")
    .replace(/<@&\d+>/g, "")
    .replace(/<#\d+>/g, "")
    .replace(/@everyone/g, "")
    .replace(/@here/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCommandFromContent(
  content: string,
  opts: {
    prefix?: string;
    allowMentionPrefix?: boolean;
    botUserId?: string;
    applicationId?: string;
  }
): { used: boolean; name?: string; args_raw?: string; args?: string[] } {
  if (!content) return { used: false };
  const prefix = (opts.prefix ?? "!").trim();
  const allowMentionPrefix = opts.allowMentionPrefix ?? true;
  const mp: string[] = [];
  if (allowMentionPrefix && (opts.botUserId || opts.applicationId)) {
    if (opts.botUserId)
      mp.push(`<@${opts.botUserId}>`, `<@!${opts.botUserId}>`);
    if (opts.applicationId) mp.push(`<@${opts.applicationId}>`);
  }
  const trimmed = content.trimStart();
  let rest = "";
  if (prefix && trimmed.startsWith(prefix))
    rest = trimmed.slice(prefix.length).trimStart();
  else {
    const m = mp.find((s) => trimmed.startsWith(s));
    if (!m) return { used: false };
    rest = trimmed.slice(m.length).trimStart();
  }
  if (!rest) return { used: false };
  const m = rest.match(/^(\S+)\s*(.*)$/s);
  const name = m?.[1] || "";
  const args_raw = m?.[2] || "";
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let g: RegExpExecArray | null;
  while ((g = re.exec(args_raw))) args.push(g[1] ?? g[2] ?? g[3]);
  return { used: true, name, args_raw, args };
}

function computeMentionBotRobust(
  d: any,
  botUserId?: string,
  applicationId?: string,
  considerReply = true
): boolean | undefined {
  if (!botUserId && !applicationId) return undefined;
  const content: string | undefined =
    typeof d?.content === "string" ? d.content : undefined;
  if (botUserId && Array.isArray(d?.mentions) && d.mentions.length) {
    if (d.mentions.some((u: any) => u?.id === botUserId)) return true;
  }
  if (botUserId && content) {
    if (
      content.includes(`<@${botUserId}>`) ||
      content.includes(`<@!${botUserId}>`)
    )
      return true;
  }
  if (applicationId && content) {
    if (content.includes(`<@${applicationId}>`)) return true;
  }
  if (considerReply && botUserId) {
    const isReply = d?.type === 19 || !!d?.message_reference;
    const refAuthorId = d?.referenced_message?.author?.id;
    if (isReply && refAuthorId && refAuthorId === botUserId) return true;
  }
  return false;
}

function buildEmitType(t: string): string | undefined {
  switch (t) {
    case "MESSAGE_CREATE":
      return "message_create";
    case "MESSAGE_UPDATE":
      return "message_update";
    case "MESSAGE_DELETE":
      return "message_delete";
    case "MESSAGE_DELETE_BULK":
      return "message_delete_bulk";
    case "MESSAGE_REACTION_ADD":
      return "message_reaction_add";
    case "MESSAGE_REACTION_REMOVE":
      return "message_reaction_remove";
    case "MESSAGE_REACTION_REMOVE_ALL":
      return "message_reaction_remove_all";
    case "MESSAGE_REACTION_REMOVE_EMOJI":
      return "message_reaction_remove_emoji";
    case "CHANNEL_PINS_UPDATE":
      return "channel_pins_update";
    case "TYPING_START":
      return "typing_start";
    default:
      return undefined;
  }
}

export class DiscordListenerTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Discord Listener",
    name: "discordListenerTrigger",
    icon: "file:icons/discord.svg",
    group: ["trigger"],
    version: 1,
    description: "Listen to Discord Listener Socket events.",
    defaults: { name: "Discord Listener" },
    inputs: [],
    outputs: ["main"],
    credentials: [{ name: "discordApp", required: true }],
    properties: [
      {
        displayName: "Listening Intents",
        name: "listeningIntents",
        type: "multiOptions",
        options: [
          { name: "Guilds", value: INTENTS.GUILDS },
          { name: "Guild Messages", value: INTENTS.GUILD_MESSAGES },
          { name: "Direct Messages", value: INTENTS.DIRECT_MESSAGES },
          { name: "Message Reactions", value: INTENTS.GUILD_MESSAGE_REACTIONS },
          {
            name: "Message Content (privileged)",
            value: INTENTS.MESSAGE_CONTENT,
          },
        ],
        default: [
          INTENTS.GUILDS,
          INTENTS.GUILD_MESSAGES,
          INTENTS.DIRECT_MESSAGES,
          INTENTS.MESSAGE_CONTENT,
          INTENTS.GUILD_MESSAGE_REACTIONS,
        ],
      },
      {
        displayName: "Emit Events",
        name: "emitEvents",
        type: "multiOptions",
        options: [
          { name: "All (except READY/RESUMED)", value: "all" },
          { name: "Message Create", value: "message_create" },
          { name: "Message Update", value: "message_update" },
          { name: "Message Delete", value: "message_delete" },
          { name: "Message Delete Bulk", value: "message_delete_bulk" },
          { name: "Message Reaction Add", value: "message_reaction_add" },
          { name: "Message Reaction Remove", value: "message_reaction_remove" },
          {
            name: "Message Reaction Remove All",
            value: "message_reaction_remove_all",
          },
          {
            name: "Message Reaction Remove Emoji",
            value: "message_reaction_remove_emoji",
          },
          { name: "Channel Pins Update", value: "channel_pins_update" },
          { name: "Typing Start", value: "typing_start" },
        ],
        default: ["message_create"],
      },
      {
        displayName: "Auto Reconnect",
        name: "listeningAutoReconnect",
        type: "boolean",
        default: true,
      },
      {
        displayName: "Include Bot's Own Events",
        name: "listeningIncludeSelf",
        type: "boolean",
        default: false,
        description: "Filter out the bot's own events when OFF (default).",
      },
      {
        displayName: "Only Messages That Mention Bot",
        name: "onlyMentions",
        type: "boolean",
        default: false,
        description:
          "When ON, only messages that mention the bot are emitted. DMs are auto-exempt if Allow DMs is ON.",
      },
      {
        displayName: "Allow DMs",
        name: "allowDMs",
        type: "boolean",
        default: true,
      },

      {
        displayName: "Additional Fields",
        name: "additionalFields",
        type: "collection",
        placeholder: "Add Field",
        default: {},
        options: [
          {
            displayName: "Include Guild IDs",
            name: "includeGuildIds",
            type: "string",
            default: "",
            description: "Comma/space/newline separated.",
          },
          {
            displayName: "Exclude Guild IDs",
            name: "excludeGuildIds",
            type: "string",
            default: "",
            description: "Comma/space/newline separated.",
          },
          {
            displayName: "Include Channel IDs",
            name: "includeChannelIds",
            type: "string",
            default: "",
            description: "Comma/space/newline separated.",
          },
          {
            displayName: "Exclude Channel IDs",
            name: "excludeChannelIds",
            type: "string",
            default: "",
            description: "Comma/space/newline separated.",
          },
          {
            displayName: "Include User IDs",
            name: "includeUserIds",
            type: "string",
            default: "",
            description: "Comma/space/newline separated.",
          },
          {
            displayName: "Exclude User IDs",
            name: "excludeUserIds",
            type: "string",
            default: "",
            description: "Comma/space/newline separated.",
          },
        ],
      },

      {
        displayName: "Advanced Options",
        name: "advanced",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        options: [
          {
            displayName: "Immediate Heartbeat",
            name: "immediateHeartbeat",
            type: "boolean",
            default: true,
          },
          {
            displayName: "Resume Sessions",
            name: "resumeSessions",
            type: "boolean",
            default: true,
          },
          {
            displayName: "Prefetch Bot ID",
            name: "prefetchBotId",
            type: "boolean",
            default: true,
          },
          {
            displayName: "Heartbeat Jitter (ms)",
            name: "heartbeatJitterMs",
            type: "number",
            default: 0,
            typeOptions: { minValue: 0, maxValue: 5000 },
          },
          {
            displayName: "Dedupe Window (sec)",
            name: "dedupeWindowSec",
            type: "number",
            default: 10,
            typeOptions: { minValue: 0, maxValue: 120 },
          },
          {
            displayName: "Max Emit / Second",
            name: "maxEmitPerSecond",
            type: "number",
            default: 20,
            typeOptions: { minValue: 1, maxValue: 1000 },
          },
          {
            displayName: "Debounce Edits (ms)",
            name: "debounceEditsMs",
            type: "number",
            default: 0,
            typeOptions: { minValue: 0, maxValue: 60000 },
          },
          {
            displayName: "Backfill On Start",
            name: "enableBackfill",
            type: "boolean",
            default: false,
          },
          {
            displayName: "Backfill Channel IDs",
            name: "backfillChannelIds",
            type: "string",
            default: "",
            description: "IDs separated by comma/space/newline.",
            displayOptions: { show: { enableBackfill: [true] } },
          },
          {
            displayName: "Backfill Limit / Channel (1..100)",
            name: "backfillLimitPerChannel",
            type: "number",
            default: 10,
            typeOptions: { minValue: 1, maxValue: 100 },
            displayOptions: { show: { enableBackfill: [true] } },
          },
          {
            displayName: "Resolve Mentions",
            name: "resolveMentions",
            type: "boolean",
            default: true,
          },
          {
            displayName: "Parse Command",
            name: "parseCommand",
            type: "boolean",
            default: false,
          },
          {
            displayName: "Command Prefix",
            name: "commandPrefix",
            type: "string",
            default: "!",
            displayOptions: { show: { parseCommand: [true] } },
          },
          {
            displayName: "Allow Mention Prefix",
            name: "allowMentionPrefix",
            type: "boolean",
            default: true,
            displayOptions: { show: { parseCommand: [true] } },
          },
          {
            displayName: "Include Attachments",
            name: "includeAttachments",
            type: "boolean",
            default: true,
          },
          {
            displayName: "Self-filter Cache Size",
            name: "selfFilterCacheSize",
            type: "number",
            default: 2000,
            typeOptions: { minValue: 100, maxValue: 20000 },
          },
        ],
      },
    ],
  };

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const cred = await (this as any).getCredentials("discordApp");
    const tokenRaw = (cred?.botToken as string) || "";
    if (!tokenRaw)
      throw new Error("Bot Token is required in 'Discord App Credential'.");
    const token = tokenRaw.startsWith("Bot ") ? tokenRaw : `Bot ${tokenRaw}`;
    const applicationId: string | undefined = cred?.applicationId || undefined;

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

    const emitEvents = new Set<string>(
      (this.getNodeParameter("emitEvents", 0) as string[]) || ["message_create"]
    );

    const onlyMentions = this.getNodeParameter("onlyMentions", 0) as boolean;
    const allowDMs = this.getNodeParameter("allowDMs", 0) as boolean;

    const additional =
      (this.getNodeParameter("additionalFields", 0, {}) as any) || {};
    const includeGuildIds = parseIdList(additional.includeGuildIds);
    const excludeGuildIds = parseIdList(additional.excludeGuildIds);
    const includeChannelIds = parseIdList(additional.includeChannelIds);
    const excludeChannelIds = parseIdList(additional.excludeChannelIds);
    const includeUserIds = parseIdList(additional.includeUserIds);
    const excludeUserIds = parseIdList(additional.excludeUserIds);

    const advanced = (this.getNodeParameter("advanced", 0, {}) as any) || {};
    const immediateHeartbeat = !!advanced.immediateHeartbeat;
    const resumeSessions = advanced.resumeSessions !== false;
    const prefetchBotId = advanced.prefetchBotId !== false;
    const heartbeatJitterMs = Number.isFinite(advanced.heartbeatJitterMs)
      ? Number(advanced.heartbeatJitterMs)
      : 0;
    const dedupeWindowSec =
      Number.isFinite(advanced.dedupeWindowSec) && advanced.dedupeWindowSec >= 0
        ? Number(advanced.dedupeWindowSec)
        : 10;
    const maxEmitPerSecond =
      Number.isFinite(advanced.maxEmitPerSecond) &&
      advanced.maxEmitPerSecond > 0
        ? Number(advanced.maxEmitPerSecond)
        : 20;
    const debounceEditsMs =
      Number.isFinite(advanced.debounceEditsMs) && advanced.debounceEditsMs >= 0
        ? Number(advanced.debounceEditsMs)
        : 0;
    const enableBackfill = !!advanced.enableBackfill;
    const backfillChannelIds = parseIdList(
      advanced.backfillChannelIds as string
    );
    const backfillLimitPerChannel =
      Number.isFinite(advanced.backfillLimitPerChannel) &&
      advanced.backfillLimitPerChannel >= 1 &&
      advanced.backfillLimitPerChannel <= 100
        ? Number(advanced.backfillLimitPerChannel)
        : 10;
    const resolveMentions = advanced.resolveMentions !== false;
    const parseCommand = !!advanced.parseCommand;
    const commandPrefix =
      typeof advanced.commandPrefix === "string" &&
      advanced.commandPrefix.length
        ? advanced.commandPrefix
        : "!";
    const allowMentionPrefix = advanced.allowMentionPrefix !== false;
    const includeAttachments = advanced.includeAttachments !== false;
    const selfFilterCacheSize =
      Number.isFinite(advanced.selfFilterCacheSize) &&
      advanced.selfFilterCacheSize >= 100
        ? Number(advanced.selfFilterCacheSize)
        : 2000;

    let ws: WebSocket | undefined;
    let heartbeatInterval: NodeJS.Timeout | undefined;
    let heartbeatAcked = true;
    let sessionId: string | undefined;
    let seq: number | null = null;
    let closed = false;
    let botId: string | undefined;
    let ready = false;

    if (prefetchBotId) {
      try {
        const me = await (this as any).helpers.request({
          method: "GET",
          uri: "https://discord.com/api/v10/users/@me",
          headers: { Authorization: token },
          json: true,
        });
        if (me?.id) botId = String(me.id);
      } catch {}
    }

    const selfMsgIds = new Set<string>();
    const selfMsgQueue: string[] = [];
    const rememberSelfMsg = (id?: string) => {
      if (!id || selfMsgIds.has(id)) return;
      selfMsgIds.add(id);
      selfMsgQueue.push(id);
      while (selfMsgQueue.length > selfFilterCacheSize) {
        const rm = selfMsgQueue.shift();
        if (rm) selfMsgIds.delete(rm);
      }
    };

    const dedupeMap = new Map<string, number>();
    const dedupePrune = () => {
      const cutoff = Date.now() - dedupeWindowSec * 1000;
      for (const [k, t] of dedupeMap.entries())
        if (t < cutoff) dedupeMap.delete(k);
    };

    const editDebounce = new Map<string, number>();
    const emitQueue: INodeExecutionData[] = [];
    let lastEmit = 0;
    let emitTimer: NodeJS.Timeout | undefined;

    const emitDrain = () => {
      const interval = Math.max(1, Math.floor(1000 / maxEmitPerSecond));
      const now = Date.now();
      if (!emitQueue.length) return;
      if (now - lastEmit >= interval) {
        const item = emitQueue.shift()!;
        this.emit([[item]]);
        lastEmit = now;
      }
    };
    const ensureEmitTimer = () => {
      if (emitTimer) return;
      emitTimer = setInterval(() => {
        try {
          emitDrain();
        } catch {}
        if (!emitQueue.length) {
          clearInterval(emitTimer!);
          emitTimer = undefined;
        }
      }, Math.max(5, Math.floor(1000 / Math.min(maxEmitPerSecond, 1000))));
    };
    const pushEmit = (item: INodeExecutionData) => {
      emitQueue.push(item);
      ensureEmitTimer();
    };

    const doBackfill = async () => {
      if (!enableBackfill || backfillChannelIds.size === 0) return;
      for (const chId of backfillChannelIds) {
        try {
          const msgs = await (this as any).helpers.request({
            method: "GET",
            uri: `https://discord.com/api/v10/channels/${chId}/messages`,
            qs: { limit: backfillLimitPerChannel },
            headers: { Authorization: token },
            json: true,
          });
          if (Array.isArray(msgs)) {
            msgs.reverse();
            for (const m of msgs) {
              if (m?.author?.id && m.author.id === botId) rememberSelfMsg(m.id);
              const out = buildMessageItem("MESSAGE_CREATE", null, m, true);
              if (out) pushEmit(out);
            }
          }
        } catch {}
      }
    };

    const buildMessageItem = (
      t: string,
      s: number | null,
      d: any,
      backfill = false
    ): INodeExecutionData | undefined => {
      const emit_type = buildEmitType(t);
      if (!emit_type) return;

      const is_dm = !d?.guild_id;
      const guild_id = d?.guild_id;
      const channel_id = d?.channel_id ?? d?.id;
      const message_id =
        d?.id ?? d?.message_id ?? d?.message?.id ?? d?.referenced_message?.id;

      const from_self = !!(botId && d?.author?.id === botId);
      const rawContent = typeof d?.content === "string" ? d.content : "";
      const mention_bot =
        computeMentionBotRobust(d, botId, applicationId, true) ?? false;

      if (!allowDMs && is_dm) return;

      if (includeGuildIds.size && guild_id && !includeGuildIds.has(guild_id))
        return;
      if (excludeGuildIds.size && guild_id && excludeGuildIds.has(guild_id))
        return;

      if (
        includeChannelIds.size &&
        channel_id &&
        !includeChannelIds.has(String(channel_id))
      )
        return;
      if (
        excludeChannelIds.size &&
        channel_id &&
        excludeChannelIds.has(String(channel_id))
      )
        return;

      if (
        includeUserIds.size &&
        d?.author?.id &&
        !includeUserIds.has(d.author.id)
      )
        return;
      if (
        excludeUserIds.size &&
        d?.author?.id &&
        excludeUserIds.has(d.author.id)
      )
        return;

      const onlyMentionsEffective = onlyMentions && !(allowDMs && is_dm);
      if (onlyMentionsEffective && !mention_bot) return;

      if (dedupeWindowSec > 0) {
        const key = `${emit_type}:${message_id ?? ""}:${channel_id ?? ""}`;
        const now = Date.now();
        const last = dedupeMap.get(key) ?? 0;
        if (now - last < dedupeWindowSec * 1000) return;
        dedupeMap.set(key, now);
        if (dedupeMap.size > 5000) dedupePrune();
      }

      if (emit_type === "message_update" && debounceEditsMs > 0 && message_id) {
        const last = editDebounce.get(message_id) ?? 0;
        const now = Date.now();
        if (now - last < debounceEditsMs) return;
        editDebounce.set(message_id, now);
      }

      if (!includeSelf && from_self) return;
      if (emit_type === "message_create" && from_self)
        rememberSelfMsg(message_id);

      const content = rawContent;
      const chat = stripMentionsToChat(rawContent);

      const mentions: Array<{ type: string; id?: string; name?: string }> = [];
      if (resolveMentions) {
        if (Array.isArray(d?.mentions)) {
          for (const u of d.mentions)
            if (u?.id)
              mentions.push({
                type: "user",
                id: String(u.id),
                name: u?.username,
              });
        }
        if (Array.isArray(d?.mention_roles)) {
          for (const rid of d.mention_roles)
            mentions.push({ type: "role", id: String(rid) });
        }
        if (content) {
          const chMatches = content.match(/<#(\d+)>/g) || [];
          for (const m of chMatches)
            mentions.push({ type: "channel", id: m.replace(/[<#>]/g, "") });
          if (content.includes("@everyone"))
            mentions.push({ type: "everyone" });
          if (content.includes("@here")) mentions.push({ type: "here" });
        }
      }

      let attachments:
        | Array<{ id: string; filename: string; url: string; size?: number }>
        | undefined;
      if (includeAttachments && Array.isArray(d?.attachments)) {
        attachments = d.attachments.map((a: any) => ({
          id: String(a?.id ?? ""),
          filename: String(a?.filename ?? ""),
          url: String(a?.url ?? a?.proxy_url ?? ""),
          size: a?.size,
        }));
      }

      let command:
        | { used: boolean; name?: string; args_raw?: string; args?: string[] }
        | undefined;
      if (parseCommand && (content || chat)) {
        command = parseCommandFromContent(content, {
          prefix: commandPrefix,
          allowMentionPrefix,
          botUserId: botId,
          applicationId,
        });
      }

      return {
        json: {
          event: t,
          emit_type,
          meta: {
            receivedAt: new Date().toISOString(),
            source: "listener",
            seq: s ?? null,
            sessionId: sessionId ?? undefined,
            guild_id: guild_id ?? undefined,
            channel_id: channel_id ?? undefined,
            message_id: message_id ?? undefined,
            author_id: d?.author?.id ?? undefined,
            is_dm,
          },
          flags: {
            from_self,
            mention_bot,
            backfill: !!backfill,
          },
          message: emit_type.startsWith("message_")
            ? {
                id: message_id ?? undefined,
                content,
                chat,
                mentions: mentions.length ? mentions : undefined,
                attachments,
              }
            : undefined,
          command: command ?? { used: false },
          raw: d,
        },
      };
    };

    const shouldEmitBySelection = (t: string): boolean => {
      const emit_type = buildEmitType(t);
      if (!emit_type) return false;
      if (emitEvents.has("all")) return true;
      return emit_type ? emitEvents.has(emit_type) : false;
    };

    let attempt = 0;
    const nextDelay = () =>
      Math.min(30000, 2000 * Math.pow(1.6, attempt)) +
      Math.floor(Math.random() * 500);

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

    const teardown = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
      ws = undefined;
      ready = false;
    };

    const connect = () => {
      const wsLocal = new WebSocket(GATEWAY_URL);
      ws = wsLocal;

      wsLocal.on("open", () => {
        wsLocal.on("ping", () => {
          try {
            wsLocal.pong();
          } catch {}
        });
      });

      wsLocal.on("message", (data: RawData) => {
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
              const startDelay = Math.max(0, heartbeatJitterMs | 0);
              if (immediateHeartbeat) {
                setTimeout(() => {
                  try {
                    wsLocal.send(JSON.stringify(heartbeat()));
                    heartbeatAcked = false;
                  } catch {}
                }, startDelay);
              }
              heartbeatInterval = setInterval(() => {
                if (!heartbeatAcked) {
                  try {
                    wsLocal.close(4000, "Heartbeat not acknowledged");
                  } catch {}
                  return;
                }
                heartbeatAcked = false;
                try {
                  wsLocal.send(JSON.stringify(heartbeat()));
                } catch {}
              }, Math.max(30000, interval));
              if (sessionId && resumeSessions) {
                try {
                  wsLocal.send(JSON.stringify(resume()));
                } catch {}
              } else {
                try {
                  wsLocal.send(JSON.stringify(identify()));
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
                botId = d?.user?.id || botId;
                ready = true;
                attempt = 0;
                void doBackfill();
                break;
              }
              if (t === "RESUMED") {
                ready = true;
                attempt = 0;
                break;
              }
              if (!shouldEmitBySelection(t)) break;

              if (!includeSelf && botId) {
                if (t === "MESSAGE_CREATE") {
                  if (d?.author?.id === botId) {
                    rememberSelfMsg(d?.id);
                    break;
                  }
                } else if (t === "MESSAGE_UPDATE") {
                  const isSelf =
                    (d?.author?.id && d.author.id === botId) ||
                    (d?.id && selfMsgIds.has(d.id));
                  if (isSelf) break;
                } else if (t === "MESSAGE_DELETE") {
                  if (d?.id && selfMsgIds.has(d.id)) break;
                } else if (t === "MESSAGE_DELETE_BULK") {
                  if (Array.isArray(d?.ids)) {
                    const filtered = d.ids.filter(
                      (id: string) => !selfMsgIds.has(id)
                    );
                    if (!filtered.length) break;
                    d = { ...d, ids: filtered };
                  }
                } else if (
                  t === "MESSAGE_REACTION_ADD" ||
                  t === "MESSAGE_REACTION_REMOVE"
                ) {
                  if (d?.user_id && d.user_id === botId) break;
                } else if (t === "TYPING_START") {
                  if (d?.user_id && d.user_id === botId) break;
                }
              }

              const emitItem = buildMessageItem(t, s ?? null, d, false);
              if (emitItem) pushEmit(emitItem);
              break;
            }
            case 7: {
              try {
                wsLocal.close(4000, "Server requested reconnect");
              } catch {}
              break;
            }
            case 9: {
              sessionId = undefined;
              ready = false;
              setTimeout(() => {
                try {
                  wsLocal.send(JSON.stringify(identify()));
                } catch {}
              }, 1200 + Math.floor(Math.random() * 600));
              break;
            }
            default:
              break;
          }
        } catch {}
      });

      wsLocal.on("close", () => {
        teardown();
        if (!closed && autoReconnect) {
          attempt++;
          setTimeout(connect, nextDelay());
        }
      });

      wsLocal.on("error", () => {});
    };

    connect();

    return {
      closeFunction: async () => {
        closed = true;
        try {
          ws?.close(1000, "Manual close");
        } catch {}
        teardown();
        if (emitTimer) clearInterval(emitTimer);
      },
    };
  }
}
