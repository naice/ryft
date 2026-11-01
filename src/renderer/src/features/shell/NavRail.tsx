import { useMemo, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Clock3,
  FolderTree,
  FolderOpen,
  Search,
  Settings,
  Star,
  SquareTerminal,
  Boxes
} from 'lucide-react';
import { groupCounts } from '../../lib/hostFilter';
import { useApp, type NavItem } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { cx, IconButton, Tooltip } from '../../components/ui/primitives';
import { HostsNavIcon, RyftGlyph, RyftWordmark } from '../../components/ui/icons';

const ITEMS: { id: NavItem; label: string; icon: ReactNode }[] = [
  { id: 'hosts', label: 'Hosts', icon: <HostsNavIcon /> },
  { id: 'recent', label: 'Recent', icon: <Clock3 size={18} /> },
  { id: 'starred', label: 'Starred', icon: <Star size={18} /> },
  { id: 'groups', label: 'Groups', icon: <Boxes size={18} /> }
];

function NavRow({
  label,
  icon,
  selected,
  disabled,
  compact,
  trailing,
  onClick,
  title
}: {
  label: string;
  icon: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  compact: boolean;
  trailing?: ReactNode;
  onClick?(): void;
  title?: string;
}) {
  const row = (
    <button
      type="button"
      disabled={disabled}
      aria-current={selected ? 'page' : undefined}
      aria-label={compact || title ? (title ?? label) : undefined}
      onClick={onClick}
      className={cx(
        'relative flex h-9 w-full flex-none items-center gap-2.5 rounded-control text-[13px] transition-colors duration-120',
        compact ? 'justify-center' : 'px-2.5',
        selected ? 'ryft-nav-selected text-text' : 'text-secondary',
        disabled ? 'opacity-45' : !selected && 'hover:bg-hover hover:text-text'
      )}
    >
      {selected && <span className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-cyan" />}
      <span className="flex-none">{icon}</span>
      {!compact && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!compact && trailing}
    </button>
  );
  return compact || title ? <Tooltip label={title ?? label}>{row}</Tooltip> : row;
}

export function NavRail({ compact }: { compact: boolean }) {
  const nav = useApp((state) => state.nav);
  const setNav = useApp((state) => state.setNav);
  const hosts = useApp((state) => state.hosts);
  const groups = useApp((state) => state.groups);
  const query = useApp((state) => state.query);
  const setQuery = useApp((state) => state.setQuery);
  const groupFilter = useApp((state) => state.groupFilter);
  const setGroupFilter = useApp((state) => state.setGroupFilter);
  const setPaletteOpen = useApp((state) => state.setPaletteOpen);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const isMac = useApp((state) => state.info?.platform === 'darwin');
  const counts = useMemo(() => groupCounts(hosts), [hosts]);

  const openLocal = () => {
    const { preferences } = useApp.getState();
    useWorkspace.getState().openTab({ kind: 'local', shellId: preferences?.defaultShellId ?? null });
  };

  return (
    <nav aria-label="Hauptnavigation" className="flex h-full min-h-0 flex-col rounded-panel border border-border bg-nav">
      <div className={cx('flex h-[50px] flex-none items-center gap-2', compact ? 'justify-center' : 'px-3')}>
        <RyftGlyph />
        {!compact && <RyftWordmark />}
      </div>

      {compact ? (
        <div className="flex justify-center pb-2">
          <IconButton label="Befehlspalette öffnen" shortcut="Ctrl+K" size={36} onClick={() => setPaletteOpen(true)}>
            <Search size={16} />
          </IconButton>
        </div>
      ) : (
        <div className="px-2.5 pb-3">
          <div className="flex h-8 items-center gap-2 rounded-control border border-border bg-canvas px-2 focus-within:border-border-active">
            <Search size={14} className="flex-none text-subtle" />
            <input
              aria-label="Hosts suchen"
              placeholder="Hosts suchen…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="ryft-bare-input min-w-0 flex-1 truncate bg-transparent text-xs text-text select-text placeholder:text-subtle"
            />
            <button
              type="button"
              aria-label="Befehlspalette öffnen"
              onClick={() => setPaletteOpen(true)}
              className="flex-none rounded-[4px] bg-raised px-1 text-[10px] leading-4 text-secondary hover:text-text"
            >
              {isMac ? '⌘K' : 'Ctrl K'}
            </button>
          </div>
        </div>
      )}

      <div className={cx('flex flex-col', compact ? 'px-2' : 'px-2.5')}>
        {ITEMS.map((item) => (
          <NavRow
            key={item.id}
            label={item.label}
            icon={item.icon}
            compact={compact}
            selected={nav === item.id && groupFilter === null}
            onClick={() => setNav(item.id)}
          />
        ))}
        <NavRow
          label="Port Forwarding"
          icon={<ArrowLeftRight size={18} />}
          compact={compact}
          disabled
          title="Port Forwarding – Coming Soon"
        />
        <NavRow label="SFTP" icon={<FolderOpen size={18} />} compact={compact} disabled title="SFTP – Coming Soon" />
        <NavRow label="Local Terminal" icon={<SquareTerminal size={18} />} compact={compact} onClick={openLocal} />
      </div>

      {!compact && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="px-3.5 pb-1 text-xs font-medium text-subtle">Gruppen</div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5">
            {groups.map((group) => (
              <NavRow
                key={group.id}
                label={group.name}
                icon={<FolderTree size={16} />}
                compact={false}
                selected={groupFilter === group.id}
                onClick={() => setGroupFilter(groupFilter === group.id ? null : group.id)}
                trailing={
                  <span className="min-w-5 flex-none rounded-full bg-raised px-1.5 text-center text-[11px] leading-[18px] text-secondary">
                    {counts.get(group.id) ?? 0}
                  </span>
                }
              />
            ))}
            {groups.length === 0 && <p className="px-1 text-[11px] text-subtle">Noch keine Gruppen</p>}
          </div>
        </div>
      )}
      {compact && <div className="flex-1" />}

      <div className={cx('flex flex-none items-center border-t border-border p-2', compact ? 'justify-center' : 'justify-end')}>
        <IconButton label="Einstellungen" size={32} onClick={() => setSettingsOpen(true)}>
          <Settings size={18} />
        </IconButton>
      </div>
    </nav>
  );
}
