import type { LayoutNode, SessionTarget } from '@shared/contracts';

export type PaneNode = Extract<LayoutNode, { type: 'pane' }>;
export type SplitDirection = 'row' | 'column';

/** Upper pane share in a stacked split and left share in a side-by-side split, as in the UI spec. */
export const DEFAULT_RATIO: Record<SplitDirection, number> = { column: 0.6, row: 0.5 };
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

export function pane(id: string, target: SessionTarget): PaneNode {
  return { type: 'pane', id, target };
}

export function collectPanes(node: LayoutNode): PaneNode[] {
  return node.type === 'pane' ? [node] : [...collectPanes(node.first), ...collectPanes(node.second)];
}

export function findPane(node: LayoutNode, id: string): PaneNode | null {
  return collectPanes(node).find((candidate) => candidate.id === id) ?? null;
}

/** Puts `added` beside pane `id`; the original stays first. Returns the same tree when the pane is unknown. */
export function splitPane(node: LayoutNode, id: string, direction: SplitDirection, added: PaneNode): LayoutNode {
  if (node.type === 'pane') {
    return node.id === id
      ? { type: 'split', direction, ratio: DEFAULT_RATIO[direction], first: node, second: added }
      : node;
  }
  const first = splitPane(node.first, id, direction, added);
  const second = first === node.first ? splitPane(node.second, id, direction, added) : node.second;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Removes a pane and collapses its parent split. Returns null when nothing remains. */
export function removePane(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'pane') return node.id === id ? null : node;
  const first = removePane(node.first, id);
  const second = removePane(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

/** Sets the ratio of the split at `path`, a list of `first`/`second` steps from the root. */
export function setRatioAt(node: LayoutNode, path: readonly ('first' | 'second')[], ratio: number): LayoutNode {
  if (node.type === 'pane') return node;
  const [step, ...rest] = path;
  if (!step) return { ...node, ratio: clampRatio(ratio) };
  return { ...node, [step]: setRatioAt(node[step], rest, ratio) };
}

export function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** A copy with new pane ids, for opening a saved layout next to tabs that may stem from the same one. */
export function withFreshIds(node: LayoutNode, ids: Map<string, string>): LayoutNode {
  if (node.type === 'split') {
    return { ...node, first: withFreshIds(node.first, ids), second: withFreshIds(node.second, ids) };
  }
  const id = crypto.randomUUID();
  ids.set(node.id, id);
  return { ...node, id };
}

/** The next pane in reading order, used to move focus after a close and for keyboard cycling. */
export function neighborPane(node: LayoutNode, id: string, offset: 1 | -1): PaneNode | null {
  const panes = collectPanes(node);
  const index = panes.findIndex((candidate) => candidate.id === id);
  if (index === -1 || panes.length === 0) return panes[0] ?? null;
  return panes[(index + offset + panes.length) % panes.length] ?? null;
}
