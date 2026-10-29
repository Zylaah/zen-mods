const SCAN_DEBOUNCE_MS = 500;

export class LiveGmailChild extends JSWindowActorChild {
  #observer = null;
  #scanTimeout = null;
  #lastReadKey = '';

  handleEvent(event) {
    if (event.type === 'DOMContentLoaded' || event.type === 'pageshow') {
      this.#setupObserver();
    }
  }

  didDestroy() {
    try {
      this.#observer?.disconnect();
    } catch (e) {}
    this.#observer = null;
    const win = this.contentWindow;
    if (win && this.#scanTimeout) {
      win.clearTimeout(this.#scanTimeout);
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
    if (message.name !== 'LiveGmail:FetchAtom') return null;
    return this.#fetchAtom(message.data?.feedUrl);
  }

  #fetchAtom(feedUrl) {
    const win = this.contentWindow;
    if (!win || !this.#isGmail()) {
      return Promise.reject(new Error('Gmail tab not ready'));
    }
    let parsed;
    try {
      parsed = new win.URL(String(feedUrl || ''));
    } catch (e) {
      return Promise.reject(new Error('Bad feed URL'));
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'mail.google.com' ||
      !/\/mail\/u\/\d+\/feed\/atom$/.test(parsed.pathname)
    ) {
      return Promise.reject(new Error('Bad feed URL'));
    }

    return new Promise((resolve, reject) => {
      let xhr;
      try {
        xhr = new win.XMLHttpRequest();
      } catch (e) {
        reject(e);
        return;
      }
      try {
        xhr.mozBackgroundRequest = true;
      } catch (e) {}
      try {
        xhr.open('GET', parsed.href, true);
      } catch (e) {
        reject(e);
        return;
      }
      xhr.withCredentials = true;
      xhr.timeout = 8000;
      xhr.onload = () => {
        const text = String(xhr.responseText || '');
        if (text.length > 500000) {
          reject(new Error('Feed too large'));
          return;
        }
        resolve({
          status: xhr.status,
          finalUrl: xhr.responseURL || parsed.href,
          text
        });
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.onabort = () => reject(new Error('Aborted'));
      try {
        xhr.send();
      } catch (e) {
        reject(e);
      }
    });
  }

  #maybeNotify() {
    if (!this.#isGmail()) return;
    const key = this.#readStateKey();
    if (key === this.#lastReadKey) return;
    this.#lastReadKey = key;
    try {
      this.sendAsyncMessage('LiveGmail:ReadState', { key });
    } catch (e) {}
  }

  #setupObserver() {
    if (!this.#isGmail()) return;
    const win = this.contentWindow;
    const doc = this.document;
    if (!win || !doc) return;

    try {
      this.#observer?.disconnect();
    } catch (e) {}

    const target = doc.querySelector('div[role="main"]') || doc.body;
    if (!target) {
      win.setTimeout(() => this.#setupObserver(), 1000);
      return;
    }

    this.#observer = new win.MutationObserver(() => {
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
