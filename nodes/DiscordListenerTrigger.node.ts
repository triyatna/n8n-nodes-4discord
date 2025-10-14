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

// ---- Helpers ----
function computeMentionBot(d: any, botId?: string): boolean | undefined {
  if (!botId) return undefined;
  if (Array.isArray(d?.mentions) && d.mentions.length) {
    if (d.mentions.some((u: any) => u?.id === botId)) return true;
  }
  const content: string | undefined =
    typeof d?.content === "string" ? d.content : undefined;
  if (content) {
    if (content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`))
      return true;
  }
  return false;
}

function stripMentions(raw?: string): string {
  if (typeof raw !== "string" || !raw) return "";
  let s = raw;
  s = s.replace(/<@!?(\d+)>/g, "");
  s = s.replace(/<@&(\d+)>/g, "");
  s = s.replace(/<#(\d+)>/g, "");
  s = s.replace(/@everyone/g, "");
  s = s.replace(/@here/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
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
          "Enable MESSAGE CONTENT intent in the Dev Portal if you need message content.",
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
        description:
          "If turned off (default), events from the bot itself are not emitted to avoid loops/spam.",
      },
      {
        displayName: "Self-filter Cache Size",
        name: "selfFilterCacheSize",
        type: "number",
        default: 2000,
        typeOptions: { minValue: 100, maxValue: 20000 },
        description:
          "Number of bot message IDs stored to filter MESSAGE_UPDATE/DELETE/BULK.",
      },
    ],
  };

  async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
    const cred = await (this as any).getCredentials("discordApp");
    const tokenRaw = (cred?.botToken as string) || "";
    if (!tokenRaw) {
      throw new Error(
        "Bot Token is required in 'Discord App Credential' for the Listener node."
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
    let ready = false;

    let attempt = 0;
    const nextDelay = () =>
      Math.min(30000, 2000 * Math.pow(1.6, attempt)) +
      Math.floor(Math.random() * 500);

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

    const emitEvent = (t: string, s: number | null, d: any) => {
      if (!ready && t !== "READY" && t !== "RESUMED") return;

      let mention_bot: boolean | undefined = undefined;
      let contentOut: string | undefined = undefined;
      let chatOut: string | undefined = undefined;

      if (t === "MESSAGE_CREATE" || t === "MESSAGE_UPDATE") {
        mention_bot = computeMentionBot(d, botId);
        const rawContent = typeof d?.content === "string" ? d.content : "";
        contentOut = rawContent;
        chatOut = stripMentions(rawContent);
      }

      const item: INodeExecutionData = {
        json: {
          op: 0,
          t,
          s,
          d,
          mention_bot,
          chat: chatOut,
          receivedAt: new Date().toISOString(),
          source: "listener",
        },
      };
      this.emit([[item]]);
    };

    const teardown = () => {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = undefined;
      ws = undefined;
      ready = false;
    };

    const connect = () => {
      ws = new WebSocket(GATEWAY_URL);

      ws.on("open", () => {
        ws?.on("ping", () => {
          try {
            ws?.pong();
          } catch {}
        });
      });

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

              try {
                ws?.send(JSON.stringify(heartbeat()));
                heartbeatAcked = false;
              } catch {}

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
              }, Math.max(30000, interval));

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
                ready = true;
                attempt = 0;
              } else if (t === "RESUMED") {
                ready = true;
                attempt = 0;
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
                t === "CHANNEL_PINS_UPDATE"
              ) {
                emitEvent(t, s ?? null, d);
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
              ready = false;
              setTimeout(() => {
                try {
                  ws?.send(JSON.stringify(identify()));
                } catch {}
              }, 1200 + Math.floor(Math.random() * 600));
              break;
            }
            default:
              break;
          }
        } catch {}
      });

      ws.on("close", () => {
        teardown();
        if (!closed && autoReconnect) {
          attempt++;
          const delay = nextDelay();
          setTimeout(connect, delay);
        }
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
        teardown();
      },
    };
  }
}
