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
