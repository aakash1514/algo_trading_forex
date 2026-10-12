/** @jest-environment node */
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import manifest from './__fixtures__/manifest.json';

// The recorded /ask responses are the committed bytes the recorder saved (README.md, manifest.json).
describe('research page fixtures', () => {
  const entries = Object.values(manifest as Record<string, { file: string; sha256: string; status: number; type: string | null }>);

  it('match the sha256 the recorder wrote', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const bytes = readFileSync(join(__dirname, '__fixtures__', e.file));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(e.sha256);
    }
  });

  it('cover every report type the page renders and the 422 cap', () => {
    const types = new Set(entries.filter((e) => e.status === 200).map((e) => e.type));
    expect([...types].sort()).toEqual(['answer', 'could_not_verify', 'not_in_data', 'refusal']);
    expect(entries.some((e) => e.status === 422)).toBe(true);
  });
});
