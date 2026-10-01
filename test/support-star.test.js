'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { STICKER_PHRASES, FIT_RADIUS, MAX_SIZE, LINE_HEIGHT, INK_HALF, SPIN, pickPhrase, layoutPhrase, idle, sample, press, release, freeze } = require('../renderer/support-star');
// Georgia Bold averages roughly 0.62em per character; wide enough to exercise wrapping like the real font.
const measure = text => text.length * 0.62;

test('the phrase list is non-empty, unique and short enough for a sticker', () => {
  assert.ok(STICKER_PHRASES.length >= 2);
  assert.equal(new Set(STICKER_PHRASES).size, STICKER_PHRASES.length);
  for (const phrase of STICKER_PHRASES) assert.ok(phrase.trim() === phrase && phrase.length <= 24, phrase);
  assert.ok(STICKER_PHRASES.includes('¡Huevos Rancheros!') && STICKER_PHRASES.includes('Baguettes and bagels'));
});

test('picking never repeats the current phrase and can reach every other phrase', () => {
  const seen = new Set();
  let previous = STICKER_PHRASES[0];
  for (let index = 0; index < 2000; index++) {
    const next = pickPhrase(STICKER_PHRASES, previous);
    assert.notEqual(next, previous);
    assert.ok(STICKER_PHRASES.includes(next));
    seen.add(next); previous = next;
  }
  assert.equal(seen.size, STICKER_PHRASES.length);
  for (const random of [() => 0, () => 0.5, () => 0.999999, () => 1]) assert.notEqual(pickPhrase(['a', 'b', 'c'], 'a', random), 'a');
  assert.equal(pickPhrase(['only'], 'only'), 'only');
  assert.ok(STICKER_PHRASES.includes(pickPhrase()));
});

test('every phrase wraps and shrinks so each line stays inside the star', () => {
  for (const phrase of STICKER_PHRASES) {
    const { lines, size } = layoutPhrase(phrase, measure);
    assert.equal(lines.join(' '), phrase.split(/\s+/).join(' '), 'wrapping keeps every word in order');
    assert.ok(size > 0.08 && size <= MAX_SIZE, `${phrase}: ${size}`);
    const middle = (lines.length - 1) / 2;
    lines.forEach((line, index) => {
      const corner = Math.hypot(measure(line) * size / 2, (Math.abs(index - middle) * LINE_HEIGHT + INK_HALF) * size);
      assert.ok(corner <= FIT_RADIUS + 1e-9, `${phrase} / ${line}: ${corner}`);
    });
  }
});

test('layout prefers one line, then the largest text, then the fewest lines', () => {
  assert.deepEqual(layoutPhrase('Hi!', measure).lines, ['Hi!']);
  assert.equal(layoutPhrase('Hi!', measure).size, MAX_SIZE);
  assert.deepEqual(layoutPhrase('Baguettes and bagels', measure).lines, ['Baguettes', 'and', 'bagels']);
  assert.deepEqual(layoutPhrase('¡Huevos Rancheros!', measure).lines, ['¡Huevos', 'Rancheros!']);
  assert.ok(layoutPhrase('Roadtrip!', measure).size < MAX_SIZE, 'a long single word shrinks rather than overflowing');
  assert.ok(layoutPhrase('Supercalifragilistic', measure).size < layoutPhrase('Roadtrip!', measure).size);
});

// Samples a motion timeline every `step` ms and checks the angle never jumps or runs backwards.
function trace(segments, until, step = 1) {
  const points = [];
  let index = 0;
  for (let time = 0; time <= until; time += step) {
    while (index + 1 < segments.length && segments[index + 1].t0 <= time) index++;
    points.push({ time, ...sample(segments[index], time) });
  }
  return points;
}
function assertContinuous(points, step = 1) {
  for (let index = 1; index < points.length; index++) {
    const turned = (points[index].angle - points[index - 1].angle + 360) % 360;
    const velocity = (points[index].velocity + points[index - 1].velocity) / 2;
    assert.ok(turned >= 0 && Math.abs(turned - velocity * step / 1000) < 0.05, `angle step ${turned} at ${points[index].time}ms`);
    assert.ok(Math.abs(points[index].velocity - points[index - 1].velocity) < 12, `velocity jump at ${points[index].time}ms`);
  }
}

test('idle spin completes one revolution every nine seconds', () => {
  const spin = idle(1000, 30);
  assert.equal(sample(spin, 1000).angle, 30);
  assert.ok(Math.abs(sample(spin, 5500).angle - 210) < 1e-9);
  assert.ok(Math.abs(sample(spin, 10000).angle - 30) < 1e-9);
  assert.equal(SPIN.base, 40);
});

test('press brakes smoothly to a standstill from the current angle and never snaps back', () => {
  const spin = idle(0, 100);
  const held = press(spin, 250);
  assert.ok(Math.abs(held.a0 - 110) < 1e-9);
  assert.equal(held.v0, SPIN.base);
  assert.ok(sample(held, 450).velocity < 1, 'imperceptibly slow (under 1 degree per second) within 0.2s');
  assert.ok(sample(held, 5000).angle > 110 && sample(held, 5000).angle < 112, 'coasts about 2 degrees at most');
  assertContinuous(trace([spin, held], 3000));
});

test('release bursts to a high speed and eases back to the idle speed in about one second', () => {
  const held = press(idle(0), 100);
  const burst = release(held, 900);
  const points = trace([idle(0), held, burst], 3500);
  assertContinuous(points);
  const peak = Math.max(...points.map(point => point.velocity));
  assert.equal(peak, SPIN.peak);
  assert.ok(peak >= SPIN.base * 10, 'the burst is dramatically faster than idle');
  assert.ok(peak / 60 < 22.5 / 2, 'peak stays below the 60 Hz strobe limit for a 16-point star');
  const at = time => points.find(point => point.time === time).velocity;
  assert.ok(at(900 + SPIN.rise) === SPIN.peak, 'reaches the peak quickly');
  assert.ok(at(900 + SPIN.duration) === SPIN.base && at(1400) > SPIN.base, 'back to idle speed after one second');
  assert.ok(SPIN.duration >= 800 && SPIN.duration <= 1200);
});

test('rapid, repeated and cancelled interactions stay continuous from whatever state they interrupt', () => {
  const segments = [idle(0)];
  const add = (make, time) => segments.push(make(segments.at(-1), time));
  add(press, 100); add(release, 160); add(press, 260); add(release, 300); add(release, 420); add(press, 700);
  add((segment, time) => release(segment, time, false), 1200);
  // Turning on reduced motion stops the star where it is (no motion is the point); switching it off eases back up.
  add(freeze, 2000); add((segment, time) => release(segment, time, false), 2600);
  const points = trace(segments, 4000);
  assertContinuous(points.filter(point => point.time < 2000));
  assertContinuous(points.filter(point => point.time >= 2000));
  const before = points.find(point => point.time === 1999), frozen = points.find(point => point.time === 2000);
  assert.ok(Math.abs(frozen.angle - before.angle - before.velocity / 1000) < 1e-3, 'freezing keeps the current angle');
  assert.equal(points.find(point => point.time === 2300).velocity, 0, 'frozen for reduced motion');
  assert.equal(points.at(-1).velocity, SPIN.base, 'eases back up to idle after a cancelled press or reduced motion ends');
  assert.ok(Math.max(...points.map(point => point.velocity)) <= SPIN.peak);
});

test('time before a segment starts is clamped so frame timestamps cannot move the star backwards', () => {
  const burst = release(idle(0, 45), 500);
  assert.equal(sample(burst, 480).angle, sample(burst, 500).angle);
});
