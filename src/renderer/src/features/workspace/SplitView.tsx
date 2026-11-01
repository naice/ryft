import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { LayoutNode } from '@shared/contracts';
import { clampRatio, findPane } from '../../lib/layoutTree';
import { useWorkspace } from '../../state/workspaceStore';
import { TerminalPane } from './TerminalPane';

const KEY_STEP = 0.02;
const GUTTER_PX = 6;

function SplitNode({
  node,
  tabId,
  path
}: {
  node: LayoutNode;
  tabId: string;
  path: readonly ('first' | 'second')[];
}) {
  const setRatio = useWorkspace((state) => state.setRatio);
  const commitLayout = useWorkspace((state) => state.commitLayout);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  if (node.type === 'pane') {
    return <TerminalPane id={node.id} target={node.target} tabId={tabId} />;
  }

  const isRow = node.direction === 'row';

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const ratio = isRow ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    setRatio(tabId, path, ratio);
  };
  const onPointerUp = () => {
    if (!dragging) return;
    setDragging(false);
    commitLayout();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decrease = isRow ? 'ArrowLeft' : 'ArrowUp';
    const increase = isRow ? 'ArrowRight' : 'ArrowDown';
    if (event.key !== decrease && event.key !== increase) return;
    event.preventDefault();
    setRatio(tabId, path, clampRatio(node.ratio + (event.key === increase ? KEY_STEP : -KEY_STEP)));
    commitLayout();
  };

  const share = (ratio: number) => `calc(${ratio * 100}% - ${GUTTER_PX / 2}px)`;

  return (
    <div ref={containerRef} className={`flex h-full min-h-0 w-full min-w-0 ${isRow ? 'flex-row' : 'flex-col'}`}>
      <div className="min-h-0 min-w-0 flex-none" style={isRow ? { width: share(node.ratio) } : { height: share(node.ratio) }}>
        <SplitNode node={node.first} tabId={tabId} path={[...path, 'first']} />
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={isRow ? 'vertical' : 'horizontal'}
        aria-label="Bereichsgröße ändern"
        aria-valuenow={Math.round(node.ratio * 100)}
        data-dragging={dragging}
        className={`ryft-gutter ${isRow ? 'ryft-gutter-row' : 'ryft-gutter-column'}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <SplitNode node={node.second} tabId={tabId} path={[...path, 'second']} />
      </div>
    </div>
  );
}

/** A maximized pane replaces the layout visually, while its siblings keep running. */
export function SplitView({ root, tabId }: { root: LayoutNode; tabId: string }) {
  const maximizedId = useWorkspace((state) => state.maximizedPaneId);
  const maximized = maximizedId ? findPane(root, maximizedId) : null;
  if (maximized) {
    return <TerminalPane id={maximized.id} target={maximized.target} tabId={tabId} />;
  }
  return <SplitNode node={root} tabId={tabId} path={[]} />;
}
