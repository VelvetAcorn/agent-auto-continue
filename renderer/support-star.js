(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SupportStar = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // The Settings support sticker shows one of these. Edit freely: layout and tests adapt to any short phrase.
  const STICKER_PHRASES = Object.freeze([
    'Please support!', 'I love coffee!', 'Cafes are my fave', 'Baguettes and bagels', 'New shoes!', '¡Huevos Rancheros!', 'Cat treats!',
    'Cat costumes!', 'More cats!', 'Books books books', 'House plants!', 'Roadtrip!', 'Bath Buns!', 'Guitars!'
  ]);
  // Geometry is in fractions of the sticker's width. The star's valleys sit at 39.5/106 of the width and the
  // outline's inner edge at 38.25/106 (0.361), so text inside FIT_RADIUS stays clear of the rotating points.
  // Sizes are in ems: lines sit LINE_HEIGHT apart (matching the CSS) and Georgia's capitals and ascenders
  // reach about INK_HALF above and below each line's centre.
  const FIT_RADIUS = 0.335, MAX_SIZE = 0.15, LINE_HEIGHT = 0.92, INK_HALF = 0.38, MAX_LINES = 4;
  // Degrees per second and milliseconds. BASE is the idle 9-second revolution. PEAK stays under ~8° per 60 Hz
  // frame: the 16-point star repeats every 22.5°, so faster rotation would strobe or appear to run backwards.
  const SPIN = Object.freeze({ base: 40, peak: 480, rise: 140, duration: 1000, brake: 45, resume: 320 });

  function pickPhrase(phrases = STICKER_PHRASES, previous, random = Math.random) {
    const others = phrases.filter(phrase => phrase !== previous);
    const pool = others.length ? others : phrases;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  }

  function splits(words, limit) {
    if (words.length <= 1 || limit <= 1) return [[words.join(' ')]];
    const results = [[words.join(' ')]];
    for (let index = 1; index < words.length; index++) {
      for (const rest of splits(words.slice(index), limit - 1)) results.push([words.slice(0, index).join(' '), ...rest]);
    }
    return results;
  }
  // measure(text) returns the text's advance width in ems. Each line's outer ink corners must lie inside the
  // circle, so wrapping and size are chosen together: the largest size wins, then fewer lines, then the most room.
  function layoutPhrase(phrase, measure, { radius = FIT_RADIUS, maxSize = MAX_SIZE, lineHeight = LINE_HEIGHT, inkHalf = INK_HALF, maxLines = MAX_LINES } = {}) {
    const words = String(phrase).trim().split(/\s+/).filter(Boolean);
    let best;
    for (const lines of splits(words, maxLines)) {
      const middle = (lines.length - 1) / 2;
      const room = Math.min(...lines.map((line, index) => radius / Math.hypot(measure(line) / 2, Math.abs(index - middle) * lineHeight + inkHalf)));
      const size = Math.min(maxSize, room), tie = best && Math.abs(size - best.size) < 1e-9;
      if (!best || size > best.size + 1e-9 || tie && (lines.length < best.lines.length || lines.length === best.lines.length && room > best.room)) best = { lines, size, room };
    }
    return { lines: best.lines, size: best.size };
    return best;
  }

  // The sticker's motion is a sequence of analytic segments, each starting from the exact angle and velocity of
  // the one it replaces. Angle is therefore continuous and velocity never jumps, regardless of frame timing.
  const idle = (time, angle = 0) => ({ kind: 'idle', t0: time, a0: angle % 360, v0: SPIN.base });
  function sample(segment, time) {
    const elapsed = Math.max(0, time - segment.t0) / 1000;
    const { a0, v0 } = segment;
    if (segment.kind === 'still') return { angle: a0, velocity: 0 };
    if (segment.kind === 'hold') {
      const tau = SPIN.brake / 1000, decay = Math.exp(-elapsed / tau);
      return { angle: (a0 + v0 * tau * (1 - decay)) % 360, velocity: v0 * decay };
    }
    if (segment.kind === 'ramp') {
      const { peak, rise, duration } = segment, riseSeconds = rise / 1000, fallSeconds = (duration - rise) / 1000;
      if (elapsed < riseSeconds) {
        // Ease out from the current velocity to the peak: a quick kick that arrives at the peak with no acceleration.
        const u = elapsed / riseSeconds;
        return { angle: (a0 + riseSeconds * (v0 * u + (peak - v0) * (u * u - u * u * u / 3))) % 360, velocity: v0 + (peak - v0) * (2 * u - u * u) };
      }
      const risen = riseSeconds * (v0 + (peak - v0) * 2 / 3);
      if (elapsed < riseSeconds + fallSeconds) {
        // (1-w)³(1+3w) glides from the peak back to BASE with zero acceleration at both ends.
        const w = (elapsed - riseSeconds) / fallSeconds, s = 1 - w;
        return { angle: (a0 + risen + fallSeconds * (SPIN.base * w + (peak - SPIN.base) * (0.4 - s ** 4 + 0.6 * s ** 5))) % 360, velocity: SPIN.base + (peak - SPIN.base) * s ** 3 * (1 + 3 * w) };
      }
      return { angle: (a0 + risen + fallSeconds * (SPIN.base + (peak - SPIN.base) * 0.4) + SPIN.base * (elapsed - riseSeconds - fallSeconds)) % 360, velocity: SPIN.base };
    }
    return { angle: (a0 + v0 * elapsed) % 360, velocity: v0 };
  }
  const from = (segment, time, kind, extra) => { const { angle, velocity } = sample(segment, time); return { kind, t0: time, a0: angle, v0: velocity, ...extra }; };
  // Pressing brakes to a standstill in ~0.15 s without snapping; the star stays still for as long as it is held.
  const press = (segment, time) => from(segment, time, 'hold');
  // Releasing bursts to PEAK and eases back to BASE over ~1 s. A cancelled press just eases back up to BASE.
  const release = (segment, time, burst = true) => from(segment, time, 'ramp', burst ? { peak: SPIN.peak, rise: SPIN.rise, duration: SPIN.duration } : { peak: SPIN.base, rise: SPIN.resume, duration: SPIN.resume });
  const freeze = (segment, time) => from(segment, time, 'still');

  return { STICKER_PHRASES, FIT_RADIUS, MAX_SIZE, LINE_HEIGHT, INK_HALF, SPIN, pickPhrase, layoutPhrase, idle, sample, press, release, freeze };
});
