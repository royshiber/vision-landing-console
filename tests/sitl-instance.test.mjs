import { afterEach, describe, expect, it } from 'vitest';
import { claimSitlInstance, sitlSidePorts } from './sitl-instance.mjs';

const held = [];

afterEach(() => {
  while (held.length) held.pop().release();
});

describe('SITL instance ports', () => {
  it('gives concurrent claims different instances and side ports', () => {
    const a = claimSitlInstance();
    const b = claimSitlInstance();
    const c = claimSitlInstance();
    held.push(a, b, c);
    expect(new Set([a.instance, b.instance, c.instance]).size).toBe(3);
    const ports = [a, b, c].flatMap((slot) => sitlSidePorts(slot.instance));
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).not.toContain(5762);
    expect(ports).not.toContain(5501);
    expect(ports).not.toContain(9002);
    expect(sitlSidePorts(a.instance)[0]).toBe(5762 + 10 * a.instance);
  });
});
