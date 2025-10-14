import type {
  ICredentialType,
  INodeProperties,
  IAuthenticateGeneric,
  ICredentialTestRequest,
} from "n8n-workflow";

export class DiscordApp implements ICredentialType {
  name = "discordApp";
  displayName = "Discord App Credential";
  documentationUrl = "https://discord.com/developers/docs/intro";
  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization:
          '={{ $credentials.botToken ? ($credentials.botToken.startsWith("Bot ") ? $credentials.botToken : "Bot " + $credentials.botToken) : undefined }}',
      },
    },
  };
  test: ICredentialTestRequest = {
    request: {
      baseURL: "https://discord.com/api/v10",
      url: "/users/@me",
      method: "GET",
    },
  };
  properties: INodeProperties[] = [
    {
      displayName: "Application ID",
      name: "applicationId",
      type: "string",
      default: "",
      description: "Discord Application ID.",
    },
    {
      displayName: "Public Key",
      name: "publicKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description: "Discord Public Key.",
    },
    {
      displayName: "Token",
      name: "botToken",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description: "Token Bot.",
    },
    {
      displayName: "Shared Secret (optional)",
      name: "sharedSecret",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description:
        "Optional for HMAC X-Timestamp/X-Signature if using external forwarder.",
    },
  ];
}
