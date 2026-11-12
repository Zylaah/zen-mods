const {
  CONFIG,
  debugLog,
  fnv1a,
  getGmailUrlPattern,
  getTabOriginAttributes,
  getTabUserContextId,
  httpRequest
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

const GMAIL_HOSTS = ['mail.google.com', 'google.com'];

export function gmailAccountSlotFromHints(hints) {
  for (const hint of hints || []) {
    const match = String(hint).match(/\/mail\/u\/(\d+)/);
    if (match) return match[1];
  }
  return '0';
}

export function gmailAccountSlotFromUrl(url) {
  const match = String(url || '').match(/\/mail\/u\/(\d+)/);
  return match ? match[1] : '';
}

export function isGmailThreadToken(value) {
  const token = String(value || '');
  if (/^[0-9a-f]{12,}$/i.test(token)) return true;
  if (/^FMfc[A-Za-z0-9_-]{8,}$/.test(token)) return true;
  if (/^[A-Za-z0-9_-]{16,}$/.test(token)) return true;
  return false;
}

export function gmailThreadIdFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const parts = decodeURIComponent(parsed.hash || '')
      .replace(/^#/, '')
      .split('/')
      .filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (isGmailThreadToken(parts[i])) return parts[i];
    }
    const th = parsed.searchParams.get('th') || '';
    if (isGmailThreadToken(th)) return th;
  } catch (e) {}
  return '';
}

export function gmailInPageHash(url) {
  const threadId = gmailThreadIdFromUrl(url);
  if (!threadId) return '';
  try {
    const hash = new URL(url).hash || '';
    if (hash.includes(threadId)) return hash;
  } catch (e) {}
  return '#inbox/' + threadId;
}

export function gmailSpaUrl(url) {
  const hash = gmailInPageHash(url);
  if (!hash) return '';
  const slot = gmailAccountSlotFromUrl(url) || '0';
  return `https://${getGmailUrlPattern()}/mail/u/${slot}/${hash}`;
}

export function urlHasThreadToken(url, threadId) {
  if (!url || !isGmailThreadToken(threadId)) return false;
  let decoded = String(url);
  try {
    decoded = decodeURIComponent(decoded);
  } catch (e) {}
  const token = String(threadId);
  let from = 0;
  while (from <= decoded.length) {
    const at = decoded.indexOf(token, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : decoded.charAt(at - 1);
    const after = decoded.charAt(at + token.length);
    const boundary = /[/#&=?]/;
    if ((!before || boundary.test(before)) && (!after || boundary.test(after))) return true;
    from = at + token.length;
  }
  return false;
}

export function legacyIdFromAtomId(atomId) {
  const match = String(atomId || '').match(/(\d{12,})$/);
  if (!match) return '';
  try {
    const hex = BigInt(match[1]).toString(16);
    return isGmailThreadToken(hex) ? hex : '';
  } catch (e) {
    return '';
  }
}

export function subjectsMatch(left, right) {
  const norm = (value) => String(value || '')
    .replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const a = norm(left);
  const b = norm(right);
  return a.length > 0 && a === b;
}

export function emailMatchesThread(email, threadId) {
  if (!email || !threadId) return false;
  if (
    email.threadId === threadId ||
    email.gmailThreadId === threadId ||
    email.legacyThreadId === threadId
  ) {
    return true;
  }
  return urlHasThreadToken(email.url, threadId);
}

export function normalizeGmailOpenUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname.toLowerCase() !== 'mail.google.com') return '';
    if (/\/feed\/atom/i.test(parsed.pathname)) {
      const slot = parsed.pathname.match(/\/u\/(\d+)/)?.[1] || '0';
      return `https://mail.google.com/mail/u/${slot}/#inbox`;
    }
    return parsed.href;
  } catch (e) {
    return '';
  }
}

function hintHosts(hints) {
  const hosts = [];
  for (const hint of hints || []) {
    try {
      hosts.push(new URL(hint).hostname.toLowerCase());
    } catch (e) {}
  }
  return hosts;
}

function isOutlookHint(hints) {
  const hosts = hintHosts(hints);
  if (hosts.some((host) => host === 'outlook.live.com' || host === 'outlook.office.com' || host === 'outlook.office365.com' || host === 'outlook.cloud.microsoft')) {
    return true;
  }
  return (hints || []).some((hint) => {
    const text = String(hint).toLowerCase();
    return text.includes('outlook.live') || text.includes('outlook.office') || text.includes('outlook.cloud.microsoft');
  });
}

function feedUrl(hints) {
  const slot = gmailAccountSlotFromHints(hints);
  return `https://${getGmailUrlPattern()}/mail/u/${slot}/feed/atom`;
}

