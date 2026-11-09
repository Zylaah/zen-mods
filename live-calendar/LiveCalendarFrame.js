(function () {
  if (typeof content === 'undefined' || content.__liveCalendarWatch) return;
  try {
    if (content.top !== content) return;
  } catch (e) {
    return;
  }
  let href = '';
  try {
    href = String(content.location.href || '');
  } catch (e) {
    return;
  }
  if (!href.includes('calendar.google.com')) return;
  content.__liveCalendarWatch = true;

  const RETRY_MS = 15000;
  let busy = false;
  let lastAttempt = 0;
  let apiKey = '';
  let timer = null;

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
        try {
          return decodeURIComponent(part.slice(idx + 1).trim());
        } catch (e) {
          return part.slice(idx + 1).trim();
        }
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
      const text = script.textContent || '';
      const match = text.match(/AIzaSy[0-9A-Za-z_-]{20,}/);
      if (match) {
        apiKey = match[0];
        return apiKey;
      }
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

  function fetchJson(url, header) {
    return content.fetch(url, {
      credentials: 'include',
      headers: {
        Authorization: header,
        'X-Goog-AuthUser': accountSlot(),
        'X-Origin': 'https://calendar.google.com'
      }
    }).then((response) => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    });
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
    const key = findApiKey();
    if (!key) return Promise.resolve(null);
    const start = todayStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const day = localDay(start);
    return authHeader().then((header) => {
      if (!header) return null;
      const listUrl = `https://clients6.google.com/calendar/v3/users/me/calendarList?maxResults=20&minAccessRole=reader&key=${encodeURIComponent(key)}`;
      return fetchJson(listUrl, header).then((list) => {
        const calendars = (list.items || []).filter((cal) => cal && cal.id && cal.selected !== false).slice(0, 8);
        if (!calendars.length) calendars.push({ id: 'primary' });
        const seen = new Set();
        const events = [];
        let failures = 0;
        let chain = Promise.resolve();
        calendars.forEach((cal) => {
          chain = chain.then(() => {
            const url = `https://clients6.google.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?singleEvents=true&orderBy=startTime&maxResults=15&timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&key=${encodeURIComponent(key)}`;
            return fetchJson(url, header).then((body) => {
              (body.items || []).forEach((item) => {
                const event = normalize(item);
                if (!event || seen.has(event.id)) return;
                seen.add(event.id);
                events.push(event);
              });
            }).catch(() => {
              failures += 1;
            });
          });
        });
        return chain.then(() => {
          if (failures === calendars.length) return null;
          events.sort((a, b) => {
            if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
            return String(a.start).localeCompare(String(b.start));
          });
          return { day, events: events.slice(0, 30) };
        });
      });
    });
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
    const match = String(label || '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|–|-|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!match) return null;
    const base = todayStart();
    const endMeridian = match[6] || match[3] || '';
    const start = clockOnDay(base, match[1], match[2], match[3] || endMeridian);
    const end = clockOnDay(base, match[4], match[5], endMeridian);
    if (!start || !end) return null;
    if (end <= start) end.setDate(end.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function belongsToToday(node) {
    const dashed = localDay(todayStart());
    const key = dashed.replace(/-/g, '');
    let current = node;
    let sawDate = false;
    for (let depth = 0; depth < 14 && current; depth++) {
      const blob = [current.getAttribute?.('data-datekey'), current.getAttribute?.('data-date')].filter(Boolean).join(' ');
      if (blob) {
        sawDate = true;
        if (blob.includes(key) || blob.includes(dashed)) return true;
      }
      current = current.parentElement;
    }
    if (sawDate) return false;
    return /\/r\/day\b/.test(content.location.pathname || '');
  }

  function fromDom() {
    const day = localDay(todayStart());
    const nodes = content.document.querySelectorAll('[data-eventid]');
    const seen = new Set();
    const events = [];
    nodes.forEach((node) => {
      const id = node.getAttribute('data-eventid');
      if (!id || seen.has(id) || !belongsToToday(node)) return;
      seen.add(id);
      const label = node.getAttribute('aria-label') || '';
      const titleNode = node.querySelector('[data-text], .I0UMhb');
      const title = ((titleNode && titleNode.textContent) || label.split(',')[0] || '(No title)').replace(/\s+/g, ' ').trim();
      const allDay = /all\s*day/i.test(label);
      const range = allDay ? null : parseLabelRange(label);
      const snippet = (node.innerHTML || '').slice(0, 2000);
      events.push({
        id,
        title,
        start: range ? range.start : (allDay ? day : ''),
        end: range ? range.end : (allDay ? day : ''),
        allDay,
        joinUrl: findCallUrl(`${label}\n${snippet}`),
        htmlLink: ''
      });
    });
    return events.length ? { day, events } : null;
  }

  function publish(force) {
    const now = Date.now();
    if (busy || (!force && now - lastAttempt < RETRY_MS)) return;
    busy = true;
    lastAttempt = now;
    fromApi().catch(() => null).then((payload) => payload || fromDom()).then((payload) => {
      if (!payload) return;
      sendAsyncMessage('LiveCalendar:Day', {
        ok: true,
        day: payload.day,
        events: payload.events
      });
    }).catch(() => {}).then(() => {
      busy = false;
    });
  }

  function schedule() {
    if (timer) content.clearTimeout(timer);
    timer = content.setTimeout(() => publish(false), 800);
  }

  addMessageListener('LiveCalendar:Refresh', () => publish(true));
  if (content.document.documentElement) {
    const observer = new content.MutationObserver(schedule);
    observer.observe(content.document.documentElement, { childList: true, subtree: true });
  }
  content.setInterval(() => publish(true), 60000);
  content.setTimeout(() => publish(true), 1200);
})();
