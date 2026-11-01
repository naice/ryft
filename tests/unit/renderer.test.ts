import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Group, Host, LayoutNode } from '@shared/contracts';
import { clipboardActionFor } from '@renderer/features/terminal/clipboardKeys';
import { resolveShortcut, type KeyLike } from '@renderer/features/shell/shortcutMap';
import { buildSections, filterHosts, groupCounts, matchesQuery } from '@renderer/lib/hostFilter';
import {
  clampRatio,
  collectPanes,
  DEFAULT_RATIO,
  MAX_RATIO,
  MIN_RATIO,
  neighborPane,
  pane,
  removePane,
  setRatioAt,
  splitPane
} from '@renderer/lib/layoutTree';

const local = { kind: 'local', shellId: null } as const;
const ids = (node: LayoutNode | null) => (node ? collectPanes(node).map((item) => item.id) : []);

describe('layoutTree', () => {
  it('reproduces the split of the reference with the default proportions', () => {
    const top = pane('top', local);
    let root: LayoutNode = splitPane(top, 'top', 'column', pane('left', local));
    root = splitPane(root, 'left', 'row', pane('right', local));
    expect(ids(root)).toEqual(['top', 'left', 'right']);
    expect(root).toMatchObject({ type: 'split', direction: 'column', ratio: DEFAULT_RATIO.column });
    expect(root.type === 'split' && root.second).toMatchObject({ direction: 'row', ratio: DEFAULT_RATIO.row });
  });

  it('leaves the tree untouched when splitting an unknown pane', () => {
    const root = pane('a', local);
    expect(splitPane(root, 'nope', 'row', pane('b', local))).toBe(root);
  });

  it('collapses the parent split when a pane is removed', () => {
    const root = splitPane(splitPane(pane('a', local), 'a', 'row', pane('b', local)), 'b', 'column', pane('c', local));
    expect(ids(removePane(root, 'b'))).toEqual(['a', 'c']);
    expect(removePane(pane('a', local), 'a')).toBeNull();
    expect(removePane(root, 'nope')).toBe(root);
  });

  it('clamps ratios and only changes the addressed split', () => {
    expect(clampRatio(0)).toBe(MIN_RATIO);
    expect(clampRatio(2)).toBe(MAX_RATIO);
    const root = splitPane(splitPane(pane('a', local), 'a', 'row', pane('b', local)), 'b', 'column', pane('c', local));
    const next = setRatioAt(root, ['second'], 0.25);
    expect(next).toMatchObject({ ratio: DEFAULT_RATIO.row, second: { ratio: 0.25 } });
    expect(setRatioAt(root, [], 5)).toMatchObject({ ratio: MAX_RATIO });
  });

  it('wraps around when moving between panes', () => {
    const root = splitPane(pane('a', local), 'a', 'row', pane('b', local));
    expect(neighborPane(root, 'b', 1)?.id).toBe('a');
    expect(neighborPane(root, 'a', -1)?.id).toBe('b');
    expect(neighborPane(root, 'gone', 1)?.id).toBe('a');
  });
});

