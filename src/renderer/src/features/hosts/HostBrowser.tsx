import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Clock3, MoreVertical, Plus, Search, Server, Star } from 'lucide-react';
import { ContextMenu, DropdownMenu } from 'radix-ui';
import type { Group, HistoryEntry, Host } from '@shared/contracts';
import { isSessionActive } from '@shared/sessionState';
import { buildSections, type HostSegment } from '../../lib/hostFilter';
import { collectPanes } from '../../lib/layoutTree';
import { attempt, useApp } from '../../state/appStore';
import { useWorkspace } from '../../state/workspaceStore';
import { isFinishedJob, useSftp } from '../sftp/sftpStore';
import { Button, cx, EmptyState, IconButton, Input, Modal } from '../../components/ui/primitives';
import { ServerStackIcon } from '../../components/ui/icons';

const MENU_ITEM =
  'flex h-[30px] cursor-default items-center rounded-[4px] px-2.5 text-[13px] text-text outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40';
const MENU_SURFACE = 'z-[55] min-w-44 rounded-card border border-border bg-raised p-1 shadow-float';

const SEGMENTS: { id: HostSegment; label: string }[] = [
  { id: 'all', label: 'Alle' },
  { id: 'favorites', label: 'Favoriten' },
  { id: 'groups', label: 'Gruppen' }
];

function useHostActions(host: Host) {
  const connectHost = useWorkspace((state) => state.connectHost);
  const openTab = useWorkspace((state) => state.openTab);
  const openEditor = useApp((state) => state.openEditor);
  const duplicateHost = useApp((state) => state.duplicateHost);
  const deleteHost = useApp((state) => state.deleteHost);
  const askConfirm = useApp((state) => state.askConfirm);
  return {
    connect: () => connectHost(host.id),
    openInNewTab: () => openTab({ kind: 'ssh', hostId: host.id }),
    openSftp: () => {
      const { setNav, toast } = useApp.getState();
      const sftp = useSftp.getState();
      setNav('sftp');
      if (Object.values(sftp.jobs).some((job) => !isFinishedJob(job))) {
        // Switching would break the running transfers, and that decision needs its own confirmation.
        toast('info', 'Es laufen noch Übertragungen. Trenne die Verbindung, um den Host zu wechseln.');
      } else {
        void sftp.connect(host.id);
      }
    },
    edit: () => openEditor(host),
    duplicate: () => void attempt(() => duplicateHost(host.id)),
    remove: () =>
      askConfirm({
        title: `„${host.name}“ löschen?`,
        message:
          'Der Host, seine gespeicherten Zugangsdaten und seine Port-Weiterleitungen werden entfernt. Laufende Weiterleitungen werden gestoppt, bestehende Terminal-Sitzungen bleiben bestehen.',
        confirmLabel: 'Löschen',
        danger: true,
        onConfirm: () => void attempt(() => deleteHost(host.id))
      })
  };
}

