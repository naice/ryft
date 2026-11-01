import { z } from 'zod';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackAddress(address: string): boolean {
  // Only a literal address: a name such as 127.0.0.1.example.org resolves wherever its owner wants.
  return LOOPBACK.has(address.toLowerCase()) || /^127(\.\d{1,3}){3}$/.test(address);
}

const address = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[^\s-][^\s]*$/, 'Ungültige Adresse');

export const forwardInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(128),
    hostId: z.uuid(),
    /** local = -L, remote = -R, dynamic = -D */
    type: z.enum(['local', 'remote', 'dynamic']),
    bindAddress: address,
    /** 0 lets the OS or the server pick a free port. */
    bindPort: z.number().int().min(0).max(65535),
    destHost: address.nullable(),
    destPort: z.number().int().min(1).max(65535).nullable(),
    restoreOnStart: z.boolean(),
    autoReconnect: z.boolean(),
    /** A listener reachable from other machines exists only with this explicit decision. */
    allowNonLoopback: z.boolean()
  })
  .superRefine((value, ctx) => {
    if (value.type !== 'dynamic' && (!value.destHost || !value.destPort)) {
      ctx.addIssue({ code: 'custom', path: ['destHost'], message: 'Ziel erforderlich' });
    }
    if (!isLoopbackAddress(value.bindAddress) && !value.allowNonLoopback) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowNonLoopback'],
        message: 'Eine Adresse außerhalb von Loopback muss ausdrücklich erlaubt werden'
      });
    }
  });
export type ForwardInput = z.infer<typeof forwardInputSchema>;

export interface ForwardProfile extends ForwardInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type ForwardStatus = 'stopped' | 'starting' | 'running' | 'reconnecting' | 'failed';

export interface ForwardRuntime {
  id: string;
  status: ForwardStatus;
  /** The port really bound; differs from the profile for port 0. */
  boundPort: number | null;
  connections: number;
  error: string | null;
  /** Upcoming automatic retry, 1-based. */
  attempt: number | null;
}