function signInError() {
  const error = new Error('Sign-in required');
  error.signin = true;
  return error;
}

function parseAtom(win, xml, sourceUrl) {
  const feed = new win.DOMParser().parseFromString(xml, 'application/xml');
  if (feed.documentElement?.localName !== 'feed' || feed.querySelector('parsererror')) {
    throw new Error('Not an Atom feed');
  }
  const value = (node, name) =>
    (node.getElementsByTagNameNS('*', name)[0]?.textContent || '').trim();
  const items = Array.from(feed.getElementsByTagNameNS('*', 'entry')).map((entry, sourceRank) => {
    const atomId = value(entry, 'id');
    const subject = value(entry, 'title') || '(No subject)';
    const sender = value(entry, 'name') || value(entry, 'email') || 'Unknown';
    const snippet = value(entry, 'summary').slice(0, 200);
    const link = Array.from(entry.getElementsByTagNameNS('*', 'link')).find(
      (node) => !node.getAttribute('rel') || node.getAttribute('rel') === 'alternate'
    );
    let url = '';
    try {
      url = new URL(link?.getAttribute('href') || '', sourceUrl).href;
    } catch (e) {}
    url = normalizeGmailOpenUrl(url);
    const gmailThreadId = gmailThreadIdFromUrl(url);
    const legacyThreadId = legacyIdFromAtomId(atomId);
    const date =
      value(entry, 'issued') ||
      value(entry, 'published') ||
      value(entry, 'modified') ||
      value(entry, 'updated');
    const ts = Date.parse(date);
    const id = 'gmail:atom:' + fnv1a(atomId || url + '|' + subject);
    return {
      id,
      threadId: id,
      gmailThreadId,
      legacyThreadId,
      from: sender,
      subject,
      snippet,
      date: Number.isFinite(ts) ? new Date(ts).toISOString() : date,
      ts: Number.isFinite(ts) ? ts : 0,
      isUnread: true,
      url,
      rowIndex: sourceRank
    };
  });
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.rowIndex - b.rowIndex);
  return items.slice(0, CONFIG.MAX_EMAILS);
}

export const gmailProvider = {
  id: 'gmail',
  label: 'Gmail',
  signInMessage: 'Sign in to Gmail to see unread mail',

  matches(hints) {
    if (hintHosts(hints).some((host) => host === 'mail.google.com' || host === getGmailUrlPattern())) return true;
    if (isOutlookHint(hints)) return false;
    const pattern = getGmailUrlPattern();
    if ((hints || []).some((hint) => String(hint).includes(pattern))) return true;
    return (hints || []).some((hint) => {
      const text = String(hint).trim().toLowerCase();
      if (text === 'gmail' || text.includes('mail.google') || text.includes('google.com/mail')) return true;
      return text.includes('gmail') && (text.includes('gstatic') || text.includes('.ico') || text.includes('favicon'));
    });
  },

  contextKey(tab) {
    return 'gmail:' + getTabUserContextId(tab);
  },

  cacheToken(_tab, hints) {
    return feedUrl(hints);
  },

  homeUrl(hints) {
    const slot = gmailAccountSlotFromHints(hints);
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/#inbox`;
  },

  composeUrl(hints) {
    const slot = gmailAccountSlotFromHints(hints);
    return `https://${getGmailUrlPattern()}/mail/u/${slot}/#inbox?compose=new`;
  },

  async fetchUnread(app, tab, hints) {
    const sourceUrl = feedUrl(hints);
    const fetched = await httpRequest(app.window, {
      url: sourceUrl,
      userContextId: getTabUserContextId(tab),
      originAttributes: getTabOriginAttributes(tab),
      method: 'GET',
      headers: { Accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8' },
      cookieHosts: GMAIL_HOSTS
    });
    const { status, finalUrl, text } = fetched;
    debugLog('Gmail Atom', status, finalUrl);
    if (status === 401 || status === 403) throw signInError();
    const feedDocument = /<feed[\s>]/.test(text || '');
    const head = (text || '').slice(0, 2000);
    if (
      !feedDocument &&
      (/accounts\.google\.com|ServiceLogin/i.test(finalUrl || '') ||
        /accounts\.google\.com|ServiceLogin/i.test(head))
    ) {
      throw signInError();
    }
    if (status < 200 || status >= 300) throw new Error('HTTP ' + status);
    if (finalUrl && finalUrl !== sourceUrl && !finalUrl.startsWith('https://mail.google.com/mail/')) {
      throw new Error('Feed URL changed');
    }
    if ((text || '').length > CONFIG.MAX_BYTES) throw new Error('Feed too large');
    return parseAtom(app.window, text, sourceUrl);
  }
};
