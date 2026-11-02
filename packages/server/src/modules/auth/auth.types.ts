import type { StaffRole as PrismaStaffRole } from '@nayaro/database';
import type { AuthenticatedStaff, StaffRole as SharedStaffRole } from '@nayaro/shared';

/**
 * The ONLY shape of a staff member that ever leaves the server.
 *
 * Defined in `@nayaro/shared` so the renderer consumes the identical type
 * rather than a hand-copied twin. There is no passwordHash here, and no salt
 * or scrypt parameter, by construction rather than by remembering to strip
 * them at each call site.
 */
export type { AuthenticatedStaff };

/**
 * Compile-time guard that the shared role union and Prisma's generated enum
 * cannot drift apart. Adding a role to the schema without adding it to
 * @nayaro/shared (or vice versa) breaks the build here, which is the cheapest
 * possible place to find out.
 */
type AssertSameRoles =
  | (PrismaStaffRole extends SharedStaffRole ? true : never)
  | (SharedStaffRole extends PrismaStaffRole ? true : never);
const _rolesMatch: AssertSameRoles = true;
void _rolesMatch;
