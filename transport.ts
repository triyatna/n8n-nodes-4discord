import type { IExecuteFunctions, ILoadOptionsFunctions, IWebhookFunctions } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import FormData from 'form-data';

type ThisCtx = IExecuteFunctions | ILoadOptionsFunctions | IWebhookFunctions;

export function getBase(this: ThisCtx): { baseUrl: string, token: string } {
  // @ts-ignore
  const creds = this.getCredentials('discordApi') as any;
  if (!creds?.botToken) throw new Error('Missing Discord credentials');
  const token = (String(creds.botToken).startsWith('Bot ')) ? String(creds.botToken) : `Bot ${creds.botToken}`;
  const baseUrl = creds.baseUrl || 'https://discord.com/api/v10';
  return { baseUrl, token };
}

export function encodeEmoji(emoji: string): string {
  if (!emoji) return '';
  // handle custom emoji formats like <:name:id> or <a:name:id>
  const customMatch = emoji.match(/^<a?:([a-zA-Z0-9_~]+):(\d+)>$/);
  let prepared = emoji;
  if (customMatch) prepared = `${customMatch[1]}:${customMatch[2]}`;
  return encodeURIComponent(prepared);
}

export async function discordApiRequest(
  that: ThisCtx,
  method: string,
  endpoint: string,
  body: any = {},
  qs: Record<string, any> = {},
  opts: { sendAsForm?: boolean, formData?: any } = {},
): Promise<any> {
  const { baseUrl, token } = getBase.call(that);
  const url = `${baseUrl}${endpoint}`;
  const options: any = {
    method,
    headers: {
      Authorization: token,
    },
    qs,
    body,
    returnFullResponse: false,
    json: !opts.sendAsForm,
  };

  if (opts.sendAsForm) {
    const fd = new FormData();
    // If a structured formData object provided, use that; otherwise, convert body
    if (opts.formData) {
      for (const [k, v] of Object.entries(opts.formData)) {
        // @ts-ignore
        if (v && v.options) fd.append(k, v.value, v.options);
        else fd.append(k, v as any);
      }
    } else {
      // Fallback: attach "payload_json" and files[] from body
      fd.append('payload_json', JSON.stringify(body));
    }
    // Merge headers from FormData
    options.headers = { ...options.headers, ...fd.getHeaders() };
    options.body = fd;
    options.json = false;
  }

  // @ts-ignore - request helper exists in all three contexts
  const resp = await (that as any).helpers.request({
    method: options.method,
    uri: url,
    qs: options.qs,
    headers: options.headers,
    body: options.body,
    json: options.json,
    encoding: null,
  }).catch((error: any) => {
    throw new NodeApiError(that.getNode(), error, { message: 'Discord API request failed' });
  });

  // Try to parse Buffer as JSON if applicable
  if (Buffer.isBuffer(resp)) {
    try { return JSON.parse(resp.toString('utf8')); } catch { return resp.toString('utf8'); }
  }
  return resp;
}
