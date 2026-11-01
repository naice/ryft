import { z } from 'zod';

/** Current format of a stored or exported workspace. Older formats are migrated on read, newer ones refused. */
export const WORKSPACE_VERSION = 1;

const nameSchema = z.string().trim().min(1).max(128);

/**
 * The layout is validated by `layoutSchema` from the contracts, which is passed in so that this
 * module stays free of the contract file that imports it.
 */
export function createWorkspaceSchemas<L extends z.ZodType>(layoutSchema: L) {
  const definition = z.strictObject({
    version: z.literal(WORKSPACE_VERSION),
    layout: layoutSchema,
    hostPanelWidth: z.number().int().min(220).max(380).nullable(),
    /**
     * Startup commands of an imported workspace stay switched off until the user read them.
     * A file from somewhere else must not be able to run anything.
     */
    startupApproved: z.boolean()
  });
  const hostRef = z.strictObject({
    id: z.uuid(),
    name: z.string().max(128),
    hostname: z.string().max(255),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(128)
  });
  const exportFile = z.strictObject({
    format: z.literal('ryft-workspace'),
    version: z.literal(WORKSPACE_VERSION),
    name: nameSchema,
    definition,
    /** How to find the hosts on another machine. Contains no credentials. */
    hosts: z.array(hostRef).max(512)
  });
  return { definition, exportFile };
}

export const workspaceNameSchema = nameSchema;

export interface WorkspaceHostRef {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  isDefault: boolean;
  tabCount: number;
  paneCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Finds the local host for a host of an exported workspace: the same id, or the same address. */
export function matchWorkspaceHost(ref: WorkspaceHostRef, local: readonly WorkspaceHostRef[]): string | null {
  const sameId = local.find((host) => host.id === ref.id);
  if (sameId && sameId.hostname === ref.hostname && sameId.port === ref.port) return sameId.id;
  const sameAddress = local.filter(
    (host) => host.hostname === ref.hostname && host.port === ref.port && host.username === ref.username
  );
  return sameAddress.length === 1 ? (sameAddress[0] as WorkspaceHostRef).id : null;
}
