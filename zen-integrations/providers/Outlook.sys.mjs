const { CONFIG, debugLog, fnv1a, getTabUserContextId } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);
const { normalizeOutlookFields } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookDate.sys.mjs' + new URL(import.meta.url).search
);
const { outlookClientState } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookGraph.sys.mjs' + new URL(import.meta.url).search
);
const {
  beginOutlookSignIn,
  fetchOutlookGraph,
  outlookSignInMessage,
  readOutlookClientId
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookAuth.sys.mjs' + new URL(import.meta.url).search
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

function mailSlot(hints) {
  for (const hint of hints || []) {
    const match = String(hint).match(/\/mail\/(\d+)\//);
    if (match) return match[1];
  }
  return '';
}

function outlookActor(tab) {
  try {
    return tab?.linkedBrowser?.browsingContext?.currentWindowGlobal?.getActor('ZenOutlook') || null;
  } catch (e) {
    return null;
  }
}

async function scrapeUnread(app, tab) {
  const browser = tab?.linkedBrowser;
  let discarded = true;
  try {
    discarded = !browser?.browsingContext || browser.browsingContext.discarded;
  } catch (e) {}
  if (discarded) return null;
  const actor = outlookActor(tab);
  if (!actor?.sendQuery) return null;
  let scraped;
  try {
    scraped = await actor.sendQuery('ZenOutlook:Scrape');
  } catch (e) {
    debugLog('Outlook scrape failed', e && e.message ? e.message : e);
    return null;
  }
  if (!scraped?.ready) return null;
  const scrapedRows = scraped.rows || [];
  if (scrapedRows[0]) {
    debugLog('Outlook row', scrapedRows[0].date, scrapedRows[0].from, scrapedRows[0].subject, scrapedRows[0].snippet);
  }
  return scrapedRows.slice(0, CONFIG.MAX_EMAILS).map((row, sourceRank) => {
    const threadId = row.id || row.key || '';
    const fields = normalizeOutlookFields(row);
    return {
      id: 'outlook:' + fnv1a(threadId || row.subject + '|' + row.from),
      threadId,
      gmailThreadId: '',
      legacyThreadId: '',
      from: row.from || 'Unknown',
      subject: row.subject || '(No subject)',
      snippet: fields.snippet,
      date: fields.date,
      ts: 0,
      isUnread: true,
      url: '',
      rowIndex: sourceRank
    };
  });
}

export const outlookProvider = {
  id: 'outlook',
  label: 'Outlook',
  get signInMessage() {
    return outlookSignInMessage() || 'Open the Outlook tab to load unread mail';
  },

  beginSignIn(app, tab) {
    const hints = app.tabs.getUrlHints(tab);
    return beginOutlookSignIn(app, tab, this.contextKey(tab, hints));
  },

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
    return outlookOrigin(hints);
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

  // null means the tab is unloaded or the list is not in the page yet.
  // The panel keeps the cached rows in that case.
  // A Microsoft app id switches this container to Graph. No id keeps the tab scrape.
  async fetchUnread(app, tab, hints) {
    if (outlookClientState(readOutlookClientId()) === 'missing') return scrapeUnread(app, tab);
    return fetchOutlookGraph(app, tab, this.contextKey(tab, hints));
  }
};
