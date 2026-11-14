export const CONFIG = {
  DEBUG_PREF: 'live-calendar.debug',
  CALENDAR_URL: 'calendar.google.com',
  PANEL_ID: 'live-calendar-panel',
  HOVER_DELAY_MS: 200,
  SOON_MS: 10 * 60 * 1000,
  PILL_WINDOW_MS: 5 * 60 * 1000,
  PILL_TICK_MS: 15000,
  POLL_MS: 60000,
  CACHE_MS: 60000,
  REQUEST_TIMEOUT_MS: 8000,
  GOOGLE_CLIENT_PREF: 'live-calendar.google.clientId',
  GOOGLE_CLIENT_SECRET_PREF: 'live-calendar.google.clientSecret',
  GOOGLE_TOKEN_FILE: 'live-calendar-google-tokens.json'
};

export const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

const CALL_HOSTS = [
  'meet.google.com',
  'zoom.us',
  'zoom.com',
  'teams.microsoft.com',
  'teams.live.com',
  'webex.com',
  'whereby.com',
  'around.co'
];

export function isDebugEnabled() {
  try {
    return Services.prefs.getBoolPref(CONFIG.DEBUG_PREF, false);
  } catch (e) {
    return false;
  }
}

export function debugLog(...args) {
  if (isDebugEnabled()) console.log('[Live Calendar]', ...args);
}

export function getTabUserContextId(tab) {
  if (!tab) return 0;
  if (typeof tab.userContextId === 'number' && !Number.isNaN(tab.userContextId)) {
    return tab.userContextId;
  }
  return parseInt(tab.getAttribute('usercontextid') || '0', 10) || 0;
}

export function isEssentialOrPinnedTab(tab) {
  return !!(tab && (tab.hasAttribute('zen-essential') || tab.pinned));
}

export function isPinnedCalendarTab(tab) {
  return !!(tab?.pinned && !tab.hasAttribute('zen-essential'));
}

export function localDay(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function eventBelongsToToday(event, now = new Date()) {
  const today = localDay(now);
  const begin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const end = begin + 86400000;
  const startMs = Date.parse(event?.start);
  if (event?.allDay) {
    if (typeof event.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(event.start)) {
      return event.start.slice(0, 10) === today;
    }
    return Number.isFinite(startMs) && localDay(new Date(startMs)) === today;
  }
  if (!Number.isFinite(startMs)) return false;
  if (startMs >= begin && startMs < end) return true;
  const endMs = Date.parse(event?.end);
  return Number.isFinite(endMs) && startMs < begin && endMs > begin;
}

export function eventStartMs(event) {
  if (!event || event.allDay) return NaN;
  const ms = Date.parse(event.start);
  return Number.isFinite(ms) ? ms : NaN;
}

export function eventEndMs(event) {
  if (!event || event.allDay) return NaN;
  const ms = Date.parse(event.end);
  return Number.isFinite(ms) ? ms : NaN;
}

export function isSoonOrJustStarted(event, now = Date.now()) {
  const start = eventStartMs(event);
  if (!Number.isFinite(start)) return false;
  return now >= start - CONFIG.PILL_WINDOW_MS && now <= start + CONFIG.PILL_WINDOW_MS;
}

export function canJoin(event, now = Date.now()) {
  if (!event?.joinUrl || event.allDay) return false;
  const start = eventStartMs(event);
  const end = eventEndMs(event);
  if (!Number.isFinite(start)) return false;
  const until = Number.isFinite(end) ? end : start + CONFIG.SOON_MS;
  return now >= start - CONFIG.SOON_MS && now <= until;
}

export function pillText(event, now = Date.now()) {
  const start = eventStartMs(event);
  if (!Number.isFinite(start)) return '';
  const minutes = Math.round((start - now) / 60000);
  if (minutes > 0) return `in ${minutes}m`;
  if (minutes < 0) return `${Math.abs(minutes)}m ago`;
  return 'now';
}

export function pickPillEvent(events, now = Date.now()) {
  const hits = (events || []).filter((event) => isSoonOrJustStarted(event, now));
  hits.sort((a, b) => eventStartMs(a) - eventStartMs(b));
  const started = hits.find((event) => eventStartMs(event) <= now);
  return started || hits[0] || null;
}

export function formatClock(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDayTitle(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date();
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function findCallUrl(...parts) {
  const text = parts.filter(Boolean).join('\n');
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const raw of matches) {
    const url = raw.replace(/[),.;]+$/, '');
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (CALL_HOSTS.some((known) => host === known || host.endsWith('.' + known))) return url;
    } catch (e) {}
  }
  return '';
}

export function escapeHtml(doc, text) {
  const div = doc.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML.replace(/"/g, '&quot;');
}
