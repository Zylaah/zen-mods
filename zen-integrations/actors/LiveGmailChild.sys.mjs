const SCAN_DEBOUNCE_MS = 500;

export class LiveGmailChild extends JSWindowActorChild {
  #observer = null;
  #scanTimeout = null;
  #retryTimer = null;
  #watchTimer = null;
  #lastReadKey = '';
  #seenHref = '';
  #retryCount = 0;
  #hasRowBaseline = false;
  #previousRows = new Map();
  #onHash = null;

  actorCreated() {
    if (!this.#isTopFrame()) return;
    if (this.#reportFeed()) return;
    this.#setupObserver();
  }

  handleEvent(event) {
    if (!this.#isTopFrame()) return;
    if (event.type === 'hashchange') {
      this.#setupObserver();
      return;
    }
    if (event.type !== 'DOMContentLoaded' && event.type !== 'pageshow') return;
    if (this.#reportFeed()) return;
    this.#setupObserver();
  }

  #reportFeed() {
    const doc = this.document;
    const win = this.contentWindow;
    if (!doc || !win) return false;
    let href = '';
    try {
      href = win.location.href || '';
    } catch (e) {
      return false;
    }
    if (!/\/feed\/atom/i.test(href)) return false;

    const root = doc.documentElement?.localName || '';
    const contentType = doc.contentType || '';
    const isFeed = root === 'feed';
    let text = '';
    if (isFeed) {
      try {
        text = new win.XMLSerializer().serializeToString(doc);
      } catch (e) {}
    }
    try {
      this.sendAsyncMessage('LiveGmail:FeedDocument', {
        href,
        text,
        contentType,
        root,
        signin: !isFeed || /accounts\.google\.com|ServiceLogin/i.test(href)
      });
    } catch (e) {}
    return true;
  }

  didDestroy() {
    try {
      this.#observer?.disconnect();
    } catch (e) {}
    this.#observer = null;
    const win = this.contentWindow;
    if (win && this.#onHash) {
      try { win.removeEventListener('hashchange', this.#onHash); } catch (e) {}
    }
    this.#onHash = null;
    if (win && this.#scanTimeout) win.clearTimeout(this.#scanTimeout);
    if (win && this.#retryTimer) win.clearTimeout(this.#retryTimer);
    if (win && this.#watchTimer) win.clearInterval(this.#watchTimer);
    this.#scanTimeout = null;
    this.#retryTimer = null;
    this.#watchTimer = null;
  }

  #isTopFrame() {
    try {
      return this.browsingContext.top === this.browsingContext;
    } catch (e) {
      return false;
    }
  }

  #isGmail() {
    try {
      return this.contentWindow?.location?.hostname === 'mail.google.com';
    } catch (e) {
      return false;
    }
  }

  #readStateKey() {
    const rows = this.document?.querySelectorAll('tr.zA, tr[role="row"], div[role="row"]') || [];
    const parts = [];
    for (const row of rows) {
      const unread = row.classList.contains('zE') || row.getAttribute('data-is-read') === 'false';
      const id = row.getAttribute('data-legacy-thread-id') || row.getAttribute('data-thread-id') || '';
      parts.push((unread ? 'u' : 'r') + id);
    }
    return String(rows.length) + ':' + parts.join(',');
  }

  receiveMessage(message) {
    if (message.name === 'LiveGmail:InboxReady') return this.#inboxStatus();
    if (message.name === 'LiveGmail:ShowInbox') return this.#showInbox();
    if (message.name === 'LiveGmail:OpenThread') return this.#clickMatchingThread(message.data || {});
    if (message.name !== 'LiveGmail:FetchAtom') return null;
    return this.#fetchAtom();
  }

  #inboxRows() {
    const doc = this.document;
    if (!doc) return [];
    for (const selector of ['tr.zA', 'tr[role="row"]', 'div[role="row"]']) {
      const rows = [...doc.querySelectorAll(selector)];
      if (rows.length) return rows;
    }
    return [];
  }

  #inboxStatus() {
    if (!this.#isTopFrame() || !this.#isGmail()) return { rows: 0, inboxReady: false };
    const doc = this.document;
    const rows = this.#inboxRows();
    const main = !!doc?.querySelector('div[role="main"]');
    const busy = !!doc?.querySelector('[aria-busy="true"], [role="progressbar"]');
    return { rows: rows.length, inboxReady: rows.length > 0 || (main && !busy) };
  }

  #showInbox() {
    if (!this.#isTopFrame() || !this.#isGmail()) return this.#inboxStatus();
    const win = this.contentWindow;
    try {
      const hash = win?.location?.hash || '';
      const onInbox = /^#inbox\/?$/i.test(hash);
      if (!onInbox) win.location.hash = '#inbox';
    } catch (e) {}
    return this.#inboxStatus();
  }

  #rowText(row, selector) {
    return (row.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  #rowIds(row) {
    const ids = new Set();
    const add = (value) => {
      if (value) ids.add(String(value));
    };
    add(row.getAttribute('data-legacy-thread-id'));
    add(row.getAttribute('data-thread-id'));
    add(row.getAttribute('data-thread-perm-id'));
    for (const node of row.querySelectorAll('[data-legacy-thread-id], [data-thread-id], [data-thread-perm-id], a[href]')) {
      add(node.getAttribute('data-legacy-thread-id'));
      add(node.getAttribute('data-thread-id'));
      add(node.getAttribute('data-thread-perm-id'));
      add(node.getAttribute('href'));
    }
    return ids;
  }

  #rowMatches(row, data) {
    const wanted = new Set((data.ids || []).map((id) => String(id)));
    if (wanted.size) {
      for (const value of this.#rowIds(row)) {
        if (wanted.has(value)) return true;
        for (const id of wanted) {
          if (value.includes(id)) return true;
        }
      }
    }
    return false;
  }

  #clickRow(row) {
    const link = row.querySelector('a[href*="#"], a[role="link"], [role="link"]') || row.querySelector('a');
    if (link && typeof link.click === 'function') link.click();
    else row.click();
  }

  #clickMatchingThread(data) {
    if (!this.#isTopFrame() || !this.#isGmail()) return { ok: false };
    const rows = this.#inboxRows();
    for (const row of rows) {
      if (!this.#rowMatches(row, data)) continue;
      this.#clickRow(row);
      return { ok: true };
    }
    const subject = String(data.subject || '').replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (subject) {
      const hits = rows.filter((row) => {
        const text = this.#rowText(row, 'span[data-thread-id], span.bog, .y6 span')
          .replace(/^\s*((re|fwd|fw)\s*:\s*)+/i, '')
          .toLowerCase();
        return text === subject;
      });
      if (hits.length === 1) {
        this.#clickRow(hits[0]);
        return { ok: true };
      }
    }
    return { ok: false, rows: rows.length };
  }

  #hashLooksOpen() {
    try {
      const hash = this.contentWindow?.location?.hash || '';
      return /[#/](?:[0-9a-f]{12,}|FMfc[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,})(?:$|[/?#])/i.test(hash);
    } catch (e) {
      return false;
    }
  }

  #addId(ids, value) {
    if (value) ids.add(String(value));
  }

  #openThreadIds() {
    const doc = this.document;
    if (!doc) return [];
    const ids = new Set();
    const messages = [...doc.querySelectorAll('[data-legacy-message-id], [data-message-id]')].filter(
      (node) => !node.closest('tr, [role="row"]')
    );
    for (const node of messages) {
      this.#addId(ids, node.getAttribute('data-legacy-message-id'));
      this.#addId(ids, node.getAttribute('data-legacy-thread-id'));
      this.#addId(ids, node.getAttribute('data-thread-perm-id'));
      let parent = node.parentElement;
      for (let depth = 0; depth < 8 && parent; depth++) {
        const threadId = parent.getAttribute('data-legacy-thread-id');
        const permId = parent.getAttribute('data-thread-perm-id');
        this.#addId(ids, threadId);
        this.#addId(ids, permId);
        if (threadId || permId) break;
        parent = parent.parentElement;
      }
    }
    if (messages.length) {
      for (const node of doc.querySelectorAll('h1[data-thread-perm-id], h2[data-thread-perm-id], [role="heading"][data-thread-perm-id]')) {
        this.#addId(ids, node.getAttribute('data-thread-perm-id'));
        this.#addId(ids, node.getAttribute('data-legacy-thread-id'));
      }
    }
    return [...ids];
  }

  #openSubject() {
    const doc = this.document;
    if (!doc) return '';
    const open = [...doc.querySelectorAll('[data-legacy-message-id], [data-message-id]')].some(
      (node) => !node.closest('tr, [role="row"]')
    );
    if (!open) return '';
    const heading = doc.querySelector('h2[data-thread-perm-id], h1[data-thread-perm-id], [role="heading"][data-thread-perm-id], h2.hP');
    return (heading?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  #rowStates() {
    const states = new Map();
    const rows = this.document?.querySelectorAll('tr.zA, tr[role="row"], div[role="row"], span[data-thread-id]') || [];
    for (const row of rows) {
      const id = row.getAttribute('data-legacy-thread-id') || row.getAttribute('data-thread-id') || '';
      if (!id) continue;
      const unread = row.classList.contains('zE') || row.getAttribute('data-is-read') === 'false';
      const previous = states.get(id);
      states.set(id, previous === undefined ? unread : previous || unread);
    }
    return states;
  }

  #newlyReadIds(states) {
    const read = [];
    if (this.#hasRowBaseline) {
      for (const [id, wasUnread] of this.#previousRows) {
        if (wasUnread && states.has(id) && !states.get(id)) read.push(id);
      }
    }
    this.#previousRows = states;
    this.#hasRowBaseline = true;
    return read;
  }

