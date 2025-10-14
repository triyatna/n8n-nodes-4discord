# Discord Listener (Trigger) - N8N Nodes Community

A single node to receive **Discord Interactions** or listen to **Discord Listening** via socket.

## Prepare the credential

Create a **Discord App Credential** with the following fields:

- **Application ID** — your application snowflake (required for follow‑up URL composition).
- **Public Key** — Ed25519 public key from the Developer Portal (used to verify interaction signatures).
- **Bot Token** — your bot token. You may paste it with or without the `Bot ` prefix.
- **Shared Secret (optional)** — only if you proxy requests and want extra HMAC verification.

---

### Interactions

- `path`, `responseMode`, `includeRawBody`, `requireJson`, `splitIntoItems`
- `immediateAck`, `interactionAutoResponse`, `interactionMessageContent`, `interactionEphemeral`
- `verifyInteractions`, `maxTimestampAge`, `verifyForwardedSecret`
- `autoFollowup`, `autoFollowupContent`

### Listening

- `listeningIntents`, `emitEvents`, `listeningAutoReconnect`, `listeningIncludeSelf`, `selfFilterCacheSize`, `mentionDetect`, and other feature.

---

## FAQ

**Why don’t I see the webhook URL in Listening mode?**  
Because there’s no HTTP endpoint in Listening. Switch to **Interactions** to get the Test/Production URLs.

**I get “bad_signature” errors.**  
Confirm you set the correct **Public Key** in the credential and Discord is posting with the `X‑Signature‑Ed25519`/`X‑Signature‑Timestamp` headers. Make sure n8n preserves the raw request body (the node reads it automatically).

**No message text in Listening mode.**  
Enable the **Message Content** privileged intent in the Developer Portal and include it in **Listening Intents**.

**The trigger floods or loops.**  
Keep **Include Bot’s Own Events** turned **off** (default) so the node self‑filters the bot’s own actions.

**Lisensi**: MIT · © Tri Yatna
