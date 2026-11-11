const {
  CONFIG,
  cookieHeaderFromJar,
  debugLog,
  fnv1a,
  getTabUserContextId,
  hostCookies,
  httpRequest
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

const HOSTS = [
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.live.com',
  'outlook.cloud.microsoft'
];

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

export function outlookOrigin(hints) {
  for (const hint of hints || []) {
    const host = hostOf(hint);
    if (HOSTS.includes(host)) return 'https://' + host;
  }
  for (const hint of hints || []) {
    const text = String(hint).toLowerCase();
    if (text.includes('outlook.live')) return 'https://outlook.live.com';
    if (text.includes('outlook.cloud.microsoft')) return 'https://outlook.cloud.microsoft';
    if (text.includes('outlook.office365')) return 'https://outlook.office365.com';
    if (text.includes('outlook.office') || text === 'outlook') return 'https://outlook.office.com';
  }
  return 'https://outlook.office.com';
}

function familyOf(origin) {
  const host = hostOf(origin);
  if (host === 'outlook.live.com') return 'live';
  if (host === 'outlook.cloud.microsoft') return 'cloud';
  if (host === 'outlook.office365.com') return 'office365';
  return 'office';
}

function cookieHosts(origin) {
  const host = hostOf(origin);
  if (host === 'outlook.live.com') return ['outlook.live.com', 'live.com'];
  if (host === 'outlook.cloud.microsoft') return ['outlook.cloud.microsoft', 'cloud.microsoft'];
  if (host === 'outlook.office365.com') return ['outlook.office365.com', 'office365.com', 'office.com'];
  return ['outlook.office.com', 'office.com', 'office365.com'];
}

function mailSlot(hints) {
  for (const hint of hints || []) {
    const match = String(hint).match(/\/mail\/(\d+)\//);
    if (match) return match[1];
  }
  return '';
}

function owaPrefix(origin, hints, canaryPath) {
  const fromCanary = String(canaryPath || '').match(/\/owa\/(\d+)/i);
  if (fromCanary) return '/owa/' + fromCanary[1];
  const host = hostOf(origin);
  if (host === 'outlook.live.com' || (hints || []).some((hint) => /\/owa\/0\//.test(String(hint)))) {
    return '/owa/' + (mailSlot(hints) || '0');
  }
  return '/owa';
}

function serviceUrl(origin, hints, canaryPath) {
  return origin + owaPrefix(origin, hints, canaryPath) + '/service.svc?action=FindConversation&app=Mail';
}

function startupUrl(origin, hints) {
  return origin + owaPrefix(origin, hints) + '/startupdata.ashx?app=Mail&n=0';
}

function findConversationBody(shapeName) {
  const shape = {
    __type: 'ConversationResponseShape:#Exchange',
    BaseShape: shapeName ? 'IdOnly' : 'Default'
  };
  const body = {
    __type: 'FindConversationJsonRequest:#Exchange',
    Header: {
      __type: 'JsonRequestHeaders:#Exchange',
      RequestServerVersion: 'Exchange2013',
      TimeZoneContext: {
        __type: 'TimeZoneContext:#Exchange',
        TimeZoneDefinition: {
          __type: 'TimeZoneDefinitionType:#Exchange',
          Id: 'UTC'
        }
      }
    },
    Body: {
      __type: 'FindConversationRequest:#Exchange',
      ParentFolderId: {
        __type: 'TargetFolderId:#Exchange',
        BaseFolderId: {
          __type: 'DistinguishedFolderId:#Exchange',
          Id: 'inbox'
        }
      },
      ConversationShape: shape,
      Paging: {
        __type: 'IndexedPageView:#Exchange',
        BasePoint: 'Beginning',
        Offset: 0,
        MaxEntriesReturned: CONFIG.MAX_EMAILS
      },
      ViewFilter: 'Unread',
      SortOrder: [{
        __type: 'SortResults:#Exchange',
        Order: 'Descending',
        Path: {
          __type: 'PropertyUri:#Exchange',
          FieldURI: 'conversation:LastDeliveryTime'
        }
      }]
    }
  };
  if (shapeName) body.Body.ShapeName = shapeName;
  return body;
}

function canaryValue(raw) {
  const text = String(raw || '');
  if (!/%[0-9A-Fa-f]{2}/.test(text)) return text;
  try { return decodeURIComponent(text); } catch (e) { return text; }
}

function signInError() {
  const error = new Error('Sign-in required');
  error.signin = true;
  return error;
}

function responseCode(data) {
  return String(data?.Body?.ResponseCode || data?.error?.code || '');
}

function owaTime(value) {
  const text = String(value || '');
  const match = text.match(/\/Date\((-?\d+)/);
  if (match) return Number(match[1]);
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : 0;
}

function senderName(conversation) {
  const list = conversation?.UniqueSenders;
  const first = Array.isArray(list) ? list[0] : list;
  if (typeof first === 'string' && first.trim()) return first.trim();
  if (first && typeof first === 'object') {
    return first.Name || first.EmailAddress || 'Unknown';
  }
  const mailbox = conversation?.LastSender?.Mailbox || conversation?.From?.Mailbox;
  return mailbox?.Name || mailbox?.EmailAddress || 'Unknown';
}

function itemId(conversation) {
  for (const list of [conversation?.ItemIds, conversation?.GlobalItemIds]) {
    const id = list?.[0]?.Id;
    if (id) return id;
  }
  return conversation?.ConversationId?.Id || '';
}

export function outlookReadUrl(origin, id, hints) {
  if (!id) return origin + '/mail/';
  const slot = mailSlot(hints);
  const host = hostOf(origin);
  if (host === 'outlook.live.com') {
    return origin + '/mail/' + (slot || '0') + '/deeplink/read/' + encodeURIComponent(id);
  }
  return origin + '/mail/deeplink/read/' + encodeURIComponent(id);
}

function conversationsFrom(data) {
  if (Array.isArray(data?.Body?.Conversations)) return data.Body.Conversations;
  const items = data?.Body?.ResponseMessages?.Items;
  if (!Array.isArray(items)) return [];
  for (const item of items) {
    if (Array.isArray(item?.Conversations)) return item.Conversations;
  }
  return [];
}

function parseConversations(data, origin, hints) {
  const items = conversationsFrom(data).map((conversation, sourceRank) => {
    const rawId = itemId(conversation);
    const subject = conversation.ConversationTopic || '(No subject)';
    const ts = owaTime(conversation.LastDeliveryTime || conversation.LastDeliveryOrRenewTime);
    const id = 'outlook:' + fnv1a(rawId || subject + '|' + ts);
    return {
      id,
      threadId: rawId || id,
      gmailThreadId: '',
      legacyThreadId: '',
      from: senderName(conversation),
      subject,
      snippet: String(conversation.Preview || '').slice(0, 200),
      date: ts ? new Date(ts).toISOString() : '',
      ts,
      isUnread: true,
      url: outlookReadUrl(origin, rawId, hints),
      rowIndex: sourceRank
    };
  });
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.rowIndex - b.rowIndex);
  return items.slice(0, CONFIG.MAX_EMAILS);
}

function looksLikeLogin(status, finalUrl, text) {
  if (status === 401 || status === 403 || status === 440) return true;
  if (/login\.(microsoftonline|live|windows)\.com/i.test(finalUrl || '')) return true;
  const head = String(text || '').trim().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

function thinConversations(data) {
  const list = conversationsFrom(data);
  if (!list.length) return false;
  return list.every((item) => !item?.ConversationTopic && !item?.Preview && !item?.UniqueSenders);
}

function pathMatches(cookiePath, requestPath) {
  const path = String(cookiePath || '/');
  const normalized = path.startsWith('/') ? path : '/' + path;
  if (normalized === '/') return true;
  if (requestPath === normalized) return true;
  const prefix = normalized.endsWith('/') ? normalized : normalized + '/';
  return requestPath.startsWith(prefix);
}

function canaryFrom(cookies) {
  let best = null;
  for (const cookie of cookies) {
    if (String(cookie.name || '').toLowerCase() !== 'x-owa-canary') continue;
    const path = cookie.path || '/';
    if (!best || (path.toLowerCase().includes('/owa') && !String(best.path).toLowerCase().includes('/owa'))) {
      best = { value: canaryValue(cookie.value), path };
    }
  }
  return best;
}

function cookieValue(cookies, name) {
  const wanted = name.toLowerCase();
  for (const cookie of cookies) {
    if (String(cookie.name || '').toLowerCase() === wanted && cookie.value) return cookie.value;
  }
  return '';
}

function requestCookies(cookies, requestPath, canary) {
  const jar = new Map();
  for (const cookie of cookies) {
    const name = cookie.name;
    if (!name) continue;
    const isCanary = name.toLowerCase() === 'x-owa-canary';
    if (!isCanary && !pathMatches(cookie.path, requestPath)) continue;
    const partitioned = !!cookie.originAttributes?.partitionKey;
    const current = jar.get(name);
    if (!current || (current.partitioned && !partitioned)) {
      jar.set(name, { value: isCanary ? canary.value : cookie.value, partitioned });
    }
  }
  if (canary?.value && ![...jar.keys()].some((name) => name.toLowerCase() === 'x-owa-canary')) {
    jar.set('X-OWA-CANARY', { value: canary.value, partitioned: false });
  }
  return cookieHeaderFromJar(jar);
}

function canaryInText(text) {
  const match = String(text || '').match(/(?:X-OWA-CANARY|owaCanary|"canary")["']?\s*[:=]\s*["']([^"'\s;]+)/i);
  return match ? canaryValue(match[1]) : '';
}

function canaryFromResponse(fetched, origin, hints) {
  if (!fetched) return null;
  const fromHeader = canaryInText(
    'X-OWA-CANARY=' + (fetched.responseHeaders?.['x-owa-canary'] || '') + '\n' + (fetched.responseHeaders?.['set-cookie'] || '')
  ) || canaryInText(fetched.text);
  if (!fromHeader) return null;
  return { value: fromHeader, path: owaPrefix(origin, hints) + '/' };
}

async function loadCanary(app, tab, origin, hints) {
  const hosts = cookieHosts(origin);
  const userContextId = getTabUserContextId(tab);
  const read = () => canaryFrom(hostCookies(userContextId, hosts));
  const found = read();
  if (found?.value) return found;

  const startup = startupUrl(origin, hints);
  debugLog('Outlook canary cookie missing, calling', startup);
  let fetched = null;
  try {
    fetched = await httpRequest(app.window, {
      url: startup,
      userContextId,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: '{}',
      cookieHosts: hosts
    });
  } catch (e) {
    debugLog('Outlook startupdata failed', e && e.message ? e.message : e);
  }
  if (fetched) debugLog('Outlook startupdata', fetched.status, fetched.finalUrl);
  const again = read();
  if (again?.value) return again;
  const fromResponse = canaryFromResponse(fetched, origin, hints);
  if (fromResponse?.value) return fromResponse;

  const names = hostCookies(userContextId, hosts).map((cookie) => cookie.name + '@' + (cookie.path || '/'));
  debugLog('Outlook canary still missing', names.slice(0, 40).join(', ') || '(no outlook cookies)');
  throw signInError();
}

// Preferred path: reuse the Authorization bearer the loaded Outlook tab sends.
async function postFindWithBearer(app, tab, creds, hints, shapeName) {
  const origin = creds.origin;
  const hosts = cookieHosts(origin);
  const userContextId = getTabUserContextId(tab);
  const url = origin + creds.prefix + '/service.svc?action=FindConversation&app=Mail';
  let requestPath = '/';
  try { requestPath = new URL(url).pathname || '/'; } catch (e) {}
  const cookies = hostCookies(userContextId, hosts);
  const canary = { value: creds.canary, path: creds.prefix + '/' };
  const anchor = creds.anchor || cookieValue(cookies, 'DefaultAnchorMailbox');
  debugLog('Outlook via captured bearer', creds.prefix);
  return httpRequest(app.window, {
    url,
    userContextId,
    method: 'POST',
    headers: {
      Authorization: creds.bearer,
      Action: 'FindConversation',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'X-OWA-CANARY': creds.canary,
      'X-Requested-With': 'XMLHttpRequest',
      'X-AnchorMailbox': anchor
    },
    body: JSON.stringify(findConversationBody(shapeName)),
    cookieHosts: hosts,
    cookieHeader: requestCookies(cookies, requestPath, canary)
  });
}

// Fallback for work/Exchange tenants that still accept cookie + canary auth.
async function postFindWithCookies(app, tab, origin, hints, shapeName) {
  const hosts = cookieHosts(origin);
  const userContextId = getTabUserContextId(tab);
  const canary = await loadCanary(app, tab, origin, hints);
  const url = serviceUrl(origin, hints, canary.path);
  let requestPath = '/';
  try { requestPath = new URL(url).pathname || '/'; } catch (e) {}
  const cookies = hostCookies(userContextId, hosts);
  const anchor = cookieValue(cookies, 'DefaultAnchorMailbox') || cookieValue(cookies, 'X-AnchorMailbox');
  debugLog('Outlook canary path', canary.path || '/');
  return httpRequest(app.window, {
    url,
    userContextId,
    method: 'POST',
    headers: {
      Action: 'FindConversation',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'X-OWA-CANARY': canary.value,
      'X-Requested-With': 'XMLHttpRequest',
      'X-AnchorMailbox': anchor
    },
    body: JSON.stringify(findConversationBody(shapeName)),
    cookieHosts: hosts,
    cookieHeader: requestCookies(cookies, requestPath, canary)
  });
}

async function postFind(app, tab, origin, hints, shapeName) {
  const creds = app.outlookAuth?.get(getTabUserContextId(tab));
  if (creds?.bearer) return postFindWithBearer(app, tab, creds, hints, shapeName);
  return postFindWithCookies(app, tab, origin, hints, shapeName);
}

export const outlookProvider = {
  id: 'outlook',
  label: 'Outlook',
  signInMessage: 'Open your Outlook tab once to connect',

  matches(hints) {
    if ((hints || []).some((hint) => String(hint).includes('mail.google.com'))) return false;
    if ((hints || []).some((hint) => HOSTS.includes(hostOf(hint)))) return true;
    return (hints || []).some((hint) => {
      const text = String(hint).trim().toLowerCase();
      return (
        text === 'outlook' ||
        text.includes('outlook.live') ||
        text.includes('outlook.office') ||
        text.includes('outlook.cloud.microsoft')
      );
    });
  },

  contextKey(tab, hints) {
    return 'outlook:' + familyOf(outlookOrigin(hints)) + ':' + getTabUserContextId(tab);
  },

  cacheToken(_tab, hints) {
    const origin = outlookOrigin(hints);
    return serviceUrl(origin, hints);
  },

  homeUrl(hints) {
    const origin = outlookOrigin(hints);
    const slot = mailSlot(hints);
    if (hostOf(origin) === 'outlook.live.com') return origin + '/mail/' + (slot || '0') + '/';
    return origin + '/mail/';
  },

  composeUrl(hints) {
    const origin = outlookOrigin(hints);
    const slot = mailSlot(hints);
    if (hostOf(origin) === 'outlook.live.com') {
      return origin + '/mail/' + (slot || '0') + '/deeplink/compose';
    }
    return origin + '/mail/deeplink/compose';
  },

  async fetchUnread(app, tab, hints) {
    const origin = outlookOrigin(hints);
    let fetched = await postFind(app, tab, origin, hints, 'MailListItem');
    debugLog('Outlook FindConversation', fetched.status, fetched.finalUrl);
    if (looksLikeLogin(fetched.status, fetched.finalUrl, fetched.text)) throw signInError();
    let data = null;
    try { data = JSON.parse(fetched.text || '{}'); } catch (e) {}
    const code = responseCode(data);
    if (code === 'ErrorAccessDenied' || code === 'ErrorInvalidUserPrincipalName') throw signInError();
    const retry = fetched.status >= 500 || (code.startsWith('Error') && code !== 'NoError') || thinConversations(data);
    if (retry) {
      debugLog('Outlook shape retry', code || fetched.status);
      fetched = await postFind(app, tab, origin, hints, '');
      if (looksLikeLogin(fetched.status, fetched.finalUrl, fetched.text)) throw signInError();
      try { data = JSON.parse(fetched.text || '{}'); } catch (e) { data = null; }
      const again = responseCode(data);
      if (again === 'ErrorAccessDenied') throw signInError();
      if (fetched.status < 200 || fetched.status >= 300) throw new Error('HTTP ' + fetched.status);
      if (again && again !== 'NoError') throw new Error(again);
    } else if (fetched.status < 200 || fetched.status >= 300) {
      throw new Error('HTTP ' + fetched.status);
    } else if (code && code !== 'NoError') {
      throw new Error(code);
    }
    if (!data) throw new Error('Not Outlook JSON');
    return parseConversations(data, origin, hints);
  }
};
