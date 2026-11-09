const { debugLog, localDay } = ChromeUtils.importESModule(
  'chrome://sine/content/live-calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);

export class LiveCalendarCache {
  constructor(app) {
    this.app = app;
  }

  getFilePath() {
    const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    return PathUtils.join(profileDir, 'live-calendar-cache.json');
  }

  getOrCreateContext(key) {
    const storeKey = String(key ?? 0);
    if (!this.app.contexts.has(storeKey)) {
      const stored = this.app.diskStore[storeKey];
      this.app.contexts.set(storeKey, {
        day: stored?.day || '',
        events: Array.isArray(stored?.events) ? stored.events.slice() : [],
        fetchedAt: stored?.fetchedAt || 0
      });
    }
    return this.app.contexts.get(storeKey);
  }

  activate(key) {
    const storeKey = String(key ?? 0);
    if (storeKey !== this.app.activeContextKey) {
      this.persistActive(this.app.activeContextKey);
      this.app.activeContextKey = storeKey;
      debugLog('Calendar context', storeKey);
    }
    const ctx = this.getOrCreateContext(storeKey);
    this.app.day = ctx.day;
    this.app.events = ctx.events;
  }

  persistActive(key = this.app.activeContextKey) {
    if (!key) return;
    const ctx = this.getOrCreateContext(key);
    ctx.day = this.app.day;
    ctx.events = this.app.events;
  }

  applyDay(key, day, events, source = '') {
    const ctx = this.getOrCreateContext(key);
    const incoming = Array.isArray(events) ? events.slice() : [];
    if (!incoming.length && ctx.day === day && ctx.events.length && source !== 'api' && source !== 'wire') {
      return false;
    }
    ctx.day = day;
    ctx.events = incoming;
    ctx.fetchedAt = Date.now();
    if (String(key) === String(this.app.activeContextKey)) {
      this.app.day = ctx.day;
      this.app.events = ctx.events;
    }
    this.save();
    return true;
  }

  todayEvents(key) {
    const ctx = this.getOrCreateContext(key);
    if (ctx.day !== localDay()) return [];
    return ctx.events;
  }

  save() {
    try {
      this.persistActive(this.app.activeContextKey);
      const store = {};
      for (const [key, ctx] of this.app.contexts.entries()) {
        store[key] = {
          day: ctx.day || '',
          fetchedAt: ctx.fetchedAt || 0,
          events: (ctx.events || []).slice(0, 50)
        };
      }
      this.app.diskStore = store;
      IOUtils.writeUTF8(this.getFilePath(), JSON.stringify(store)).catch(() => {});
    } catch (e) {}
  }

  load() {
    const activate = () => this.activate(this.app.getContextKey());
    try {
      IOUtils.readUTF8(this.getFilePath())
        .then((json) => {
          const parsed = JSON.parse(json);
          if (parsed && typeof parsed === 'object') this.app.diskStore = parsed;
          for (const key of Object.keys(this.app.diskStore)) {
            const stored = this.app.diskStore[key];
            const existing = this.app.contexts.get(String(key));
            const storedEvents = Array.isArray(stored?.events) ? stored.events : [];
            if (!existing || (!existing.events.length && storedEvents.length)) {
              this.app.contexts.set(String(key), {
                day: stored?.day || '',
                events: storedEvents.slice(),
                fetchedAt: stored?.fetchedAt || 0
              });
            }
          }
          activate();
          this.app.tabs.updatePills();
          if (this.app.panel.isOpen()) this.app.panel.updateDisplay();
        })
        .catch(activate);
    } catch (e) {
      activate();
    }
  }
}
