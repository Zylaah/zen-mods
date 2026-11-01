const SCAN_DEBOUNCE_MS = 500;

export class LiveGmailChild extends JSWindowActorChild {
  #observer = null;
  #scanTimeout = null;
  #lastReadKey = '';
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
    if (win && this.#scanTimeout) {
      win.clearTimeout(this.#scanTimeout);
    }
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
    if (message.name === 'LiveGmail:OpenInPage') {
      this.#openInPage(message.data?.hash);
      return null;
    }
    if (message.name !== 'LiveGmail:FetchAtom') return null;
    return this.#fetchAtom();
  }

  #openInPage(hash) {
    if (!this.#isTopFrame() || !this.#isGmail()) return;
    if (!hash || typeof hash !== 'string' || !hash.startsWith('#')) return;
    const win = this.contentWindow;
    try {
      if ((win.location.hash || '') !== hash) win.location.hash = hash;
    } catch (e) {}
  }

  #hashLooksOpen() {
    try {
      const hash = this.contentWindow?.location?.hash || '';
      return /[#/](?:[0-9a-f]{12,}|FMfc[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,})(?:$|[/?#])/i.test(hash);
    } catch (e) {
      return false;
    }
  }

  #conversationThreadIds() {
    if (!this.#hashLooksOpen()) return [];
    const doc = this.document;
    if (!doc) return [];
    const ids = new Set();
    const add = (node) => {
      if (!node) return;
      for (const attr of ['data-legacy-thread-id', 'data-thread-id']) {
        const value = node.getAttribute(attr);
        if (value) ids.add(value);
      }
    };
    add(doc.querySelector('tr.btb, tr.zA.aps, tr[aria-selected="true"], div[role="row"][aria-selected="true"]'));
    const distinct = new Set();
    for (const node of doc.querySelectorAll('[data-legacy-thread-id]')) {
      const value = node.getAttribute('data-legacy-thread-id');
      if (value) distinct.add(value);
    }
    if (distinct.size === 1) {
      for (const value of distinct) ids.add(value);
    }
    return [...ids];
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
    let href = '';
    try {
      href = this.contentWindow?.location?.href || '';
    } catch (e) {}
    const key = href + '|' + this.#readStateKey();
    if (key === this.#lastReadKey) return;
    this.#lastReadKey = key;
    try {
      this.sendAsyncMessage('LiveGmail:ReadState', {
        key,
        href,
        threadIds: this.#conversationThreadIds()
      });
    } catch (e) {}
  }

  #ensureHashListener() {
    const win = this.contentWindow;
    if (!win || this.#onHash) return;
    this.#onHash = () => this.#setupObserver();
    try {
      win.addEventListener('hashchange', this.#onHash);
    } catch (e) {
      this.#onHash = null;
    }
  }

  #setupObserver() {
    if (!this.#isTopFrame() || !this.#isGmail()) return;
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) return;
    this.#ensureHashListener();

    try {
      this.#observer?.disconnect();
    } catch (e) {}
    this.#observer = null;

    const target = doc.querySelector('div[role="main"]') || doc.body;
    if (!target) {
      this.#maybeNotify();
      win.setTimeout(() => this.#setupObserver(), 1000);
      return;
    }

    this.#observer = new win.MutationObserver(() => {
      if (!target.isConnected) {
        try { this.#observer?.disconnect(); } catch (e) {}
        this.#observer = null;
        this.#setupObserver();
        return;
      }
      if (this.#scanTimeout) win.clearTimeout(this.#scanTimeout);
      this.#scanTimeout = win.setTimeout(() => this.#maybeNotify(), SCAN_DEBOUNCE_MS);
    });
    this.#observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
    this.#maybeNotify();
  }
}