  #feedUrlFromDocument() {
    const win = this.contentWindow;
    const href = win?.location?.href || '';
    const url = new win.URL(href);
    if (url.protocol !== 'https:' || url.hostname !== 'mail.google.com') {
      throw new Error('Gmail feed requires a paired Gmail tab');
    }
    const account = url.pathname.match(/\/mail\/u\/(\d+)(?:\/|$)/)?.[1] || '0';
    return 'https://mail.google.com/mail/u/' + account + '/feed/atom';
  }

  #fetchAtom() {
    const win = this.contentWindow;
    if (!win?.XMLHttpRequest) {
      return Promise.reject(new Error('Gmail tab not ready'));
    }
    let feedUrl;
    try {
      feedUrl = this.#feedUrlFromDocument();
    } catch (e) {
      return Promise.reject(e);
    }

    return new Promise((resolve, reject) => {
      let xhr;
      try {
        xhr = new win.XMLHttpRequest();
      } catch (e) {
        reject(e);
        return;
      }
      try { xhr.mozBackgroundRequest = true; } catch (e) {}
      try { xhr.open('GET', feedUrl, true); } catch (e) { reject(e); return; }
      try { xhr.withCredentials = true; } catch (e) {}
      xhr.onload = () => {
        try {
          resolve({
            status: xhr.status,
            finalUrl: xhr.responseURL || feedUrl,
            text: xhr.responseText ?? '',
            feedUrl
          });
        } catch (e) {
          reject(e);
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(new Error('Aborted'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      try { xhr.timeout = 8000; } catch (e) {}
      try { xhr.send(); } catch (e) { reject(e); }
    });
  }

  #maybeNotify() {
    if (!this.#isTopFrame() || !this.#isGmail()) return;
    const win = this.contentWindow;
    let href = '';
    try {
      href = win?.location?.href || '';
    } catch (e) {}
    const threadIds = this.#openThreadIds();
    const readIds = this.#newlyReadIds(this.#rowStates());
    const subject = this.#openSubject();
    const key = href + '|' + this.#readStateKey() + '|' + threadIds.join(',') + '|' + readIds.join(',') + '|' + subject;
    if (threadIds.length) this.#retryCount = 0;
    if (key === this.#lastReadKey) {
      if (this.#hashLooksOpen() && !threadIds.length) this.#scheduleRetry();
      return;
    }
    this.#lastReadKey = key;
    this.#seenHref = href;
    try {
      this.sendAsyncMessage('LiveGmail:ReadState', {
        key,
        href,
        threadIds,
        readIds,
        subject
      });
    } catch (e) {}
    if (this.#hashLooksOpen() && !threadIds.length) this.#scheduleRetry();
  }

  #scheduleNotify(delay = SCAN_DEBOUNCE_MS) {
    const win = this.contentWindow;
    if (!win) return;
    if (this.#scanTimeout) win.clearTimeout(this.#scanTimeout);
    this.#scanTimeout = win.setTimeout(() => {
      this.#scanTimeout = null;
      this.#maybeNotify();
    }, delay);
  }

  #scheduleRetry() {
    const win = this.contentWindow;
    if (!win || this.#retryTimer || this.#retryCount >= 4) return;
    this.#retryCount += 1;
    this.#retryTimer = win.setTimeout(() => {
      this.#retryTimer = null;
      this.#maybeNotify();
    }, 800);
  }

  #ensureHashListener() {
    const win = this.contentWindow;
    if (!win || this.#onHash) return;
    this.#onHash = () => this.#scheduleNotify(200);
    try {
      win.addEventListener('hashchange', this.#onHash);
    } catch (e) {
      this.#onHash = null;
    }
  }

  #ensureLocationWatch() {
    const win = this.contentWindow;
    if (!win || this.#watchTimer) return;
    this.#watchTimer = win.setInterval(() => {
      let href = '';
      try { href = win.location.href || ''; } catch (e) {}
      if (!href || href === this.#seenHref) return;
      this.#seenHref = href;
      this.#retryCount = 0;
      this.#scheduleNotify(200);
    }, 400);
  }

  #setupObserver() {
    if (!this.#isTopFrame() || !this.#isGmail()) return;
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) return;
    this.#ensureHashListener();
    this.#ensureLocationWatch();

    const target = doc.documentElement || doc.body;
    if (!target) {
      win.setTimeout(() => this.#setupObserver(), 1000);
      return;
    }
    if (this.#observer) {
      this.#scheduleNotify(200);
      return;
    }

    this.#observer = new win.MutationObserver(() => this.#scheduleNotify());
    this.#observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-legacy-thread-id', 'data-legacy-message-id', 'data-thread-perm-id']
    });
    this.#scheduleNotify(200);
  }
}