function host(overrides: Partial<Host>): Host {
  return {
    id: 'h',
    name: 'name',
    hostname: '192.0.2.1',
    port: 22,
    username: 'demo',
    authMethod: 'agent',
    keyReference: null,
    groupId: null,
    tags: [],
    favorite: false,
    hasStoredSecret: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Host;
}

describe('hostFilter', () => {
  const groups = [{ id: 'g1', name: 'Production' }, { id: 'g2', name: 'Leer' }] as Group[];
  const hosts = [
    host({ id: '1', name: 'prod-web', groupId: 'g1', favorite: true, tags: ['nginx'] }),
    host({ id: '2', name: 'prod-db', groupId: 'g1', hostname: '192.0.2.99' }),
    host({ id: '3', name: 'lonely' })
  ];
  const none = { query: '', segment: 'all', groupId: null } as const;

  it('matches every term across name, address, user and tags', () => {
    expect(matchesQuery(hosts[0]!, 'PROD nginx')).toBe(true);
    expect(matchesQuery(hosts[1]!, '.99')).toBe(true);
    expect(matchesQuery(hosts[0]!, 'prod missing')).toBe(false);
    expect(matchesQuery(hosts[0]!, '   ')).toBe(true);
  });

  it('applies the segments', () => {
    expect(filterHosts(hosts, { ...none, segment: 'favorites' }).map((item) => item.id)).toEqual(['1']);
    expect(filterHosts(hosts, { ...none, segment: 'groups' }).map((item) => item.id)).toEqual(['1', '2']);
  });

  it('keeps empty groups unless a filter is active, and lists ungrouped hosts last', () => {
    expect(buildSections(hosts, groups, none).map((section) => section.group?.name ?? null)).toEqual([
      'Production',
      'Leer',
      null
    ]);
    expect(buildSections(hosts, groups, { ...none, query: 'web' }).map((section) => section.group?.name)).toEqual([
      'Production'
    ]);
  });

  it('lists favourites first within a section and otherwise keeps the order', () => {
    const named = [
      host({ id: 'a', groupId: 'g1' }),
      host({ id: 'b', groupId: 'g1' }),
      host({ id: 'c', groupId: 'g1', favorite: true })
    ];
    expect(buildSections(named, groups, none)[0]!.hosts.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(named.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('counts hosts per group', () => {
    expect(groupCounts(hosts).get('g1')).toBe(2);
    expect(groupCounts(hosts).has('g2')).toBe(false);
  });
});

const keys = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods
});

describe('resolveShortcut', () => {
  it('leaves plain Ctrl keys to the shell when capturing is off, but never the Shift variants', () => {
    expect(resolveShortcut(keys('w', { ctrlKey: true }), false, false)).toBeNull();
    expect(resolveShortcut(keys('W', { ctrlKey: true, shiftKey: true }), false, false)).toBe('closeTab');
    expect(resolveShortcut(keys('k', { ctrlKey: true }), false, true)).toBe('palette');
  });

  it('uses Cmd on macOS and leaves Ctrl alone there', () => {
    expect(resolveShortcut(keys('k', { metaKey: true }), true, false)).toBe('palette');
    expect(resolveShortcut(keys('k', { ctrlKey: true }), true, true)).toBeNull();
  });

  it('maps splits, tabs and pane focus', () => {
    expect(resolveShortcut(keys('D', { ctrlKey: true, shiftKey: true }), false, true)).toBe('splitRight');
    expect(resolveShortcut(keys('E', { ctrlKey: true, shiftKey: true }), false, true)).toBe('splitDown');
    expect(resolveShortcut(keys('Tab', { ctrlKey: true }), false, true)).toBe('nextTab');
    expect(resolveShortcut(keys('Tab', { ctrlKey: true, shiftKey: true }), false, true)).toBe('previousTab');
    expect(resolveShortcut(keys('ArrowLeft', { ctrlKey: true, altKey: true }), false, true)).toBe('previousPane');
    expect(resolveShortcut(keys('ArrowDown', { ctrlKey: true, altKey: true }), false, true)).toBe('nextPane');
  });

  it('ignores what it does not know', () => {
    expect(resolveShortcut(keys('a'), false, true)).toBeNull();
    expect(resolveShortcut(keys('k', { altKey: true }), false, true)).toBeNull();
    expect(resolveShortcut(keys('q', { ctrlKey: true, altKey: true }), false, true)).toBeNull();
  });
});

describe('clipboardActionFor', () => {
  const ctrl = (key: string, shiftKey = false) => keys(key, { ctrlKey: true, shiftKey });

  it('on Windows, plain Ctrl+C copies only with a selection and stays SIGINT otherwise', () => {
    expect(clipboardActionFor(ctrl('c'), 'win32', true)).toBe('copy');
    expect(clipboardActionFor(ctrl('c'), 'win32', false)).toBeNull();
    expect(clipboardActionFor(ctrl('v'), 'win32', false)).toBe('paste');
  });

  it('on Linux, plain Ctrl+C and Ctrl+V stay with the shell', () => {
    expect(clipboardActionFor(ctrl('c'), 'linux', true)).toBeNull();
    expect(clipboardActionFor(ctrl('v'), 'linux', false)).toBeNull();
    expect(clipboardActionFor(ctrl('C', true), 'linux', false)).toBe('copy');
    expect(clipboardActionFor(ctrl('V', true), 'linux', false)).toBe('paste');
  });

  it('on macOS only Cmd counts', () => {
    expect(clipboardActionFor(keys('c', { metaKey: true }), 'darwin', false)).toBe('copy');
    expect(clipboardActionFor(keys('v', { metaKey: true }), 'darwin', false)).toBe('paste');
    expect(clipboardActionFor(ctrl('c'), 'darwin', true)).toBeNull();
  });

  it('ignores other keys and AltGr combinations', () => {
    expect(clipboardActionFor(ctrl('x'), 'win32', true)).toBeNull();
    expect(clipboardActionFor(keys('v', { ctrlKey: true, altKey: true }), 'win32', false)).toBeNull();
  });
});

describe('design token discipline', () => {
  it('keeps literal colours out of components', () => {
    const root = resolve(__dirname, '../../src/renderer/src');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g), file).toBeNull();
    }
  });
});
