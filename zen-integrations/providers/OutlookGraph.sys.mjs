// Pure Graph mail mapping. No browser services, so a node check can load it.

const FOREIGN_OUTLOOK_CLIENT_ID = '74d1363b-cbb0-4149-9619-f1594fefa6f4';
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OUTLOOK_REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
export const OUTLOOK_AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const OUTLOOK_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
export const OUTLOOK_SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';

function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(36)).slice(-8);
}

export function outlookClientState(raw) {
  const id = String(raw || '').trim();
  if (!id) return 'missing';
  if (id.toLowerCase() === FOREIGN_OUTLOOK_CLIENT_ID) return 'foreign';
  if (!CLIENT_ID_RE.test(id)) return 'invalid';
  return 'ok';
}

export function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
    .join('&');
}

export function graphMessagesUrl() {
  const query = [
    ['$filter', 'isRead eq false'],
    ['$select', 'id,subject,bodyPreview,from,receivedDateTime,webLink,conversationId,isRead'],
    ['$top', '50']
  ];
  const body = query.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
  return 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?' + body;
}

export function graphMessageRow(message, sourceRank) {
  const id = String(message?.id || '');
  const address = message?.from?.emailAddress || {};
  const sender = String(address.name || address.address || 'Unknown');
  const subject = String(message?.subject || '(No subject)');
  const date = String(message?.receivedDateTime || '');
  const ts = Date.parse(date);
  let url = '';
  try {
    const parsed = new URL(String(message?.webLink || ''));
    if (parsed.protocol === 'https:') url = parsed.href;
  } catch (e) {}
  return {
    id: 'outlook:' + fnv1a(id || subject + '|' + sender),
    threadId: id,
    gmailThreadId: '',
    legacyThreadId: '',
    from: sender,
    subject,
    snippet: String(message?.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    date,
    ts: Number.isFinite(ts) ? ts : 0,
    isUnread: message?.isRead !== true,
    url,
    rowIndex: sourceRank
  };
}

export function graphUnreadRows(payload, limit) {
  const list = Array.isArray(payload?.value) ? payload.value : [];
  const cap = Number(limit) > 0 ? Number(limit) : 20;
  return list
    .filter((message) => message && message.isRead !== true)
    .map((message, index) => graphMessageRow(message, index))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.rowIndex - b.rowIndex)
    .slice(0, cap);
}

export function authorizeUrl({ clientId, redirectUri, state, challenge }) {
  const query = formEncode({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  });
  return OUTLOOK_AUTHORIZE_URL + '?' + query;
}
