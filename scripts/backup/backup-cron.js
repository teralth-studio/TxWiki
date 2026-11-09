const DEFAULT_TIME_ZONE = 'America/Guayaquil';
const TIME_ZONES = Object.freeze([...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])].sort());

function validateTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !TIME_ZONES.includes(timeZone)) throw new Error('TIME_ZONE_INVALID');
  return timeZone;
}

function zoneParts(date, timeZone = DEFAULT_TIME_ZONE) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: validateTimeZone(timeZone),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function parseField(field, min, max, weekday = false) {
  const values = new Set();
  for (const part of field.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2) throw new Error('CRON_INVALID');
    const base = pieces[0];
    const step = pieces.length === 2 ? Number(pieces[1]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error('CRON_INVALID');
    let from, to;
    if (base === '*') { from = min; to = max; }
    else if (/^\d+-\d+$/.test(base)) [from, to] = base.split('-').map(Number);
    else if (/^\d+$/.test(base)) { from = Number(base); to = pieces.length === 2 ? max : from; }
    else throw new Error('CRON_INVALID');
    if (from < min || to > max || from > to) throw new Error('CRON_INVALID');
    for (let value = from; value <= to; value += step) values.add(weekday && value === 7 ? 0 : value);
  }
  return values;
}

function validateBackupCron(expression) {
  if (typeof expression !== 'string' || expression.length > 100) throw new Error('CRON_INVALID');
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('CRON_INVALID');
  parseField(fields[0], 0, 59);
  parseField(fields[1], 0, 23);
  parseField(fields[2], 1, 31);
  parseField(fields[3], 1, 12);
  parseField(fields[4], 0, 7, true);
  return fields.join(' ');
}

function localTimeToUtc(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const shown = zoneParts(new Date(guess), timeZone);
  const shownUtc = Date.UTC(Number(shown.year), Number(shown.month) - 1, Number(shown.day), Number(shown.hour), Number(shown.minute), Number(shown.second));
  return new Date(guess + (guess - shownUtc));
}

function nextCronDate(expression, after = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  validateTimeZone(timeZone);
  const [minuteField, hourField, dayField, monthField, weekdayField] = validateBackupCron(expression).split(/\s+/);
  const minutes = [...parseField(minuteField, 0, 59)].sort((a, b) => a - b);
  const hours = [...parseField(hourField, 0, 23)].sort((a, b) => a - b);
  const days = parseField(dayField, 1, 31);
  const months = parseField(monthField, 1, 12);
  const weekdays = parseField(weekdayField, 0, 7, true);
  const dayWildcard = dayField.startsWith('*');
  const weekdayWildcard = weekdayField.startsWith('*');
  const now = zoneParts(after, timeZone);
  const firstDay = new Date(Date.UTC(Number(now.year), Number(now.month) - 1, Number(now.day)));
  for (let offset = 0; offset <= 2922; offset += 1) {
    const date = new Date(firstDay.getTime() + offset * 86400000);
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    const dayMatches = days.has(day);
    const weekdayMatches = weekdays.has(weekday);
    const calendarMatches = dayWildcard && weekdayWildcard || dayWildcard && weekdayMatches || weekdayWildcard && dayMatches || !dayWildcard && !weekdayWildcard && (dayMatches || weekdayMatches);
    if (!months.has(month) || !calendarMatches) continue;
    for (const hour of hours) for (const minute of minutes) {
      const candidate = localTimeToUtc(date.getUTCFullYear(), month, day, hour, minute, timeZone);
      if (candidate <= after) continue;
      const actual = zoneParts(candidate, timeZone);
      if (Number(actual.year) === date.getUTCFullYear() && Number(actual.month) === month && Number(actual.day) === day && Number(actual.hour) === hour && Number(actual.minute) === minute) return candidate;
    }
  }
  throw new Error('CRON_NO_NEXT_RUN');
}

module.exports = { DEFAULT_TIME_ZONE, TIME_ZONES, validateTimeZone, validateBackupCron, nextCronDate };
