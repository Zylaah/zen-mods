const {
  CONFIG,
  cookieJar,
  debugLog,
  fnv1a,
  getTabUserContextId,
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

function serviceUrl(origin, hints) {
  const host = hostOf(origin);
  const useZero = host === 'outlook.live.com' || (hints || []).some((hint) => /\/owa\/0\//.test(String(hint)));
  const prefix = useZero ? '/owa/0' : '/owa';
  return origin + prefix + '/service.svc?action=FindConversation&app=Mail';
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

async function postFind(app, tab, origin, hints, shapeName) {
  const url = serviceUrl(origin, hints);
  const hosts = cookieHosts(origin);
  const jar = cookieJar(getTabUserContextId(tab), url, hosts);
  const canary = canaryValue(jar.get('X-OWA-CANARY')?.value || '');
  if (!canary) throw signInError();
  const anchor = jar.get('DefaultAnchorMailbox')?.value || jar.get('X-AnchorMailbox')?.value || '';
  return httpRequest(app.window, {
    url,
    userContextId: getTabUserContextId(tab),
    method: 'POST',
    headers: {
      Action: 'FindConversation',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
      'X-OWA-CANARY': canary,
      'X-Requested-With': 'XMLHttpRequest',
      'X-AnchorMailbox': anchor
    },
    body: JSON.stringify(findConversationBody(shapeName)),
    cookieHosts: hosts
  });
}

export const outlookProvider = {
  id: 'outlook',
  label: 'Outlook',
  signInMessage: 'Sign in to Outlook to see unread mail',

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
