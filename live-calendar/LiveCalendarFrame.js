(function () {
  if (typeof content === 'undefined' || content.__liveCalendarWatch103) return;
  let href = '';
  try {
    href = String(content.location.href || '');
  } catch (e) {
    return;
  }
  if (!href.includes('calendar.google.com')) return;
  content.__liveCalendarWatch103 = true;

  const BROWSER_KEY = 'AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXxs';
  let busy = false;
  let lastAttempt = 0;
  let lastGood = 0;
  let timer = null;
  let hooked = false;

  function log(...args) {
    try { console.log('[Live Calendar]', ...args); } catch (e) {}
  }

  function localDay(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function utcDay(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function todayStart() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start;
  }

  function epochDay(date) {
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  }

  function todayKey() {
    return localDay(todayStart()).replace(/-/g, '');
  }

  function eventBelongsToToday(event) {
    const today = localDay(todayStart());
    const begin = todayStart().getTime();
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

  function keepToday(events) {
    return (events || []).filter((event) => eventBelongsToToday(event));
  }

  function dateKeyFromText(text) {
    const lower = String(text || '').toLowerCase();
    const months = [
      ['january', 0], ['janvier', 0], ['february', 1], ['février', 1], ['fevrier', 1],
      ['march', 2], ['mars', 2], ['april', 3], ['avril', 3], ['may', 4], ['mai', 4],
      ['june', 5], ['juin', 5], ['july', 6], ['juillet', 6], ['august', 7], ['août', 7], ['aout', 7],
      ['september', 8], ['septembre', 8], ['october', 9], ['octobre', 9],
      ['november', 10], ['novembre', 10], ['december', 11], ['décembre', 11], ['decembre', 11]
    ];
    const yearNow = todayStart().getFullYear();
    for (const [name, month] of months) {
      const found = lower.match(new RegExp('(?:' + name + '\\s+(\\d{1,2})|(\\d{1,2})\\s+' + name + ')(?:\\s+(20\\d{2}))?'));
      if (!found) continue;
      const dayNum = Number(found[1] || found[2]);
      const year = found[3] ? Number(found[3]) : yearNow;
      if (dayNum < 1 || dayNum > 31) continue;
      return `${year}${String(month + 1).padStart(2, '0')}${String(dayNum).padStart(2, '0')}`;
    }
    const iso = lower.match(/(20\d{2})-(\d{2})-(\d{2})/);
    return iso ? iso[1] + iso[2] + iso[3] : '';
  }

  function columnKey(node) {
    const attr = String(node.getAttribute('data-datekey') || node.getAttribute('data-date') || '').replace(/\D/g, '');
    if (/^\d{8}$/.test(attr)) return attr;
    return dateKeyFromText(node.getAttribute('aria-label') || '');
  }

  function dayColumns() {
    const cols = [];
    const nodes = content.document.querySelectorAll('[data-datekey], [data-date], [role="columnheader"], [role="gridcell"]');
    nodes.forEach((node) => {
      const key = columnKey(node);
      if (!/^\d{8}$/.test(key)) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 48 || rect.width > 420 || rect.height < 12) return;
      cols.push({ key, left: rect.left, right: rect.right, width: rect.width });
    });
    return cols;
  }

  function chipIsToday(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const mid = (rect.left + rect.right) / 2;
    const cols = dayColumns().filter((col) => mid >= col.left - 2 && mid <= col.right + 2);
    if (cols.length) {
      cols.sort((a, b) => a.width - b.width);
      return cols[0].key === todayKey();
    }
    const own = dateKeyFromText(node.getAttribute('aria-label') || '');
    if (own) return own === todayKey();
    return /\/r\/day\b/.test(content.location.pathname || '');
  }

  function accountSlot() {
    const match = String(content.location.pathname || '').match(/\/u\/(\d+)/);
    return match ? match[1] : '0';
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

  function accountEmail() {
    const nodes = content.document.querySelectorAll('[aria-label*="@"]');
    for (const node of nodes) {
      const match = (node.getAttribute('aria-label') || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      if (match) return match[0];
    }
    return '';
  }

  function decodeEventId(value) {
    if (!value) return { eventId: '', calendarId: '' };
    try {
      const raw = content.atob(String(value).replace(/-/g, '+').replace(/_/g, '/'));
      const space = raw.lastIndexOf(' ');
      if (space === -1) return { eventId: raw, calendarId: '' };
      let calendarId = raw.slice(space + 1);
      if (calendarId.length >= 2 && calendarId[calendarId.length - 2] === '@') {
        const mark = calendarId.slice(-1);
        calendarId = calendarId.slice(0, -1);
        calendarId += ({ m: 'gmail.com', g: 'group.calendar.google.com', h: 'holiday.calendar.google.com', i: 'import.calendar.google.com', v: 'group.v.calendar.google.com' })[mark] || '';
      }
      return { eventId: raw.slice(0, space), calendarId };
    } catch (e) {
      return { eventId: String(value), calendarId: '' };
    }
  }

  function chips() {
    const doc = content.document;
    const marked = Array.from(doc.querySelectorAll('[data-eventchip], [data-eventid][role="button"], [data-opens-details][data-eventid]'));
    if (marked.length) return marked;
    return Array.from(doc.querySelectorAll('[data-eventid]'));
  }

  function calendarIds() {
    const ids = new Set();
    const email = accountEmail();
    if (email) ids.add(email);
    chips().forEach((node) => {
      const decoded = decodeEventId(node.getAttribute('data-eventid'));
      if (decoded.calendarId && /@/.test(decoded.calendarId)) ids.add(decoded.calendarId);
    });
    content.document.querySelectorAll('[data-id]').forEach((node) => {
      const id = node.getAttribute('data-id') || '';
      if (/@/.test(id) && id.length < 120) ids.add(id);
    });
    return Array.from(ids);
  }

  function sha1Hex(text) {
    return content.crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)).then((buf) => {
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

  function parseClock(text) {
    const raw = String(text || '').trim().toLowerCase().replace(/\./g, '');
    if (/noon|midi/.test(raw)) return { hour: 12, minute: 0 };
    if (/midnight|minuit/.test(raw)) return { hour: 0, minute: 0 };
    const match = raw.match(/^(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|a|p)?$/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const mer = (match[3] || '').toLowerCase();
    if (mer === 'pm' || mer === 'p') {
      hour = hour % 12 + 12;
    } else if (mer === 'am' || mer === 'a') {
      hour = hour % 12;
    }
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  function onDayDate(clock) {
    const when = todayStart();
    when.setHours(clock.hour, clock.minute, 0, 0);
    return when;
  }

  function parseRange(text) {
    const blob = String(text || '');
    const pair = blob.match(/(\d{1,2}(?:[:h]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm|a|p)?)\s*(?:to|until|à|au|bis|–|—|-)\s*(\d{1,2}(?:[:h]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm|a|p)?)/i);
    if (!pair) {
      const single = blob.match(/\b(\d{1,2}(?:[:h]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm))\b/i);
      if (!single) return null;
      const startClock = parseClock(single[1]);
      if (!startClock) return null;
      const start = onDayDate(startClock);
      const end = new Date(start.getTime() + 30 * 60000);
      return { start: start.toISOString(), end: end.toISOString() };
    }
    const endMer = /am|pm|a|p/i.test(pair[2]) ? pair[2].replace(/[\d:h\s]/g, '') : '';
    const startClock = parseClock(/am|pm|a|p/i.test(pair[1]) ? pair[1] : `${pair[1]} ${endMer}`);
    const endClock = parseClock(pair[2]);
    if (!startClock || !endClock) return null;
    const start = onDayDate(startClock);
    const end = onDayDate(endClock);
    if (end <= start) end.setDate(end.getDate() + 1);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  function isAllDay(text) {
    return /all\s*day|toute la journ|ganztägig|todo el d[ií]a/i.test(text || '');
  }

  function cleanTitle(text, fallback) {
    const skip = /^(accepted|declined|tentative|needs action|optional|busy|available|calendar|location:|lieu :|accepté|refusé|provisoire|organizer|today|create)$/i;
    const parts = String(text || '').split(/,|\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const part of parts) {
      if (skip.test(part) || parseClock(part) || parseRange(part) || /^\d{1,2}\s+\w+/.test(part)) continue;
      if (part.length > 1) return part;
    }
    const hint = String(fallback || '').replace(/\s+/g, ' ').trim();
    return hint && !/^\(?no title\)?$/i.test(hint) ? hint : '';
  }

  function parseTimestamp(cell) {
    if (cell == null) return { ms: NaN, allDay: false };
    if (typeof cell === 'number' && cell > 1e11) return { ms: cell, allDay: true };
    if (!Array.isArray(cell)) return { ms: NaN, allDay: false };
    if (typeof cell[0] === 'number' && cell[0] > 1e11 && !Array.isArray(cell[1])) {
      return { ms: cell[0], allDay: true };
    }
    if (Array.isArray(cell[1]) && typeof cell[1][0] === 'number') {
      return { ms: cell[1][0], allDay: false };
    }
    if (typeof cell[1] === 'number' && cell[1] > 1e11) return { ms: cell[1], allDay: false };
    for (const item of cell) {
      if (typeof item === 'number' && item > 1e11) return { ms: item, allDay: cell.length === 1 };
      if (Array.isArray(item) && typeof item[0] === 'number' && item[0] > 1e11) {
        return { ms: item[0], allDay: false };
      }
    }
    return { ms: NaN, allDay: false };
  }

  function looksLikeEvent(arr) {
    if (!Array.isArray(arr) || arr.length < 6) return false;
    if (typeof arr[0] !== 'string' || arr[0].length < 5) return false;
    if (arr[1] === 2) return false;
    const urlOk = typeof arr[2] === 'string' && /calendar/.test(arr[2]);
    const titleOk = typeof arr[5] === 'string';
    const startOk = Array.isArray(arr[35]) || (typeof arr[35] === 'number' && arr[35] > 1e11);
    return (urlOk || startOk) && (titleOk || urlOk);
  }

  function joinFromTuple(arr) {
    if (typeof arr[45] === 'string' && arr[45].indexOf('http') === 0) return arr[45];
    const conf = arr[57];
    if (Array.isArray(conf) && Array.isArray(conf[0])) {
      for (const entry of conf[0]) {
        if (Array.isArray(entry) && typeof entry[1] === 'string' && entry[1].indexOf('http') === 0) {
          if (entry[0] === 3 || /meet|zoom|teams|webex/i.test(entry[1])) return entry[1];
        }
      }
    }
    return findCallUrl(`${arr[64] || ''}\n${arr[7] || ''}`);
  }

  function eventFromTuple(arr) {
    if (arr[82] === 10 || arr[82] === 11) return null;
    const start = parseTimestamp(arr[35]);
    const end = parseTimestamp(arr[36]);
    if (!Number.isFinite(start.ms)) return null;
    const event = {
      id: String(arr[0]),
      title: String(arr[5] || '').trim() || 'Event',
      start: new Date(start.ms).toISOString(),
      end: Number.isFinite(end.ms) ? new Date(end.ms).toISOString() : '',
      allDay: start.allDay,
      joinUrl: joinFromTuple(arr) || '',
      htmlLink: typeof arr[2] === 'string' ? arr[2] : ''
    };
    return eventBelongsToToday(event) ? event : null;
  }

  function eventsFromWire(text) {
    const stripped = String(text || '').replace(/^\)\]\}'\s*/, '');
    if (!stripped || stripped[0] !== '[') return [];
    let parsed;
    try { parsed = JSON.parse(stripped); } catch (e) { return []; }
    if (Array.isArray(parsed?.[0]) && parsed[0][0] === 'er' && parsed[0][5] === 401) {
      log('Calendar session expired');
      return null;
    }
    const found = [];
    const seen = new Set();
    (function visit(node) {
      if (!Array.isArray(node)) return;
      if (looksLikeEvent(node)) {
        const event = eventFromTuple(node);
        if (event && !seen.has(event.id)) {
          seen.add(event.id);
          found.push(event);
        }
        return;
      }
      for (const child of node) visit(child);
    })(parsed);
    return found;
  }

  function snapshot() {
    const nodes = chips().slice(0, 8);
    return {
      href: href.slice(0, 120),
      chips: chips().length,
      yn: content.document.querySelectorAll('.ynRLnc').length,
      titles: content.document.querySelectorAll('.FAxxKc').length,
      calendars: calendarIds(),
      samples: nodes.map((node) => ({
        id: (node.getAttribute('data-eventid') || '').slice(0, 40),
        aria: (node.getAttribute('aria-label') || '').slice(0, 80),
        text: String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        yn: String(node.querySelector('.ynRLnc')?.textContent || '').slice(0, 80)
      }))
    };
  }

  function hourScale() {
    const labels = Array.from(content.document.querySelectorAll('span, div, label')).filter((node) => {
      const text = String(node.textContent || '').trim();
      return /^(?:1[0-2]|[0-9])\s?(?:AM|PM)$/i.test(text) || /^([01]?\d|2[0-3])(?::00)?$/.test(text);
    }).slice(0, 30);
    const points = [];
    for (const node of labels) {
      const text = String(node.textContent || '').trim();
      const clock = parseClock(/am|pm/i.test(text) ? text : `${text.replace(':00', '')}:00`);
      if (!clock) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.height) continue;
      points.push({ minutes: clock.hour * 60 + clock.minute, y: rect.top });
    }
    points.sort((a, b) => a.y - b.y);
    if (points.length < 2) return null;
    const first = points[0];
    const second = points.find((point) => Math.abs(point.minutes - first.minutes) >= 30) || points[1];
    const pxPerMinute = (second.y - first.y) / (second.minutes - first.minutes);
    if (!Number.isFinite(pxPerMinute) || Math.abs(pxPerMinute) < 0.2) return null;
    return { zeroY: first.y - first.minutes * pxPerMinute, pxPerMinute };
  }

  function fromDom() {
    const day = localDay(todayStart());
    const scale = hourScale();
    const seen = new Set();
    const events = [];
    const nodes = chips();
    nodes.forEach((node) => {
      if (!chipIsToday(node)) return;
      const yn = String(node.querySelector('.ynRLnc')?.textContent || '').replace(/\s+/g, ' ').trim();
      const visible = String(node.querySelector('.FAxxKc, [data-text]')?.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = node.getAttribute('aria-label') || '';
      const inner = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      const blob = [yn, aria, visible, inner].filter(Boolean).join('\n');
      const allDay = isAllDay(blob);
      let range = allDay ? null : parseRange(blob);
      if (!range && scale) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 4) {
          const startMin = Math.round((rect.top - scale.zeroY) / scale.pxPerMinute);
          const endMin = startMin + Math.max(15, Math.round(rect.height / scale.pxPerMinute));
          if (startMin >= 0 && startMin < 1440) {
            const start = todayStart();
            start.setMinutes(startMin);
            const end = todayStart();
            end.setMinutes(Math.min(1440, endMin));
            range = { start: start.toISOString(), end: end.toISOString() };
          }
        }
      }
      const title = cleanTitle(yn || aria, visible || inner.split(',')[0]);
      if (!title) return;
      const decoded = decodeEventId(node.getAttribute('data-eventid'));
      const id = decoded.eventId || title + (range ? range.start : '');
      if (seen.has(id)) return;
      seen.add(id);
      events.push({
        id,
        title,
        start: range ? range.start : (allDay ? day : ''),
        end: range ? range.end : (allDay ? day : ''),
        allDay: allDay && !range,
        joinUrl: findCallUrl(blob),
        htmlLink: decoded.eventId && decoded.calendarId
          ? `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(node.getAttribute('data-eventid'))}`
          : ''
      });
    });
    if (!events.length) {
      Array.from(content.document.querySelectorAll('.ynRLnc')).forEach((node) => {
        if (!chipIsToday(node.parentElement || node)) return;
        const blob = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        const title = cleanTitle(blob);
        const range = isAllDay(blob) ? null : parseRange(blob);
        if (!title) return;
        const id = title + (range ? range.start : 'all');
        if (seen.has(id)) return;
        seen.add(id);
        events.push({
          id,
          title,
          start: range ? range.start : day,
          end: range ? range.end : day,
          allDay: !range,
          joinUrl: findCallUrl(blob),
          htmlLink: ''
        });
      });
    }
    events.sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const todayEvents = keepToday(events);
    log('Today chips', todayEvents.length, 'columns', dayColumns().map((col) => col.key).filter((key, index, list) => list.indexOf(key) === index).join(','));
    return { day, events: todayEvents.slice(0, 40), source: 'dom' };
  }

  function fromWireText(text, source) {
    const events = eventsFromWire(text);
    if (events == null) return { error: 'auth' };
    return { day: localDay(todayStart()), events, source };
  }

  function postRange(ids) {
    const start = todayStart();
    const from = epochDay(start);
    const to = from + 1;
    const slot = accountSlot();
    const list = ids.length ? ids : [accountEmail()].filter(Boolean);
    if (!list.length) return Promise.resolve(null);
    const bodies = [
      JSON.stringify([[list, [null, null, from, to], [null, 3, 'calendar.web_20260909.10_p0'], [null, 1, 1, 1, 1, null, 0, 0]]]),
      JSON.stringify([[list[0], list[0], null, null, from, to, null, 3, 'calendar.web_20260909.10_p0', null, 1, 1, 1, 1, null, 0, 0]])
    ];
    const urls = [
      `https://calendar.google.com/calendar/u/${slot}/sync.prefetcheventrange`,
      `https://calendar.google.com/calendar/u/${slot}/sync.fetcheventrange`
    ];
    let chain = Promise.resolve(null);
    urls.forEach((url) => {
      bodies.forEach((req) => {
        chain = chain.then((got) => {
          if (got && got.events) return got;
          return content.fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'X-Is-Xhr-Request': '1',
              'X-If-No-Redirect': '1'
            },
            body: `f.req=${encodeURIComponent(req)}`
          }).then((response) => response.ok ? response.text() : '')
            .then((text) => {
              if (!text) return null;
              const parsed = fromWireText(text, 'wire');
              if (parsed?.error) return null;
              log('Wire', url.split('/').pop(), parsed.events.length, 'calendars', list.length);
              return parsed;
            }).catch(() => null);
        });
      });
    });
    return chain;
  }

  function fromApi() {
    const start = todayStart();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const params = `singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&eventTypes=default&eventTypes=fromGmail&eventTypes=focusTime`;
    const ids = calendarIds();
    if (accountEmail() && !ids.includes(accountEmail())) ids.unshift(accountEmail());
    if (!ids.includes('primary')) ids.unshift('primary');
    return authHeader().then(async (header) => {
      const headers = { 'X-Goog-AuthUser': accountSlot(), Origin: 'https://calendar.google.com', Referer: 'https://calendar.google.com/' };
      if (header) headers.Authorization = header;
      const events = [];
      const seen = new Set();
      for (const calendarId of ids.slice(0, 8)) {
        const url = `https://clients6.google.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}&key=${BROWSER_KEY}`;
        try {
          const response = await content.fetch(url, { credentials: 'include', headers });
          if (!response.ok) continue;
          const body = await response.json();
          if (body.kind && body.kind !== 'calendar#events') continue;
          (body.items || []).forEach((item) => {
            if (!item || item.status === 'cancelled' || !item.id) return;
            const begin = item.start || {};
            const finish = item.end || {};
            const video = ((item.conferenceData || {}).entryPoints || []).find((entry) => entry.entryPointType === 'video' && entry.uri);
            const event = {
              id: String(item.id),
              title: item.summary || '',
              start: begin.dateTime || begin.date || '',
              end: finish.dateTime || finish.date || '',
              allDay: !begin.dateTime,
              joinUrl: item.hangoutLink || (video && video.uri) || findCallUrl(`${item.location || ''}\n${item.description || ''}`),
              htmlLink: item.htmlLink || ''
            };
            if (!event.title || seen.has(event.id)) return;
            seen.add(event.id);
            events.push(event);
          });
        } catch (e) {}
      }
      const todayEvents = keepToday(events);
      log('API events', todayEvents.length);
      return { day: localDay(start), events: todayEvents, source: 'api' };
    }).catch(() => null);
  }

  function usable(payload) {
    return !!(payload && Array.isArray(payload.events) && payload.events.some((event) => event.title && !/^\(?no title\)?$/i.test(event.title)));
  }

  function publish(force) {
    const now = Date.now();
    if (busy) return;
    if (!force && now - lastAttempt < (lastGood ? 20000 : 2500)) return;
    busy = true;
    lastAttempt = now;
    const debug = snapshot();
    log('Scan', debug);
    postRange(debug.calendars).then((wire) => {
      if (usable(wire)) return { ...wire, events: keepToday(wire.events) };
      return fromApi().then((api) => (usable(api) ? { ...api, events: keepToday(api.events) } : fromDom()));
    }).then((payload) => {
      if (!payload) return;
      const events = keepToday(payload.events);
      lastGood = events.filter((event) => event.title).length;
      sendAsyncMessage('LiveCalendar:Day', {
        ok: true,
        day: payload.day,
        source: payload.source,
        events,
        debug
      });
    }).catch((error) => {
      log('Read failed', error && error.message ? error.message : error);
    }).then(() => {
      busy = false;
    });
  }

  function inspectResponse(url, text) {
    if (!/prefetcheventrange|fetcheventrange/i.test(String(url || ''))) return;
    const parsed = fromWireText(text, 'wire');
    const events = keepToday(parsed?.events);
    if (!events.length) return;
    lastGood = events.length;
    log('Intercepted', events.length);
    sendAsyncMessage('LiveCalendar:Day', {
      ok: true,
      day: parsed.day,
      source: 'wire',
      events
    });
  }

  function hookNetwork() {
    if (hooked) return;
    hooked = true;
    try {
      const exp = typeof exportFunction === 'function'
        ? exportFunction
        : (typeof Cu !== 'undefined' && Cu.exportFunction);
      if (!exp) return;
      const proto = content.wrappedJSObject.XMLHttpRequest.prototype;
      const origOpen = proto.open;
      const origSend = proto.send;
      proto.open = exp(function (method, url) {
        try { this.__liveCalUrl = String(url); } catch (e) {}
        return origOpen.apply(this, arguments);
      }, content, { allowCrossOriginArguments: true });
      proto.send = exp(function (body) {
        try {
          this.addEventListener('load', function () {
            try { inspectResponse(this.__liveCalUrl, this.responseText); } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      }, content, { allowCrossOriginArguments: true });
    } catch (e) {
      log('XHR hook skipped', e && e.message);
    }
  }

  hookNetwork();
  addMessageListener('LiveCalendar:Refresh', () => publish(true));
  if (content.document.documentElement) {
    new content.MutationObserver(() => {
      if (timer) content.clearTimeout(timer);
      timer = content.setTimeout(() => publish(false), 900);
    }).observe(content.document.documentElement, { childList: true, subtree: true });
  }
  content.setInterval(() => publish(true), 60000);
  content.setTimeout(() => publish(true), 600);
})();
