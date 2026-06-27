import { generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('returns an 11-char URL-safe string', () => {
    const id = generatePublicId();
    expect(id).toHaveLength(11);
    expect(id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('produces no collisions across a large sample', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(10000);
  });
});
