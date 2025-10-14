# Discord Trigger (for n8n)

A single node to receive **Discord Interactions** or listen to **all messages/events via a Listening**.

---

## Node summary

- **Name:** `Discord Trigger`
- **Credential:** `Discord App Credential` (application ID, public key, bot token, optional shared secret)
- **Modes:**
  - **Interactions** — expose an HTTP endpoint to receive slash commands, component interactions, etc.
  - **Listening** — connect to the Discord WSS to receive live events (messages, reactions, typing, …).

---

## 1) Prepare the credential

Create a **Discord App Credential** with the following fields:

- **Application ID** — your application snowflake (required for follow‑up URL composition).
- **Public Key** — Ed25519 public key from the Developer Portal (used to verify interaction signatures).
- **Bot Token** — your bot token. You may paste it with or without the `Bot ` prefix.
- **Shared Secret (optional)** — only if you proxy requests and want extra HMAC verification.

---

## 2) Add the node and choose a mode

Drag **Discord Trigger** into your workflow and pick a **Mode**:

### A. Mode: Interactions (HTTP Webhook)

Used for slash commands, component interactions, and pings sent by Discord to your endpoint.

**Main fields**

- **Path**: default `discord`. n8n shows Test/Production URLs when you Listen/Activate.
- **Response Mode**: `On Received` (respond immediately) or `Last Node`.
- **Include Raw Body**: attach the raw body string to the emitted item.
- **Require JSON Content‑Type**: reject non‑`application/json` requests with 415.
- **Split Into Items (if body is array)**: when the incoming body is an array.

**Auto‑ack options**

- **Immediate ACK (Message)**: if enabled, respond with a message immediately.
- **Interaction Auto‑Response (override)**: one of:
  - `none` — choose between immediate message or deferred based on the settings above (and uses deferred if _Response Mode_ is `Last Node`)
  - `pong` — respond with type 1 (**PONG**)
  - `deferred` — respond with type 5 (deferred update)
  - `message` — respond with type 4 and **Message Content**
- **Message Content** _(visible when Auto‑Response = message)_: text to send.
- **Ephemeral**: set `flags=64` so only the invoker sees the message.

**Security**

- **Verify Discord Signatures (Ed25519)**: verify `X‑Signature‑Ed25519` and `X‑Signature‑Timestamp` using your **Public Key**.
- **Max Signature Timestamp Age (seconds)**: anti‑replay guard (default **300**).
- **Verify Forwarded Shared Secret (HMAC)** _(optional)_: if you front the endpoint with your own proxy/forwarder, you can also verify
  `X‑Timestamp` / `X‑Signature` where signature is `HMAC‑SHA256(secret, ts + "." + rawBody)`.

**Follow‑up**

- **Auto Follow‑up after ACK**: if enabled, send a simple follow‑up to the webhook URL derived from `applicationId` and the request `token`.
- **Auto Follow‑up Content**: message text for the follow‑up (default `✅ Received by n8n`).

**What the node emits (example)**

```json
{
  "headers": { "...": "..." },
  "query": { "...": "..." },
  "body": { "type": 2, "token": "abc...", "...": "..." },
  "receivedAt": "2025-01-01T12:34:56.000Z",
  "source": "interactions",
  "applicationId": "123456789012345678",
  "rawBody": "{...}", // if Include Raw Body = true
  "followupUrl": "https://discord.com/api/v10/webhooks/<appId>/<token>"
}
```

> **Tip:** When _Response Mode_ is `Last Node`, the trigger still sends a **deferred** response to avoid the Discord 3‑second timeout unless you override it.

---

### B. Mode: Listening (WSS)

Connects to the Discord Gateway to receive live events.

**Main fields**

- **Listening Intents**: pick one or more of
  - `Guilds`, `Guild Messages`, `Direct Messages`, `Message Content (privileged)`, `Message Reactions`
- **Auto Reconnect**: reconnect automatically on disconnects.
- **Include Bot's Own Events**: default **off**. When off, the node filters out events produced by the bot itself to avoid loops/spam.
- **Self‑filter Cache Size**: how many of the bot’s own message IDs to keep for filtering updates/deletes (default **2000**).

> You must enable **MESSAGE CONTENT** intent in the Discord Developer Portal if you want to receive message text.

**Emitted items**

For the event types listed in discord trigger (e.g., `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `reaction events`,`typing`, etc.), the node emits:

```json
{
  "op": 0,
  "t": "MESSAGE_CREATE",
  "s": 42,
  "d": { "...": "payload from Discord" },
  "receivedAt": "2025-01-01T12:34:56.000Z",
  "source": "listening"
}
```

> With **Include Bot’s Own Events = false** (default), the node ignores the bot’s own message/reaction/typing events and bulk‑filters message IDs captured earlier to prevent self‑loops.

---

## Notes & tips

- **Endpoint visibility:** The webhook URL appears **only** in **Interactions** mode. In **Listening** mode there is no endpoint.
- **3‑second rule:** Interactions must be acknowledged within 3 seconds. Use _Immediate ACK_ or _Deferred_ to meet this requirement.
- **Privileged intents:** If you select **Message Content**, ensure it’s approved/enabled in your application settings.
- **Rate limits & retries:** The Listening mode auto‑reconnects. Interactions mode is stateless and depends on your n8n endpoint availability.
- **Follow‑up messaging:** When available, `followupUrl` lets you send additional messages without authorization headers.

---

## Field reference (exact names)

This table maps directly to the node’s properties in the UI.

### Interactions

- `mode = interactions`
- `path`, `responseMode`, `includeRawBody`, `requireJson`, `splitIntoItems`
- `immediateAck`, `interactionAutoResponse`, `interactionMessageContent`, `interactionEphemeral`
- `verifyInteractions`, `maxTimestampAge`, `verifyForwardedSecret`
- `autoFollowup`, `autoFollowupContent`

### Listening

- `mode = listening`
- `listeningIntents`, `listeningAutoReconnect`, `listeningIncludeSelf`, `selfFilterCacheSize`

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
