/** What is left of a broadcast selection when sessions end. Sessions are never added on their own. */
export function remainingBroadcastTargets(selected: readonly string[], connected: readonly string[]): string[] {
  return selected.filter((id) => connected.includes(id));
}

export type BroadcastActivation = { ok: true; targets: string[] } | { ok: false; reason: string };

/** A broadcast reaches at least two sessions, and only sessions that are connected at this moment. */
export function validateBroadcastActivation(selected: readonly string[], connected: readonly string[]): BroadcastActivation {
  const targets = remainingBroadcastTargets([...new Set(selected)], connected);
  if (targets.length < 2) return { ok: false, reason: 'Wähle mindestens zwei verbundene Sitzungen.' };
  return { ok: true, targets };
}

/** Where a key press in one session is repeated. A session outside of the selection repeats nothing. */
export function mirrorTargets(sourceId: string, targets: readonly string[]): string[] {
  return targets.includes(sourceId) ? targets.filter((id) => id !== sourceId) : [];
}
