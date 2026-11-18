import assert from 'node:assert/strict';
import test from 'node:test';
import { isWithinSupportHours, nextSupportOpening } from '../src/services/bot/businessHours.js';

const TZ = 'America/Bahia';
const SUPPORT = { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] };
// 2026-11-18 is a Wednesday. Bahia is UTC-3 (no DST), so 08:00 local is 11:00Z.
const WED = '2026-11-18';

function at(localTime, day = WED) {
  const [h, m] = localTime.split(':').map(Number);
  return new Date(`${day}T${String(h + 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
}

test('support window is start-inclusive: 07:59 is closed, 08:00 is open', () => {
  assert.equal(isWithinSupportHours(at('07:59'), SUPPORT, TZ), false);
  assert.equal(isWithinSupportHours(at('08:00'), SUPPORT, TZ), true);
});

test('support window is end-exclusive: 17:59 is open, 18:00 is closed', () => {
  assert.equal(isWithinSupportHours(at('17:59'), SUPPORT, TZ), true);
  assert.equal(isWithinSupportHours(at('18:00'), SUPPORT, TZ), false);
});

test('support window respects the configured weekdays', () => {
  const saturdayNoon = new Date('2026-11-21T15:00:00Z'); // Saturday 12:00 local
  assert.equal(isWithinSupportHours(saturdayNoon, SUPPORT, TZ), false);
  assert.equal(isWithinSupportHours(saturdayNoon, { ...SUPPORT, days: [6] }, TZ), true);
});

test('timezone day rollover: 02:30 UTC is 23:30 of the previous day in Bahia', () => {
  const instant = new Date('2026-11-18T02:30:00Z'); // Tuesday 23:30 local
  assert.equal(isWithinSupportHours(instant, { ...SUPPORT, days: [2] }, TZ), false);
  assert.equal(isWithinSupportHours(instant, { ...SUPPORT, days: [3] }, TZ), false);
  // Wednesday 08:30 local (11:30Z) is open on Wednesday only.
  assert.equal(isWithinSupportHours(new Date('2026-11-18T11:30:00Z'), { ...SUPPORT, days: [3] }, TZ), true);
});

test('nextSupportOpening returns the same instant when support is already open', () => {
  const open = at('10:00');
  const next = nextSupportOpening(open, SUPPORT, TZ);
  assert.ok(next instanceof Date);
  assert.equal(next.getTime(), open.getTime());
});

test('nextSupportOpening before opening hours returns 08:00 of the same day', () => {
  const next = nextSupportOpening(at('07:59'), SUPPORT, TZ);
  assert.equal(next.toISOString(), '2026-11-18T11:00:00.000Z');
});

test('nextSupportOpening after closing returns 08:00 of the next day', () => {
  const next = nextSupportOpening(at('18:00'), SUPPORT, TZ);
  assert.equal(next.toISOString(), '2026-11-19T11:00:00.000Z');
});

test('nextSupportOpening across the day rollover uses the local calendar day', () => {
  // 02:30Z Wednesday is Tuesday 23:30 local: next opening is Wednesday 08:00 local.
  const next = nextSupportOpening(new Date('2026-11-18T02:30:00Z'), SUPPORT, TZ);
  assert.equal(next.toISOString(), '2026-11-18T11:00:00.000Z');
});

test('nextSupportOpening skips weekends', () => {
  // Friday 2026-11-20 19:00 local is closed; the next weekday opening is Monday 2026-11-23.
  const next = nextSupportOpening(new Date('2026-11-20T22:00:00Z'), SUPPORT, TZ);
  assert.equal(next.toISOString(), '2026-11-23T11:00:00.000Z');
});
