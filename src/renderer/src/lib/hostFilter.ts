import type { Group, Host } from '@shared/contracts';

export type HostSegment = 'all' | 'favorites' | 'groups';

export interface HostFilter {
  query: string;
  segment: HostSegment;
  groupId: string | null;
}

export interface HostSection {
  /** `null` is the section of ungrouped hosts. */
  group: Group | null;
  hosts: Host[];
}

export function matchesQuery(host: Host, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [host.name, host.hostname, host.username, ...host.tags].join(' ').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterHosts(hosts: Host[], filter: HostFilter): Host[] {
  return hosts.filter(
    (host) =>
      matchesQuery(host, filter.query) &&
      (filter.segment !== 'favorites' || host.favorite) &&
      (filter.segment !== 'groups' || host.groupId !== null) &&
      (filter.groupId === null || host.groupId === filter.groupId)
  );
}

/**
 * Groups keep their order. A group without matches disappears, but empty groups stay visible when not filtering.
 * Within a section favourites come first; the sort is stable, so the name order of the input survives otherwise.
 */
export function buildSections(hosts: Host[], groups: Group[], filter: HostFilter): HostSection[] {
  const visible = filterHosts(hosts, filter).sort((a, b) => Number(b.favorite) - Number(a.favorite));
  const isFiltering = filter.query.trim() !== '' || filter.segment === 'favorites';
  const sections: HostSection[] = groups
    .filter((group) => filter.groupId === null || filter.groupId === group.id)
    .map((group) => ({ group, hosts: visible.filter((host) => host.groupId === group.id) }))
    .filter((section) => section.hosts.length > 0 || !isFiltering);
  const ungrouped = visible.filter((host) => host.groupId === null);
  if (ungrouped.length > 0) sections.push({ group: null, hosts: ungrouped });
  return sections;
}

export function groupCounts(hosts: Host[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const host of hosts) {
    if (host.groupId) counts.set(host.groupId, (counts.get(host.groupId) ?? 0) + 1);
  }
  return counts;
}
