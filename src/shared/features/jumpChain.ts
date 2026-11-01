export const MAX_JUMP_HOPS = 8;

export type JumpChainProblem =
  | { kind: 'cycle'; hostId: string }
  | { kind: 'missing'; hostId: string }
  | { kind: 'tooLong' };

export type JumpChainResult = { ok: true; hops: string[] } | { ok: false; problem: JumpChainProblem };

/**
 * Flattens a host's jump configuration into connection order, target last. A jump host may have
 * jump hosts of its own, and a host reached twice on one path could never finish connecting.
 */
export function flattenJumpChain(
  targetId: string,
  jumpsOf: (hostId: string) => readonly string[] | null
): JumpChainResult {
  const hops: string[] = [];
  const visiting = new Set<string>();

  const visit = (hostId: string): JumpChainProblem | null => {
    if (visiting.has(hostId) || hops.includes(hostId)) return { kind: 'cycle', hostId };
    const jumps = jumpsOf(hostId);
    if (jumps === null) return { kind: 'missing', hostId };
    visiting.add(hostId);
    for (const jump of jumps) {
      const problem = visit(jump);
      if (problem) return problem;
    }
    visiting.delete(hostId);
    hops.push(hostId);
    return hops.length > MAX_JUMP_HOPS + 1 ? { kind: 'tooLong' } : null;
  };

  const problem = visit(targetId);
  return problem ? { ok: false, problem } : { ok: true, hops };
}
