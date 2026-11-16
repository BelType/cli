// The answer's Server-Timing read back, for the server's tests: its metrics in order, and the check that no part is larger than its whole.

import assert from 'node:assert/strict';

/** A `Server-Timing` header as its metrics, in order. */
export function timing(header: string | null): { name: string; dur?: number; desc?: string }[] {
  assert.ok(header, 'the answer carries Server-Timing');
  return header.split(',').map((m) => {
    const [name, ...params] = m.trim().split(';');
    assert.match(name!, /^[\w!#$%&'*+.^`|~-]+$/, `a token: ${name}`);
    const entry: { name: string; dur?: number; desc?: string } = { name: name! };
    for (const p of params) {
      const [k, v] = p.split('=');
      if (k === 'dur') { entry.dur = Number(v); assert.ok(Number.isFinite(entry.dur) && entry.dur >= 0, m); } else if (k === 'desc') entry.desc = JSON.parse(v!);
    }
    return entry;
  });
}

/** The parts no larger than the whole: each step within `total`, the steps together too, and the print's parts within `print`, summing to it. */
export function wholeHoldsParts(metrics: ReturnType<typeof timing>): void {
  const dur = new Map(metrics.filter((m) => m.dur !== undefined).map((m) => [m.name, m.dur!]));
  assert.equal(dur.size, metrics.filter((m) => m.dur !== undefined).length, 'each name once');
  const total = dur.get('total')!;
  const steps = [...dur].filter(([n]) => n !== 'total' && !/^(print|caster)-/.test(n));
  for (const [n, d] of steps) assert.ok(d <= total, `${n} ${d} within total ${total}`);
  assert.ok(steps.reduce((t, [, d]) => t + d, 0) <= total + 0.5, 'the steps within total');
  const parts = [...dur].filter(([n]) => /^(print|caster)-/.test(n));
  const print = dur.get('print')!;
  for (const [n, d] of parts) assert.ok(d <= print, `${n} ${d} within print ${print}`);
  assert.ok(Math.abs(parts.reduce((t, [, d]) => t + d, 0) - print) <= 0.1 * parts.length + 0.5, `the parts sum to print: ${[...parts].join(' ')} against ${print}`);
  assert.ok(parts.some(([n]) => n === 'caster-emit') && parts.some(([n]) => n === 'print-cross'), 'Caster\'s stages and the crossing are named');
}
