(function () {
  if (typeof content === 'undefined' || content.__liveCalendarWatch101) return;
  let href = '';
  try {
    href = String(content.location.href || '');
  } catch (e) {
    return;
  }
  if (!href.includes('calendar.google.com')) return;
  content.__liveCalendarWatch101 = true;

  let busy = false;
  let lastAttempt = 0;
  let lastCount = -1;
  let apiKey = '';
  let searchedHtml = false;
  let timer = null;

  function debug(...args) {
    try {
      if (Services.prefs.getBoolPref('live-calendar.debug', false)) console.log('[Live Calendar]', ...args);
    } catch (e) {}
  }

  function localDay(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function todayStart() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start;
  }

  function findCallUrl(text) {
    const matches = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const raw of matches) {
      const url = raw.replace(/[),.;]+$/, '');
      if (/meet\.google\.|zoom\.|teams\.microsoft\.|teams\.live\.|webex\.|whereby\.|around\.co/i.test(url)) return url;
    }
    return '';
  }

  function cookieValue(name) {
    const parts = String(content.document.cookie || '').split(';');
    for (const part of parts) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === name) {
        try { return decodeURIComponent(part.slice(idx + 1).trim()); }
        catch (e) { return part.slice(idx + 1).trim(); }
      }
    }
    return '';
  }

  function accountSlot() {
    const match = String(content.location.pathname || '').match(/\/u\/(\d+)/);
    return match ? match[1] : '0';
  }

  function findApiKey() {
    if (apiKey) return apiKey;
    const scripts = content.document.querySelectorAll('script');
    for (const script of scripts) {
      const match = (script.textContent || '').match(/AIzaSy[0-9A-Za-z_-]{20,}/);
      if (match) {
        apiKey = match[0];
        return apiKey;
      }
    }
    if (!searchedHtml) {
      searchedHtml = true;
      const match = (content.document.documentElement?.innerHTML || '').match(/AIzaSy[0-9A-Za-z_-]{20,}/);
      if (match) apiKey = match[0];
    }
    return apiKey;
  }

  function sha1Hex(text) {
    const data = new TextEncoder().encode(text);
    return content.crypto.subtle.digest('SHA-1', data).then((buf) => {
      return Array.from(new Uint8Array(buf)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    });
  }

  function authHeader() {
    const sapisid = cookieValue('SAPISID');
    if (!sapisid) return Promise.resolve('');
    const now = Math.floor(Date.now() / 1000);
    const origin = 'https://calendar.google.com';
    return sha1Hex(`${now} ${sapisid} ${origin}`).then(async (hash) => {
      let header = `SAPISIDHASH ${now}_${hash}`;
      const one = cookieValue('__Secure-1PAPISID');
      const three = cookieValue('__Secure-3PAPISID');
      if (one) header += ` SAPISID1PHASH ${now}_${await sha1Hex(`${now} ${one} ${origin}`)}`;
      if (three) header += ` SAPISID3PHASH ${now}_${await sha1Hex(`${now} ${three} ${origin}`)}`;
      return header;
    });
  }

  function accountEmail() {
    const nodes = content.document.querySelectorAll('[aria-label*="@"]');
    for (const node of nodes) {
      const match = (node.getAttribute('aria-label') || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match) return match[0];
    }
    return '';
  }

  function clockOnDay(base, hourText, minuteText, meridian) {
    let hour = Number(hourText);
    const minute = Number(minuteText || 0);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (meridian) {
      hour = hour % 12;
      if (String(meridian).toLowerCase() === 'pm') hour += 12;
    }
    if (hour > 23 || minute > 59) return null;
    const when = new Date(base);
    when.setHours(hour, minute, 0, 0);
    return when;
  }

  function parseLabelRange(label) {
    const match = String(label || '').match(/(\d{1,2})(?:\s*[:h]\s*(\d{2}))?\s*(am|pm)?\s*(?:to|until|–|—|-|à)\s*(\d{1,2})(?:\s*[:h]\s*(\d{2}))?\s*(am|pm)?/i);
    if (!match) return null;
    const base = todayStart();
    const endMeridian = match[6] || match[3] || '';
    const start = clockOnDay(base, match[1], match[2], match[3] || endMeridian);
    const end = clockOnDay(base, match[4], match[5], endMeridian);
    if (!start || !end) return null;
    if (end <= start) end.setDate(end.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function isAllDay(text) {
    return /all\s*day|toute la journ|ganztägig|todo el d[ií]a/i.test(text || '');
  }

  function labelIsOtherDay(text) {
    const months = [
      ['janvier', 1], ['january', 1], ['février', 2], ['fevrier', 2], ['february', 2],
      ['mars', 3], ['march', 3], ['avril', 4], ['april', 4], ['mai', 5], ['may', 5],
      ['juin', 6], ['june', 6], ['juillet', 7], ['july', 7], ['août', 8], ['aout', 8], ['august', 8],
      ['septembre', 9], ['september', 9], ['octobre', 10], ['october', 10],
      ['novembre', 11], ['november', 11], ['décembre', 12], ['decembre', 12], ['december', 12]
    ];
    const lower = String(text || '').toLowerCase();
    const now = todayStart();
    for (const [name, month] of months) {
      if (!lower.includes(name)) continue;
      const found = lower.match(new RegExp('(?:' + name + '\\s+(\\d{1,2})|(\\d{1,2})\\s+' + name + ')'));
      if (!found) continue;
      const dayNum = Number(found[1] || found[2]);
      return month !== now.getMonth() + 1 || dayNum !== now.getDate();
    }
    return false;
  }

  function closestDay(node) {
    const today = localDay(todayStart());
    const compact = today.replace(/-/g, '');
    let current = node;
    for (let depth = 0; depth < 8 && current; depth++) {
      const value = current.getAttribute?.('data-date') || current.getAttribute?.('data-datekey') || '';
      if (/^\d{8}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return value === today || value === compact ? 'today' : 'other';
      }
      current = current.parentElement;
    }
    return '';
  }

  function buttonEvents() {
    return Array.from(content.document.querySelectorAll('[role="button"][aria-label], [role="gridcell"][aria-label]')).filter((node) => {
      const label = node.getAttribute('aria-label') || '';
      return isAllDay(label) || !!parseLabelRange(label);
    });
  }

  function fromDom() {
    const day = localDay(todayStart());
    const seen = new Set();
    const events = [];
    const marked = Array.from(content.document.querySelectorAll('[data-eventid], [data-eventchip]'));
    const nodes = marked.length ? marked : buttonEvents();
    nodes.forEach((node) => {
      const label = node.getAttribute('aria-label') || '';
      const extra = node.querySelector('.ynRLnc, .FAxxKc, [data-text]')?.textContent || '';
      const blob = `${label}\n${extra}`;
      if (labelIsOtherDay(blob) || closestDay(node) === 'other') return;
      const named = node.querySelector('.FAxxKc, [data-text], .I0UMhb, .event-summary');
      const title = ((named && named.textContent) || label.split(/,|\n/)[0] || '(No title)').replace(/\s+/g, ' ').trim();
      const allDay = isAllDay(blob);
      const range = allDay ? null : parseLabelRange(blob);
      const start = range ? range.start : '';
      const id = node.getAttribute('data-eventid') || `${title}|${start || day}`;
      if (!title || seen.has(id)) return;
      seen.add(id);
      events.push({
        id,
        title,
        start: start || (allDay ? day : ''),
        end: range ? range.end : (allDay ? day : ''),
        allDay,
        joinUrl: findCallUrl(blob),
        htmlLink: ''
      });
    });
    if (!events.length && marked.length) {
      seen.clear();
      buttonEvents().forEach((node) => {
        const label = node.getAttribute('aria-label') || '';
        if (labelIsOtherDay(label) || closestDay(node) === 'other') return;
        const title = (label.split(/,|\n/)[0] || '(No title)').replace(/\s+/g, ' ').trim();
        const allDay = isAllDay(label);
        const range = allDay ? null : parseLabelRange(label);
        const start = range ? range.start : '';
        const id = `${title}|${start || day}`;
        if (!title || seen.has(id)) return;
        seen.add(id);
        events.push({
          id,
          title,
          start: start || (allDay ? day : ''),
          end: range ? range.end : (allDay ? day : ''),
          allDay,
          joinUrl: findCallUrl(label),
          htmlLink: ''
        });
      });
    }
    events.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return String(a.start).localeCompare(String(b.start));
    });
    if (!events.length && !content.document.querySelector('[role="main"]')) return null;
    return { day, events: events.slice(0, 30), source: 'dom' };
  }

  function normalize(item) {
    if (!item || item.status === 'cancelled' || !item.id) return null;
    const self = (item.attendees || []).find((person) => person.self);
    if (self && self.responseStatus === 'declined') return null;
    const start = item.start || {};
    const end = item.end || {};
    const video = ((item.conferenceData || {}).entryPoints || []).find((entry) => entry.entryPointType === 'video' && entry.uri);
    return {
      id: String(item.id),
      title: item.summary || '(No title)',
      start: start.dateTime || start.date || '',
      end: end.dateTime || end.date || '',
      allDay: !start.dateTime,
      joinUrl: item.hangoutLink || (video && video.uri) || findCallUrl(`${item.location || ''}\n${item.description || ''}`),
      htmlLink: item.htmlLink || ''
    };
  }

  function fromApi() {
    const start = todayStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const day = localDay(start);
    const params = `singleEvents=true&orderBy=startTime&maxResults=30&timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}`;
    const slot = accountSlot();
    return authHeader().then(async (header) => {
      const headers = { 'X-Goog-AuthUser': slot };
      if (header) headers.Authorization = header;
      const urls = [`https://calendar.google.com/calendar/u/${slot}/v3/calendars/primary/events?${params}`];
      const key = findApiKey();
      if (key && header) {
        urls.push(`https://clients6.google.com/calendar/v3/calendars/primary/events?${params}&key=${encodeURIComponent(key)}`);
      }
      for (const url of urls) {
        try {
          const response = await content.fetch(url, { credentials: 'include', headers });
          if (!response.ok) continue;
          const body = await response.json();
          if (!body || !Array.isArray(body.items)) continue;
          const events = body.items.map(normalize).filter(Boolean);
          events.sort((a, b) => {
            if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
            return String(a.start).localeCompare(String(b.start));
          });
          return { day, events, source: 'api' };
        } catch (e) {}
      }
      return null;
    }).catch(() => null);
  }

  function fromEmbed() {
    const email = accountEmail();
    if (!email) return Promise.resolve(null);
    const start = todayStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const day = localDay(start);
    const dates = `${day.replace(/-/g, '')}/${localDay(end).replace(/-/g, '')}`;
    const url = `https://calendar.google.com/calendar/u/${accountSlot()}/embed?mode=AGENDA&src=${encodeURIComponent(email)}&dates=${dates}&ctz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')}`;
    return content.fetch(url, { credentials: 'include' }).then((response) => {
      if (!response.ok) return null;
      return response.text();
    }).then((html) => {
      if (!html || !/event-summary|data-eventid/i.test(html)) return null;
      const doc = new content.DOMParser().parseFromString(html, 'text/html');
      const nodes = doc.querySelectorAll('.event, [data-eventid]');
      const events = [];
      const seen = new Set();
      nodes.forEach((node) => {
        const title = (node.querySelector('.event-summary, .summary, [data-text]')?.textContent || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        if (!title || seen.has(title)) return;
        seen.add(title);
        const when = node.querySelector('.event-time, .time')?.textContent || node.getAttribute('aria-label') || '';
        const allDay = isAllDay(when);
        const range = allDay ? null : parseLabelRange(when);
        events.push({
          id: node.getAttribute('data-eventid') || `${title}|${day}`,
          title,
          start: range ? range.start : (allDay ? day : ''),
          end: range ? range.end : (allDay ? day : ''),
          allDay,
          joinUrl: findCallUrl(node.textContent || ''),
          htmlLink: ''
        });
      });
      return events.length ? { day, events, source: 'api' } : null;
    }).catch(() => null);
  }

  function publish(force) {
    const now = Date.now();
    if (busy) return;
    if (!force && now - lastAttempt < (lastCount > 0 ? 20000 : 2000)) return;
    busy = true;
    lastAttempt = now;
    fromApi().then((payload) => payload || fromEmbed()).then((payload) => payload || fromDom()).then((payload) => {
      if (!payload) return;
      lastCount = payload.events.length;
      debug('Read', payload.source, payload.events.length);
      sendAsyncMessage('LiveCalendar:Day', {
        ok: true,
        day: payload.day,
        source: payload.source,
        events: payload.events
      });
    }).catch((error) => {
      debug('Read failed', error);
    }).then(() => {
      busy = false;
    });
  }

  function schedule() {
    if (timer) content.clearTimeout(timer);
    timer = content.setTimeout(() => publish(false), 700);
  }

  addMessageListener('LiveCalendar:Refresh', () => publish(true));
  if (content.document.documentElement) {
    new content.MutationObserver(schedule).observe(content.document.documentElement, { childList: true, subtree: true });
  }
  content.setInterval(() => publish(true), 60000);
  content.setTimeout(() => publish(true), 800);
})();
