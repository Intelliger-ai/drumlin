import { z } from "zod";
import { ProvenanceSchema } from "./provenance.js";

/**
 * The confirmed role and permission model.
 *
 * Permissions are a context-confirmation target, not a rule target. Drumlin can
 * see that a route checks a role, but it cannot see which roles are supposed to
 * reach it — and guessing produces confident nonsense about access control.
 * So nothing here is reported as a finding until a human has confirmed it.
 */

export const RoleSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  description: z.string().optional(),
  /** Roles whose permissions this role also has. */
  inherits: z.array(z.string()).optional(),
  provenance: ProvenanceSchema.optional(),
});
export type Role = z.infer<typeof RoleSchema>;

export const PermissionSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  /** Roles granted this permission. */
  roles: z.array(z.string()),
  provenance: ProvenanceSchema.optional(),
});
export type Permission = z.infer<typeof PermissionSchema>;

export const PERMISSIONS_SCHEMA_VERSION = 1;

export const PermissionsDocumentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  roles: z.array(RoleSchema),
  permissions: z.array(PermissionSchema),
  /** Routes a role may reach, when the human chose to record it. */
  routeAccess: z
    .array(
      z.object({
        route: z.string(),
        roles: z.array(z.string()),
        provenance: ProvenanceSchema.optional(),
      }),
    )
    .optional(),
  /** Set when a human reviewed the document. Absent means unconfirmed. */
  confirmedAt: z.string().optional(),
});
export type PermissionsDocument = z.infer<typeof PermissionsDocumentSchema>;

export function emptyPermissions(): PermissionsDocument {
  return {
    schemaVersion: PERMISSIONS_SCHEMA_VERSION,
    roles: [],
    permissions: [],
  };
}

/** True once a human has signed off, which is what unlocks permission rules. */
export function isConfirmed(document: PermissionsDocument): boolean {
  return (
    document.confirmedAt !== undefined &&
    document.roles.some((role) => role.provenance?.source === "human")
  );
}
