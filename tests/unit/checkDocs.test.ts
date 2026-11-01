import { describe, expect, it } from 'vitest';
// @ts-expect-error Plain Node script without type declarations.
import { findReadmeProblems, findStaleDocs } from '../../scripts/check-docs.mjs';

const SHOT = 'docs/screenshots/a.png';

describe('findStaleDocs', () => {
  it('ignores pushes without user-facing changes', () => {
    expect(findStaleDocs([{ files: ['tests/unit/a.test.ts', '.github/workflows/ci.yml'] }])).toEqual([]);
    expect(findStaleDocs([])).toEqual([]);
  });

  it('reports both when only the app changed', () => {
    expect(findStaleDocs([{ files: ['src/main/index.ts'] }])).toEqual(['readme', 'screenshots']);
  });

  it('accepts docs in the same commit or a newer one', () => {
    expect(findStaleDocs([{ files: ['src/main/index.ts', 'README.md', SHOT] }])).toEqual([]);
    expect(findStaleDocs([{ files: ['README.md', SHOT] }, { files: ['src/main/index.ts'] }])).toEqual([]);
  });

  it('rejects docs that are older than the newest app change', () => {
    expect(findStaleDocs([{ files: ['src/main/index.ts'] }, { files: ['README.md', SHOT] }])).toEqual([
      'readme',
      'screenshots'
    ]);
  });

  it('reports only what is missing', () => {
    expect(findStaleDocs([{ files: ['package.json', 'README.md'] }])).toEqual(['screenshots']);
    expect(findStaleDocs([{ files: ['resources/icon.png', SHOT] }])).toEqual(['readme']);
  });
});

describe('findReadmeProblems', () => {
  it('accepts existing screenshots and ignores remote badges', () => {
    const readme = `![Badge](https://img.shields.io/x.svg)\n![Bild](${SHOT})`;
    expect(findReadmeProblems(readme, [SHOT])).toEqual([]);
  });

  it('checks html image tags too', () => {
    expect(findReadmeProblems(`<img src="${SHOT}" />`, [SHOT])).toEqual([]);
    expect(findReadmeProblems('<img src="docs/screenshots/gone.png" />', [SHOT])[0]).toContain('gone.png');
  });

  it('requires at least one screenshot', () => {
    expect(findReadmeProblems('# Nur Text', [SHOT])).toEqual(['README zeigt keinen Screenshot.']);
  });
});