function HostRow({ host, selected }: { host: Host; selected: boolean }) {
  const selectHost = useApp((state) => state.selectHost);
  const toggleFavorite = useApp((state) => state.toggleFavorite);
  const actions = useHostActions(host);
  const running = useWorkspace((state) =>
    state.tabs.some((tab) =>
      collectPanes(tab.root).some(
        (item) =>
          item.target.kind === 'ssh' &&
          item.target.hostId === host.id &&
          isSessionActive(state.panes[item.id]?.state ?? 'disconnected')
      )
    )
  );

  return (
    <ContextMenu.Root onOpenChange={(open) => open && selectHost(host.id)}>
      <ContextMenu.Trigger asChild>
        <div
          role="listitem"
          data-testid="host-row"
          className={cx(
            'group relative flex h-[54px] flex-none items-center gap-2.5 rounded-card border pr-1.5 pl-2.5 transition-colors duration-120',
            selected ? 'border-border bg-raised' : 'border-transparent hover:bg-hover'
          )}
        >
          {selected && <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-cyan" />}
          <button
            type="button"
            aria-label={`${host.name} auswählen, Doppelklick verbindet`}
            aria-pressed={selected}
            onClick={() => selectHost(host.id)}
            onDoubleClick={actions.connect}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                actions.connect();
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left outline-offset-2"
          >
            <span className="relative flex-none">
              <ServerStackIcon size={24} />
              {running && (
                <span
                  title="Sitzung aktiv"
                  className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full border border-host-panel bg-success"
                />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] leading-[17px] font-semibold text-text">{host.name}</span>
              <span className="truncate text-[11px] leading-[15px] text-secondary">{host.hostname}</span>
            </span>
          </button>
          <IconButton
            label={host.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
            aria-pressed={host.favorite}
            onClick={() => void attempt(() => toggleFavorite(host))}
            className={cx(!host.favorite && 'opacity-40 group-focus-within:opacity-100 group-hover:opacity-100')}
          >
            <Star
              size={16}
              className={host.favorite ? 'text-warning' : ''}
              fill={host.favorite ? 'currentColor' : 'none'}
            />
          </IconButton>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={MENU_SURFACE}>
          <ContextMenu.Item className={MENU_ITEM} onSelect={actions.connect}>Verbinden</ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={actions.openInNewTab}>In neuem Tab öffnen</ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={actions.openSftp}>SFTP öffnen</ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={MENU_ITEM} onSelect={actions.edit}>Bearbeiten</ContextMenu.Item>
          <ContextMenu.Item className={MENU_ITEM} onSelect={actions.duplicate}>Duplizieren</ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border" />
          <ContextMenu.Item className={cx(MENU_ITEM, 'text-error')} onSelect={actions.remove}>Löschen</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function GroupSection({ group, hosts, selectedId }: { group: Group | null; hosts: Host[]; selectedId: string | null }) {
  const key = group?.id ?? 'ungrouped';
  const collapsed = useApp((state) => state.preferences?.collapsedGroups.includes(key) ?? false);
  const setPreferences = useApp((state) => state.setPreferences);
  const toggle = () => {
    const current = useApp.getState().preferences?.collapsedGroups ?? [];
    void attempt(() =>
      setPreferences({ collapsedGroups: collapsed ? current.filter((item) => item !== key) : [...current, key] })
    );
  };
  return (
    <section className="flex flex-col">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={toggle}
        className="flex h-7 flex-none items-center gap-1.5 rounded-control px-1 text-xs font-medium text-secondary hover:text-text"
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span className="truncate">{group?.name ?? 'Ohne Gruppe'}</span>
      </button>
      {!collapsed && (
        <div role="list" aria-label={group?.name ?? 'Ohne Gruppe'} className="flex flex-col">
          {hosts.map((host) => (
            <HostRow key={host.id} host={host} selected={selectedId === host.id} />
          ))}
          {hosts.length === 0 && <p className="px-6 pb-2 text-[11px] text-subtle">Keine Hosts in dieser Gruppe</p>}
        </div>
      )}
    </section>
  );
}

function RecentList({ entries }: { entries: HistoryEntry[] }) {
  const hosts = useApp((state) => state.hosts);
  const connectHost = useWorkspace((state) => state.connectHost);
  const openTab = useWorkspace((state) => state.openTab);
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<Clock3 size={24} />}
        title="Noch keine Verbindungen"
        description="Hier erscheinen deine letzten SSH- und lokalen Sitzungen."
      />
    );
  }
  const formatter = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <div role="list" className="flex flex-col gap-0.5">
      {entries.map((entry) => {
        const stillExists = entry.kind === 'local' || hosts.some((host) => host.id === entry.hostId);
        return (
          <button
            key={entry.id}
            type="button"
            role="listitem"
            disabled={!stillExists}
            onClick={() => {
              if (entry.kind === 'ssh' && entry.hostId) connectHost(entry.hostId);
              else openTab({ kind: 'local', shellId: null });
            }}
            className="flex h-[46px] flex-none flex-col justify-center rounded-card px-2.5 text-left hover:bg-hover disabled:opacity-50"
          >
            <span className="truncate text-[13px] font-medium text-text">{entry.label}</span>
            <span className="truncate text-[11px] text-secondary">
              {entry.kind === 'ssh' ? 'SSH' : 'Lokal'} · {formatter.format(new Date(entry.startedAt))}
              {entry.outcome === 'failed' ? ' · fehlgeschlagen' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function GroupManager({ open, onClose }: { open: boolean; onClose(): void }) {
  const groups = useApp((state) => state.groups);
  const createGroup = useApp((state) => state.createGroup);
  const renameGroup = useApp((state) => state.renameGroup);
  const deleteGroup = useApp((state) => state.deleteGroup);
  const askConfirm = useApp((state) => state.askConfirm);
  const [name, setName] = useState('');
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void attempt(() => createGroup(trimmed)).then((ok) => {
      if (ok) setName('');
    });
  };
  return (
    <Modal open={open} onOpenChange={(next) => !next && onClose()} title="Gruppen verwalten" width={420}>
      <div className="flex flex-col gap-2 overflow-y-auto px-5 pb-5">
        {groups.map((group) => (
          <div key={group.id} className="flex items-center gap-2">
            <Input
              aria-label={`Name der Gruppe ${group.name}`}
              defaultValue={group.name}
              maxLength={64}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next && next !== group.name) void attempt(() => renameGroup(group.id, next));
              }}
            />
            <Button
              onClick={() =>
                askConfirm({
                  title: `Gruppe „${group.name}“ löschen?`,
                  message: 'Die Hosts bleiben erhalten und werden zu „Ohne Gruppe“ verschoben.',
                  confirmLabel: 'Löschen',
                  danger: true,
                  onConfirm: () => void attempt(() => deleteGroup(group.id))
                })
              }
            >
              Löschen
            </Button>
          </div>
        ))}
        <form
          className="mt-1 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input
            aria-label="Neue Gruppe"
            placeholder="Neue Gruppe…"
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Anlegen
          </Button>
        </form>
      </div>
    </Modal>
  );
}

export function HostBrowser() {
  const hosts = useApp((state) => state.hosts);
  const groups = useApp((state) => state.groups);
  const history = useApp((state) => state.history);
  const nav = useApp((state) => state.nav);
  const query = useApp((state) => state.query);
  const setQuery = useApp((state) => state.setQuery);
  const segment = useApp((state) => state.segment);
  const setSegment = useApp((state) => state.setSegment);
  const groupFilter = useApp((state) => state.groupFilter);
  const selectedHostId = useApp((state) => state.selectedHostId);
  const openEditor = useApp((state) => state.openEditor);
  const [groupsOpen, setGroupsOpen] = useState(false);

  const sections = useMemo(
    () => buildSections(hosts, groups, { query, segment, groupId: groupFilter }),
    [hosts, groups, query, segment, groupFilter]
  );
  const title = nav === 'recent' ? 'Recent' : groupFilter ? (groups.find((g) => g.id === groupFilter)?.name ?? 'Hosts') : 'Hosts';
  const matches = sections.reduce((sum, section) => sum + section.hosts.length, 0);

  let content;
  if (nav === 'recent') {
    content = <RecentList entries={history} />;
  } else if (hosts.length === 0) {
    content = (
      <EmptyState
        icon={<Server size={24} />}
        title="Noch keine Hosts"
        description="Lege deinen ersten SSH-Host an. Secrets landen ausschließlich im Schlüsselbund des Betriebssystems."
        action={
          <Button variant="primary" onClick={() => openEditor(null)}>
            <Plus size={14} /> Host hinzufügen
          </Button>
        }
      />
    );
  } else if (matches === 0 && (query.trim() || segment === 'favorites')) {
    content = (
      <EmptyState
        icon={query.trim() ? <Search size={24} /> : <Star size={24} />}
        title={query.trim() ? 'Keine Treffer' : 'Keine Favoriten'}
        description={
          query.trim() ? `Kein Host passt zu „${query.trim()}“.` : 'Markiere Hosts mit dem Stern, um sie hier zu sehen.'
        }
        action={
          query.trim() ? (
            <Button onClick={() => setQuery('')}>Suche zurücksetzen</Button>
          ) : undefined
        }
      />
    );
  } else {
    content = sections.map((section) => (
      <GroupSection
        key={section.group?.id ?? 'ungrouped'}
        group={section.group}
        hosts={section.hosts}
        selectedId={selectedHostId}
      />
    ));
  }

  return (
    <section aria-label="Hosts" className="flex h-full min-h-0 flex-col rounded-panel border border-border bg-host-panel">
      <header className="flex h-12 flex-none items-center gap-2 pr-2.5 pl-3.5">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-text">{title}</h1>
        <IconButton
          label="Host hinzufügen"
          size={28}
          onClick={() => openEditor(null)}
          className="rounded-full !bg-cyan !text-on-cyan shadow-glow hover:brightness-110"
        >
          <Plus size={16} strokeWidth={2.4} />
        </IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label="Weitere Aktionen" size={28}>
              <MoreVertical size={16} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className={MENU_SURFACE}>
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => openEditor(null)}>
                Host hinzufügen
              </DropdownMenu.Item>
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setGroupsOpen(true)}>
                Gruppen verwalten
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>

      {nav !== 'recent' && (
        <div className="px-2.5 pb-2">
          <div role="tablist" aria-label="Hostfilter" className="flex h-[30px] gap-0.5 rounded-control bg-card p-0.5">
            {SEGMENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={segment === item.id}
                onClick={() => setSegment(item.id)}
                className={cx(
                  'min-w-0 flex-1 truncate rounded-[4px] text-xs transition-colors duration-120',
                  segment === item.id ? 'bg-segment-active font-medium text-text' : 'text-secondary hover:text-text'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2.5 pb-2.5">{content}</div>
      <GroupManager open={groupsOpen} onClose={() => setGroupsOpen(false)} />
    </section>
  );
}
