import type {
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
import { discordApiRequest, encodeEmoji } from "../transport";

/** Konversi style button → integer Discord */
function styleToInt(style: string): number {
  switch ((style || "").toLowerCase()) {
    case "primary":
      return 1;
    case "secondary":
      return 2;
    case "success":
      return 3;
    case "danger":
      return 4;
    case "link":
      return 5;
    default:
      return 1;
  }
}

/** Builder sederhana untuk components (buttons/select) */
function buildComponents(helper: any): any[] {
  const rows = Array.isArray(helper?.rows) ? helper.rows : [];
  const components: any[] = [];
  for (const row of rows.slice(0, 5)) {
    const items = Array.isArray(row) ? row : [];
    const built: any[] = [];
    for (const it of items.slice(0, 5)) {
      const type = (it.type || "").toLowerCase();
      if (!type || type === "button") {
        const base: any = {
          type: 2,
          label: String(it.label ?? ""),
          style: styleToInt(String(it.style ?? "primary")),
        };
        if (base.style === 5) {
          if (!it.url) continue;
          base.url = String(it.url);
        } else {
          base.custom_id = String(
            it.custom_id || it.customId || it.id || "btn"
          );
        }
        built.push(base);
      } else if (type === "string_select" || type === "select") {
        const options = Array.isArray(it.options)
          ? it.options.slice(0, 25)
          : [];
        built.push({
          type: 3,
          custom_id: String(it.custom_id || it.customId || it.id || "select"),
          min_values: it.min_values ?? 0,
          max_values: it.max_values ?? 1,
          options: options.map((o: any) => ({
            label: String(o.label ?? o.value ?? ""),
            value: String(o.value ?? o.label ?? ""),
            description: o.description ? String(o.description) : undefined,
            emoji: o.emoji,
            default: !!o.default,
          })),
          placeholder: it.placeholder ? String(it.placeholder) : undefined,
        });
      }
    }
    if (built.length) components.push({ type: 1, components: built });
  }
  return components;
}

export class Discord implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Discord",
    name: "discord",
    icon: "file:../../icons/discord.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
    description: "Interact with Discord REST API v10",
    defaults: { name: "Discord" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "discordApp", required: true }],
    properties: [
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        options: [
          { name: "Channel", value: "channel" },
          { name: "Message", value: "message" },
          { name: "Member", value: "member" },
          { name: "Interaction", value: "interaction" },
        ],
        default: "message",
      },

      /* -------------------------- CHANNEL -------------------------- */
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        displayOptions: { show: { resource: ["channel"] } },
        options: [
          { name: "Create", value: "create" },
          { name: "Update", value: "update" },
          { name: "Get", value: "get" },
          { name: "Get Many", value: "getAll" },
          { name: "Delete", value: "delete" },
        ],
        default: "get",
      },
      {
        displayName: "Guild ID",
        name: "guildId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: { resource: ["channel"], operation: ["create", "getAll"] },
        },
      },
      {
        displayName: "Channel ID",
        name: "channelId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["channel"],
            operation: ["get", "update", "delete"],
          },
        },
      },
      {
        displayName: "Name",
        name: "name",
        type: "string",
        default: "",
        required: true,
        displayOptions: {
          show: { resource: ["channel"], operation: ["create"] },
        },
      },
      {
        displayName: "Channel Type",
        name: "type",
        type: "options",
        options: [
          { name: "Text", value: 0 },
          { name: "Voice", value: 2 },
          { name: "Category", value: 4 },
          { name: "Announcement", value: 5 },
          { name: "Stage Voice", value: 13 },
          { name: "Forum", value: 15 },
        ],
        default: 0,
        displayOptions: {
          show: { resource: ["channel"], operation: ["create"] },
        },
      },
      {
        displayName: "Additional Fields",
        name: "additionalFields",
        type: "collection",
        placeholder: "Add Field",
        default: {},
        options: [
          {
            displayName: "Parent ID",
            name: "parent_id",
            type: "string",
            default: "",
          },
          { displayName: "Topic", name: "topic", type: "string", default: "" },
          {
            displayName: "NSFW",
            name: "nsfw",
            type: "boolean",
            default: false,
          },
          {
            displayName: "Bitrate",
            name: "bitrate",
            type: "number",
            default: 64000,
          },
          {
            displayName: "User Limit",
            name: "user_limit",
            type: "number",
            default: 0,
          },
        ],
        displayOptions: {
          show: { resource: ["channel"], operation: ["create", "update"] },
        },
      },

      /* -------------------------- MESSAGE -------------------------- */
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        displayOptions: { show: { resource: ["message"] } },
        options: [
          { name: "Send", value: "send" },
          { name: "Send and Wait", value: "sendAndWait" },
          { name: "Get", value: "get" },
          { name: "Get Many", value: "getAll" },
          { name: "Delete", value: "delete" },
          { name: "Create Reaction", value: "createReaction" },
          {
            name: "Create Thread From Message",
            value: "createThreadFromMessage",
          },
          { name: "Create Thread", value: "createThread" },
          { name: "Join Thread", value: "joinThread" },
          { name: "Leave Thread", value: "leaveThread" },
          { name: "Pin", value: "pin" },
          { name: "Unpin", value: "unpin" },
          { name: "Bulk Delete", value: "bulkDelete" },
        ],
        default: "send",
      },
      {
        displayName: "Guild ID",
        name: "guildId",
        type: "string",
        required: true,
        default: "",
        description: "For loading Channels/Roles options",
        displayOptions: { show: { resource: ["message"] } },
      },
      {
        displayName: "Channel ID",
        name: "channelId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getChannels" },
        required: true,
        default: "",
        displayOptions: { show: { resource: ["message"] } },
      },
      {
        displayName: "Message ID",
        name: "messageId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["message"],
            operation: [
              "get",
              "delete",
              "createReaction",
              "createThreadFromMessage",
              "pin",
              "unpin",
            ],
          },
        },
      },
      {
        displayName: "Thread ID",
        name: "threadId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: {
            resource: ["message"],
            operation: ["joinThread", "leaveThread"],
          },
        },
      },
      {
        displayName: "Content",
        name: "content",
        type: "string",
        default: "",
        displayOptions: {
          show: { resource: ["message"], operation: ["send", "sendAndWait"] },
        },
      },
      {
        displayName: "Use Components Helper",
        name: "useComponentsHelper",
        type: "boolean",
        default: false,
        displayOptions: {
          show: { resource: ["message"], operation: ["send", "sendAndWait"] },
        },
      },
      {
        displayName: "Components Helper (JSON)",
        name: "componentsHelper",
        type: "json",
        default:
          '{"rows":[[{"label":"Approve","style":"primary","custom_id":"approve"}]]}',
        displayOptions: {
          show: {
            resource: ["message"],
            operation: ["send", "sendAndWait"],
            useComponentsHelper: [true],
          },
        },
      },
      {
        displayName: "Binary Property (Attachment)",
        name: "binaryPropertyName",
        type: "string",
        default: "",
        displayOptions: {
          show: { resource: ["message"], operation: ["send", "sendAndWait"] },
        },
      },
      {
        displayName: "Additional Body",
        name: "additionalBody",
        type: "json",
        default: "{}",
        displayOptions: {
          show: {
            resource: ["message"],
            operation: [
              "send",
              "sendAndWait",
              "createThread",
              "createThreadFromMessage",
            ],
          },
        },
      },
      {
        displayName: "Thread Name",
        name: "threadName",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: ["message"],
            operation: ["createThread", "createThreadFromMessage"],
          },
        },
      },
      {
        displayName: "Auto-Archive Duration (minutes)",
        name: "autoArchiveDuration",
        type: "options",
        options: [
          { name: "60", value: 60 },
          { name: "1440 (24h)", value: 1440 },
          { name: "4320 (3d)", value: 4320 },
          { name: "10080 (7d)", value: 10080 },
        ],
        default: 1440,
        displayOptions: {
          show: {
            resource: ["message"],
            operation: ["createThread", "createThreadFromMessage"],
          },
        },
      },
      {
        displayName: "Messages to Return",
        name: "limit",
        type: "number",
        default: 50,
        typeOptions: { minValue: 1, maxValue: 1000 },
        displayOptions: {
          show: { resource: ["message"], operation: ["getAll"] },
        },
      },
      {
        displayName: "Message IDs",
        name: "messageIds",
        type: "string",
        default: "",
        displayOptions: {
          show: { resource: ["message"], operation: ["bulkDelete"] },
        },
      },
      {
        displayName: "Emoji",
        name: "emoji",
        type: "string",
        default: "👍",
        displayOptions: {
          show: { resource: ["message"], operation: ["createReaction"] },
        },
      },
      {
        displayName: "Timeout (seconds)",
        name: "timeoutSec",
        type: "number",
        default: 60,
        typeOptions: { minValue: 1, maxValue: 900 },
        displayOptions: {
          show: { resource: ["message"], operation: ["sendAndWait"] },
        },
      },
      {
        displayName: "Reply Filter",
        name: "replyFilter",
        type: "collection",
        placeholder: "Add Filter",
        default: {},
        options: [
          {
            displayName: "Only From User ID",
            name: "fromUserId",
            type: "string",
            default: "",
          },
          {
            displayName: "Must Contain Text",
            name: "includes",
            type: "string",
            default: "",
          },
        ],
        displayOptions: {
          show: { resource: ["message"], operation: ["sendAndWait"] },
        },
      },

      /* -------------------------- MEMBER -------------------------- */
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        displayOptions: { show: { resource: ["member"] } },
        options: [
          { name: "Get Many", value: "getAll" },
          { name: "Add Role", value: "addRole" },
          { name: "Remove Role", value: "removeRole" },
        ],
        default: "getAll",
      },
      {
        displayName: "Guild ID",
        name: "guildId",
        type: "string",
        required: true,
        default: "",
        displayOptions: { show: { resource: ["member"] } },
      },
      {
        displayName: "User ID",
        name: "userId",
        type: "string",
        required: true,
        default: "",
        displayOptions: {
          show: { resource: ["member"], operation: ["addRole", "removeRole"] },
        },
      },
      {
        displayName: "Role ID",
        name: "roleId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getRoles" },
        required: true,
        default: "",
        displayOptions: {
          show: { resource: ["member"], operation: ["addRole", "removeRole"] },
        },
      },

      /* -------------------------- INTERACTION -------------------------- */
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        displayOptions: { show: { resource: ["interaction"] } },
        options: [
          {
            name: "Open Modal",
            value: "openModal",
            description: "Respond with a modal (type 9)",
          },
          {
            name: "Respond Autocomplete",
            value: "respondAutocomplete",
            description: "Return choices (type 8)",
          },
          {
            name: "Send Follow-up",
            value: "sendFollowup",
            description: "POST /webhooks/{app}/{token}",
          },
          {
            name: "Edit Original Response",
            value: "editOriginal",
            description: "PATCH /webhooks/{app}/{token}/messages/@original",
          },
          {
            name: "Delete Original Response",
            value: "deleteOriginal",
            description: "DELETE /webhooks/{app}/{token}/messages/@original",
          },
          {
            name: "Edit Follow-up",
            value: "editFollowup",
            description: "PATCH /webhooks/{app}/{token}/messages/{messageId}",
          },
          {
            name: "Delete Follow-up",
            value: "deleteFollowup",
            description: "DELETE /webhooks/{app}/{token}/messages/{messageId}",
          },
        ],
        default: "sendFollowup",
      },
      {
        displayName: "Application ID",
        name: "applicationId",
        type: "string",
        default: "",
        description: "Your application (bot) ID",
        displayOptions: {
          show: {
            resource: ["interaction"],
            operation: [
              "sendFollowup",
              "editOriginal",
              "deleteOriginal",
              "editFollowup",
              "deleteFollowup",
            ],
          },
        },
      },
      {
        displayName: "Interaction ID",
        name: "interactionId",
        type: "string",
        default: "",
        description: "From the trigger payload",
        displayOptions: {
          show: {
            resource: ["interaction"],
            operation: ["openModal", "respondAutocomplete"],
          },
        },
      },
      {
        displayName: "Interaction/Webhook Token",
        name: "interactionToken",
        type: "string",
        default: "",
        description: "From the trigger payload (token)",
        displayOptions: { show: { resource: ["interaction"] } },
      },
      {
        displayName: "Content",
        name: "content",
        type: "string",
        default: "",
        displayOptions: {
          show: { resource: ["interaction"], operation: ["sendFollowup"] },
        },
      },
      {
        displayName: "Additional Body",
        name: "additionalBody",
        type: "json",
        default: "{}",
        displayOptions: {
          show: {
            resource: ["interaction"],
            operation: [
              "sendFollowup",
              "editOriginal",
              "editFollowup",
              "openModal",
            ],
          },
        },
      },
      {
        displayName: "Message ID",
        name: "messageId",
        type: "string",
        default: "",
        displayOptions: {
          show: {
            resource: ["interaction"],
            operation: ["editFollowup", "deleteFollowup"],
          },
        },
      },
      {
        displayName: "Modal Title",
        name: "modalTitle",
        type: "string",
        default: "Input",
        displayOptions: {
          show: { resource: ["interaction"], operation: ["openModal"] },
        },
      },
      {
        displayName: "Modal Custom ID",
        name: "modalCustomId",
        type: "string",
        default: "modal",
        displayOptions: {
          show: { resource: ["interaction"], operation: ["openModal"] },
        },
      },
      {
        displayName: "Modal Components (JSON)",
        name: "modalComponents",
        type: "json",
        default:
          '{"components":[{"type":1,"components":[{"type":4,"custom_id":"text","label":"Your text","style":1,"min_length":1,"max_length":4000}]}]}',
        description: "Interaction modal components JSON",
        displayOptions: {
          show: { resource: ["interaction"], operation: ["openModal"] },
        },
      },
      {
        displayName: "Choices (JSON)",
        name: "choicesJson",
        type: "json",
        default: '[{"name":"One","value":"1"},{"name":"Two","value":"2"}]',
        description: "Array of {name,value} pairs",
        displayOptions: {
          show: {
            resource: ["interaction"],
            operation: ["respondAutocomplete"],
          },
        },
      },
    ],
  };

  methods = {
    loadOptions: {
      async getChannels(
        this: ILoadOptionsFunctions
      ): Promise<INodePropertyOptions[]> {
        const guildId = this.getCurrentNodeParameter("guildId") as string;
        if (!guildId) return [];
        const data = await discordApiRequest(
          this,
          "GET",
          `/guilds/${guildId}/channels`
        );
        const arr = Array.isArray(data) ? data : [];
        return arr
          .filter((c: any) => c?.id && c?.name)
          .map((c: any) => ({ name: `#${c.name} (${c.id})`, value: c.id }));
      },
      async getRoles(
        this: ILoadOptionsFunctions
      ): Promise<INodePropertyOptions[]> {
        const guildId = this.getCurrentNodeParameter("guildId") as string;
        if (!guildId) return [];
        const data = await discordApiRequest(
          this,
          "GET",
          `/guilds/${guildId}/roles`
        );
        const arr = Array.isArray(data) ? data : [];
        return arr
          .filter((r: any) => r?.id && r?.name)
          .map((r: any) => ({ name: `@${r.name} (${r.id})`, value: r.id }));
      },
    },
  } as INodeType["methods"];

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const resource = this.getNodeParameter("resource", i) as string;
      const operation = this.getNodeParameter("operation", i) as string;

      /* -------------------------- CHANNEL -------------------------- */
      if (resource === "channel") {
        if (operation === "create") {
          const guildId = this.getNodeParameter("guildId", i) as string;
          const name = this.getNodeParameter("name", i) as string;
          const type = this.getNodeParameter("type", i) as number;
          const additional = this.getNodeParameter(
            "additionalFields",
            i,
            {}
          ) as Record<string, any>;
          const data = await discordApiRequest(
            this,
            "POST",
            `/guilds/${guildId}/channels`,
            { name, type, ...additional }
          );
          out.push({ json: data });
          continue;
        }
        if (operation === "getAll") {
          const guildId = this.getNodeParameter("guildId", i) as string;
          const data = await discordApiRequest(
            this,
            "GET",
            `/guilds/${guildId}/channels`
          );
          (Array.isArray(data) ? data : [data]).forEach((d: any) =>
            out.push({ json: d })
          );
          continue;
        }
        const channelId = this.getNodeParameter("channelId", i) as string;
        if (operation === "get") {
          out.push({
            json: await discordApiRequest(
              this,
              "GET",
              `/channels/${channelId}`
            ),
          });
          continue;
        }
        if (operation === "update") {
          const additional = this.getNodeParameter(
            "additionalFields",
            i,
            {}
          ) as Record<string, any>;
          if (!Object.keys(additional).length) {
            throw new NodeOperationError(this.getNode(), "Nothing to update.");
          }
          out.push({
            json: await discordApiRequest(
              this,
              "PATCH",
              `/channels/${channelId}`,
              additional
            ),
          });
          continue;
        }
        if (operation === "delete") {
          out.push({
            json: await discordApiRequest(
              this,
              "DELETE",
              `/channels/${channelId}`
            ),
          });
          continue;
        }
      }

      /* -------------------------- MESSAGE -------------------------- */
      if (resource === "message") {
        const channelId = this.getNodeParameter("channelId", i) as string;

        if (operation === "send" || operation === "sendAndWait") {
          const content = this.getNodeParameter("content", i, "") as string;
          const useHelper = this.getNodeParameter(
            "useComponentsHelper",
            i,
            false
          ) as boolean;

          let helperJson = this.getNodeParameter(
            "componentsHelper",
            i,
            "{}"
          ) as any;
          if (typeof helperJson === "string") {
            try {
              helperJson = JSON.parse(helperJson || "{}");
            } catch {
              helperJson = {};
            }
          }

          let additional = this.getNodeParameter(
            "additionalBody",
            i,
            "{}"
          ) as any;
          if (typeof additional === "string") {
            try {
              additional = JSON.parse(additional || "{}");
            } catch {
              additional = {};
            }
          }

          const body: any = { content, ...(additional || {}) };
          if (useHelper) {
            const built = buildComponents(helperJson);
            if (built.length) {
              body.components = Array.isArray(body.components)
                ? [...body.components, ...built]
                : built;
            }
          }

          const binaryPropertyName = this.getNodeParameter(
            "binaryPropertyName",
            i,
            ""
          ) as string;
          let sent;
          if (binaryPropertyName) {
            const item = items[i];
            if (!item.binary || !item.binary[binaryPropertyName]) {
              throw new NodeOperationError(
                this.getNode(),
                `Binary property "${binaryPropertyName}" not found on item index ${i}.`
              );
            }
            const bin = await this.helpers.getBinaryDataBuffer(
              i,
              binaryPropertyName
            );
            const meta = item.binary[binaryPropertyName];
            const formData: any = {
              payload_json: JSON.stringify(body),
              "files[0]": {
                value: bin,
                options: {
                  filename: meta.fileName || "file",
                  contentType: meta.mimeType || "application/octet-stream",
                },
              },
            };
            sent = await discordApiRequest(
              this,
              "POST",
              `/channels/${channelId}/messages`,
              {},
              {},
              { sendAsForm: true, formData }
            );
          } else {
            sent = await discordApiRequest(
              this,
              "POST",
              `/channels/${channelId}/messages`,
              body
            );
          }

          if (operation === "send") {
            out.push({ json: sent });
            continue;
          }

          // sendAndWait → polling sederhana menunggu balasan
          const timeoutSec = this.getNodeParameter(
            "timeoutSec",
            i,
            60
          ) as number;
          const filter = this.getNodeParameter("replyFilter", i, {}) as any;
          const deadline = Date.now() + timeoutSec * 1000;

          const me = await discordApiRequest(this, "GET", `/users/@me`);
          const botId = me?.id;
          let cursor = sent.id;
          let reply: any = null;

          while (Date.now() < deadline) {
            const list = await discordApiRequest(
              this,
              "GET",
              `/channels/${channelId}/messages`,
              {},
              { after: cursor, limit: 100 }
            );
            const arr = Array.isArray(list) ? list : [];
            arr.sort(
              (a: any, b: any) =>
                new Date(a.timestamp).getTime() -
                new Date(b.timestamp).getTime()
            );

            for (const m of arr) {
              cursor = m.id;
              if (m.author?.id === botId) continue;
              if (filter.fromUserId && m.author?.id !== filter.fromUserId)
                continue;
              if (
                filter.includes &&
                typeof m.content === "string" &&
                !m.content.includes(filter.includes)
              )
                continue;
              reply = m;
              break;
            }
            if (reply) break;
            await new Promise((r) => setTimeout(r, 2000));
          }

          out.push({ json: { sent, reply, timedOut: !reply } });
          continue;
        }

        if (operation === "createThreadFromMessage") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          const threadName = this.getNodeParameter(
            "threadName",
            i,
            ""
          ) as string;
          let additional = this.getNodeParameter(
            "additionalBody",
            i,
            "{}"
          ) as any;
          if (typeof additional === "string") {
            try {
              additional = JSON.parse(additional || "{}");
            } catch {
              additional = {};
            }
          }
          out.push({
            json: await discordApiRequest(
              this,
              "POST",
              `/channels/${channelId}/messages/${messageId}/threads`,
              { name: threadName || "Thread", ...(additional || {}) }
            ),
          });
          continue;
        }

        if (operation === "createThread") {
          const threadName = this.getNodeParameter(
            "threadName",
            i,
            ""
          ) as string;
          const autoArchiveDuration = this.getNodeParameter(
            "autoArchiveDuration",
            i,
            1440
          ) as number;
          let additional = this.getNodeParameter(
            "additionalBody",
            i,
            "{}"
          ) as any;
          if (typeof additional === "string") {
            try {
              additional = JSON.parse(additional || "{}");
            } catch {
              additional = {};
            }
          }
          out.push({
            json: await discordApiRequest(
              this,
              "POST",
              `/channels/${channelId}/threads`,
              {
                name: threadName || "Thread",
                auto_archive_duration: autoArchiveDuration,
                ...(additional || {}),
              }
            ),
          });
          continue;
        }

        if (operation === "joinThread" || operation === "leaveThread") {
          const threadId = this.getNodeParameter("threadId", i) as string;
          const method = operation === "joinThread" ? "PUT" : "DELETE";
          out.push({
            json: await discordApiRequest(
              this,
              method,
              `/channels/${threadId}/thread-members/@me`
            ),
          });
          continue;
        }

        if (operation === "pin" || operation === "unpin") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          const method = operation === "pin" ? "PUT" : "DELETE";
          out.push({
            json: await discordApiRequest(
              this,
              method,
              `/channels/${channelId}/pins/${messageId}`
            ),
          });
          continue;
        }

        if (operation === "bulkDelete") {
          const messageIdsCsv = this.getNodeParameter(
            "messageIds",
            i,
            ""
          ) as string;
          const ids = messageIdsCsv
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (ids.length < 2 || ids.length > 100) {
            throw new NodeOperationError(
              this.getNode(),
              "Bulk delete requires 2..100 message IDs."
            );
          }
          out.push({
            json: await discordApiRequest(
              this,
              "POST",
              `/channels/${channelId}/messages/bulk-delete`,
              { messages: ids }
            ),
          });
          continue;
        }

        if (operation === "get") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          out.push({
            json: await discordApiRequest(
              this,
              "GET",
              `/channels/${channelId}/messages/${messageId}`
            ),
          });
          continue;
        }

        if (operation === "getAll") {
          let remaining = this.getNodeParameter("limit", i, 50) as number;
          const acc: any[] = [];
          let before: string | undefined = undefined;
          while (remaining > 0) {
            const pageLimit = Math.min(remaining, 100);
            const page = await discordApiRequest(
              this,
              "GET",
              `/channels/${channelId}/messages`,
              {},
              { limit: pageLimit, ...(before ? { before } : {}) }
            );
            const arr = Array.isArray(page) ? page : [];
            if (!arr.length) break;
            acc.push(...arr);
            remaining -= arr.length;
            before = arr[arr.length - 1].id;
          }
          acc.forEach((d: any) => out.push({ json: d }));
          continue;
        }

        if (operation === "delete") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          out.push({
            json: await discordApiRequest(
              this,
              "DELETE",
              `/channels/${channelId}/messages/${messageId}`
            ),
          });
          continue;
        }

        if (operation === "createReaction") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          const emoji = this.getNodeParameter("emoji", i) as string;
          out.push({
            json: await discordApiRequest(
              this,
              "PUT",
              `/channels/${channelId}/messages/${messageId}/reactions/${encodeEmoji(
                emoji
              )}/@me`
            ),
          });
          continue;
        }
      }

      /* -------------------------- MEMBER -------------------------- */
      if (resource === "member") {
        const guildId = this.getNodeParameter("guildId", i) as string;

        if (operation === "getAll") {
          let after: string | undefined = undefined;
          const outMembers: any[] = [];
          while (outMembers.length < 2000) {
            const page = await discordApiRequest(
              this,
              "GET",
              `/guilds/${guildId}/members`,
              {},
              { limit: 1000, after }
            );
            const arr = Array.isArray(page) ? page : [];
            if (!arr.length) break;
            outMembers.push(...arr);
            after = arr[arr.length - 1].user?.id;
            if (arr.length < 1000) break;
          }
          outMembers.forEach((m: any) => out.push({ json: m }));
          continue;
        }

        if (operation === "addRole" || operation === "removeRole") {
          const userId = this.getNodeParameter("userId", i) as string;
          const roleId = this.getNodeParameter("roleId", i) as string;
          const method = operation === "addRole" ? "PUT" : "DELETE";
          out.push({
            json: await discordApiRequest(
              this,
              method,
              `/guilds/${guildId}/members/${userId}/roles/${roleId}`
            ),
          });
          continue;
        }
      }

      /* -------------------------- INTERACTION -------------------------- */
      if (resource === "interaction") {
        const token = this.getNodeParameter("interactionToken", i) as string;

        if (operation === "openModal") {
          const id = this.getNodeParameter("interactionId", i) as string;
          const title = this.getNodeParameter("modalTitle", i) as string;
          const customId = this.getNodeParameter("modalCustomId", i) as string;
          let comps = this.getNodeParameter("modalComponents", i, "{}") as any;
          if (typeof comps === "string") {
            try {
              comps = JSON.parse(comps || "{}");
            } catch {
              comps = {};
            }
          }
          const body = {
            type: 9,
            data: { title, custom_id: customId, ...(comps || {}) },
          };
          out.push({
            json: await discordApiRequest(
              this,
              "POST",
              `/interactions/${id}/${token}/callback`,
              body
            ),
          });
          continue;
        }

        if (operation === "respondAutocomplete") {
          const id = this.getNodeParameter("interactionId", i) as string;
          let choices = this.getNodeParameter("choicesJson", i, "[]") as any;
          if (typeof choices === "string") {
            try {
              choices = JSON.parse(choices || "[]");
            } catch {
              choices = [];
            }
          }
          const body = { type: 8, data: { choices } };
          out.push({
            json: await discordApiRequest(
              this,
              "POST",
              `/interactions/${id}/${token}/callback`,
              body
            ),
          });
          continue;
        }

        const appId = this.getNodeParameter("applicationId", i, "") as string;

        if (operation === "sendFollowup") {
          let additional = this.getNodeParameter(
            "additionalBody",
            i,
            "{}"
          ) as any;
          const content = this.getNodeParameter("content", i, "") as string;
          if (typeof additional === "string") {
            try {
              additional = JSON.parse(additional || "{}");
            } catch {
              additional = {};
            }
          }
          out.push({
            json: await discordApiRequest(
              this,
              "POST",
              `/webhooks/${appId}/${token}`,
              { content, ...(additional || {}) }
            ),
          });
          continue;
        }

        if (operation === "editOriginal") {
          let additional = this.getNodeParameter(
            "additionalBody",
            i,
            "{}"
          ) as any;
          if (typeof additional === "string") {
            try {
              additional = JSON.parse(additional || "{}");
            } catch {
              additional = {};
            }
          }
          out.push({
            json: await discordApiRequest(
              this,
              "PATCH",
              `/webhooks/${appId}/${token}/messages/@original`,
              additional || {}
            ),
          });
          continue;
        }

        if (operation === "deleteOriginal") {
          out.push({
            json: await discordApiRequest(
              this,
              "DELETE",
              `/webhooks/${appId}/${token}/messages/@original`
            ),
          });
          continue;
        }

        if (operation === "editFollowup") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          let additional = this.getNodeParameter(
            "additionalBody",
            i,
            "{}"
          ) as any;
          if (typeof additional === "string") {
            try {
              additional = JSON.parse(additional || "{}");
            } catch {
              additional = {};
            }
          }
          out.push({
            json: await discordApiRequest(
              this,
              "PATCH",
              `/webhooks/${appId}/${token}/messages/${messageId}`,
              additional || {}
            ),
          });
          continue;
        }

        if (operation === "deleteFollowup") {
          const messageId = this.getNodeParameter("messageId", i) as string;
          out.push({
            json: await discordApiRequest(
              this,
              "DELETE",
              `/webhooks/${appId}/${token}/messages/${messageId}`
            ),
          });
          continue;
        }
      }

      throw new NodeOperationError(
        this.getNode(),
        `Unknown operation: ${resource}.${operation}`
      );
    }

    return [out];
  }
}
