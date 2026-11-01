import { z } from 'zod';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const noControlChars = (value: string): boolean => !CONTROL_CHARS.test(value);

export const authProfileInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(128).refine(noControlChars),
    method: z.enum(['agent', 'key', 'password']),
    /** Overrides the host's user name when set. */
    username: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[^\s]+$/)
      .refine(noControlChars)
      .nullable(),
    keyReference: z.string().trim().min(1).max(4096).refine(noControlChars).nullable()
  })
  .superRefine((value, ctx) => {
    if (value.method === 'key' && !value.keyReference) {
      ctx.addIssue({ code: 'custom', path: ['keyReference'], message: 'Schlüsseldatei erforderlich' });
    }
  });
export type AuthProfileInput = z.infer<typeof authProfileInputSchema>;

export interface AuthProfile extends AuthProfileInput {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Only whether a secret exists. The secret itself never leaves the main process. */
  hasStoredSecret: boolean;
  usedByHosts: number;
}
