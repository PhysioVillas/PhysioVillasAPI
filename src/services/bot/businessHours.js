const DEFAULT_TIMEZONE = 'America/Bahia';
const SEARCH_DAYS = 14;

const formatters = new Map();

function getFormatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      }),
    );
  }
  return formatters.get(timeZone);
}

/** Calendar fields of an instant as seen in the given timezone. */
function localParts(date, timeZone) {
  const parts = {};
  for (const part of getFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour % 24,
    minute: parts.minute,
  };
}

/** Offset in ms between the timezone wall clock and UTC at the given instant. */
function offsetAt(instantMs, timeZone) {
  const p = localParts(new Date(instantMs), timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wallAsUtc - Math.floor(instantMs / 60000) * 60000;
}

/** Converts a wall-clock time in the timezone to a UTC instant (ms). */
function wallClockToInstant(year, month, day, hour, minute, timeZone) {
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const first = wallMs - offsetAt(wallMs, timeZone);
  return wallMs - offsetAt(first, timeZone);
}

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new TypeError(`Invalid time "${value}", expected HH:MM`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * True when `date` falls inside the support window on a configured weekday.
 * The window is start-inclusive and end-exclusive (08:00 open, 18:00 closed).
 */
export function isWithinSupportHours(date, { start, end, days }, timezone = DEFAULT_TIMEZONE) {
  const p = localParts(date, timezone);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const minutes = p.hour * 60 + p.minute;
  return days.includes(weekday) && minutes >= parseTime(start) && minutes < parseTime(end);
}

/**
 * Next instant at which support opens. If `date` is already inside the window,
 * it is returned unchanged.
 */
export function nextSupportOpening(date, { start, end, days }, timezone = DEFAULT_TIMEZONE) {
  if (isWithinSupportHours(date, { start, end, days }, timezone)) {
    return new Date(date.getTime());
  }
  const startMinutes = parseTime(start);
  const startHour = Math.floor(startMinutes / 60);
  const startMinute = startMinutes % 60;
  const today = localParts(date, timezone);

  for (let offset = 0; offset <= SEARCH_DAYS; offset += 1) {
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    if (!days.includes(calendar.getUTCDay())) {
      continue;
    }
    const opening = new Date(wallClockToInstant(year, month, day, startHour, startMinute, timezone));
    if (opening.getTime() > date.getTime()) {
      return opening;
    }
  }
  throw new RangeError(`No support opening within ${SEARCH_DAYS} days for days=${JSON.stringify(days)}`);
}
