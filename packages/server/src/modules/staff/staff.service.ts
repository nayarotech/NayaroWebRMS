import type { NayaroPrismaClient, StaffRole } from '@nayaro/database';
import type { StaffListResponse } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { hashPassword, verifyPassword } from '../auth/password';
import { revokeAllSessionsForStaff } from '../auth/session.service';
import {
  changeOwnPasswordSchema,
  createStaffSchema,
  resetPasswordSchema,
  updateStaffSchema,
} from './staff.schema';

/**
 * Staff management.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Every financial record in the database
 * names a person - who opened the order, who approved the discount, who issued
 * the invoice, who took the money. Until a restaurant can create real accounts,
 * all of those say "the owner", because the owner login is the only one that
 * exists. The audit trail is only worth the columns it occupies if the people
 * are real.
 *
 * NOTHING here deletes. Staff are referenced by orders, tickets, invoices and
 * payments going back to the first day; `isActive = false` is how someone
 * leaves, and every historical reference keeps resolving.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listStaff(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  currentStaffId: string,
): Promise<StaffListResponse> {
  const rows = await prisma.staff.findMany({
    where: { restaurantId },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    // Note what is absent: passwordHash. It is never selected, so it can never
    // be accidentally serialised into a response.
    select: {
      id: true,
      name: true,
      username: true,
      role: true,
      canTakeOrders: true,
      canManageKitchen: true,
      isActive: true,
      lastLoginAt: true,
    },
  });

  return {
    staff: rows.map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username,
      role: row.role,
      canTakeOrders: row.canTakeOrders,
      canManageKitchen: row.canManageKitchen,
      isActive: row.isActive,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      isSelf: row.id === currentStaffId,
    })),
  };
}

// ---------------------------------------------------------------------------
// Creating and editing
// ---------------------------------------------------------------------------

export async function createStaff(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actor: Actor,
  rawInput: unknown,
): Promise<StaffListResponse> {
  const input = createStaffSchema.parse(rawInput);
  assertMayManageRole(actor, input.role);

  const existing = await prisma.staff.findFirst({
    where: { restaurantId, username: input.username },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      'USERNAME_TAKEN',
      `Someone already signs in as "${input.username}". Choose another username.`,
    );
  }

  await prisma.staff.create({
    data: {
      restaurantId,
      name: input.name,
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      canTakeOrders: input.canTakeOrders ?? false,
      canManageKitchen: input.canManageKitchen ?? false,
    },
  });
  return listStaff(prisma, restaurantId, actor.id);
}

export async function updateStaff(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actor: Actor,
  staffId: string,
  rawInput: unknown,
): Promise<StaffListResponse> {
  const input = updateStaffSchema.parse(rawInput);
  const target = await findStaffOrThrow(prisma, restaurantId, staffId);

  assertMayManageRole(actor, target.role);
  if (input.role !== undefined) assertMayManageRole(actor, input.role);

  // THE LAST OWNER INVARIANT. A restaurant with no active owner is locked out
  // of its own settings, its own staff list and its own recovery - there is no
  // higher authority to appeal to. Both routes into that state are refused:
  // deactivating the last owner, and demoting them.
  const losingOwner =
    target.role === 'OWNER' &&
    ((input.isActive === false && target.isActive) ||
      (input.role !== undefined && input.role !== 'OWNER'));

  if (losingOwner) {
    const otherActiveOwners = await prisma.staff.count({
      where: { restaurantId, role: 'OWNER', isActive: true, id: { not: staffId } },
    });
    if (otherActiveOwners === 0) {
      throw new ApiError(
        409,
        'LAST_OWNER',
        input.isActive === false
          ? 'This is the only owner account. Add another owner before deactivating this one.'
          : 'This is the only owner account. Make someone else an owner first.',
      );
    }
  }

  await prisma.staff.update({
    where: { id: staffId },
    data: {
      ...(input.canTakeOrders === undefined ? {} : { canTakeOrders: input.canTakeOrders }),
      ...(input.canManageKitchen === undefined ? {} : { canManageKitchen: input.canManageKitchen }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    },
  });

  // Someone who has just been deactivated or demoted must not keep working on
  // the strength of a session issued a moment ago. Authentication already
  // rejects an inactive account on the next request; this closes the window
  // for a role change too, which authentication would otherwise honour until
  // the session expired.
  if (
    input.isActive === false ||
    input.role !== undefined ||
    input.canTakeOrders !== undefined ||
    input.canManageKitchen !== undefined
  ) {
    await revokeAllSessionsForStaff(prisma, staffId, 'Account changed by a manager');
  }

  return listStaff(prisma, restaurantId, actor.id);
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * Self-service change. Requires the current password, so a terminal left
 * unlocked cannot be used to lock the real owner out of their own account.
 *
 * Every other session for this person is revoked - including any the thief was
 * holding. The session making the change is revoked too and the client signs
 * in again, which is the honest outcome: the credential it was issued against
 * no longer exists.
 */
export async function changeOwnPassword(
  prisma: NayaroPrismaClient,
  staffId: string,
  rawInput: unknown,
): Promise<void> {
  const input = changeOwnPasswordSchema.parse(rawInput);

  const staff = await prisma.staff.findFirst({
    where: { id: staffId },
    select: { id: true, passwordHash: true },
  });
  if (!staff) throw new ApiError(404, 'STAFF_NOT_FOUND', 'That account no longer exists.');

  if (!(await verifyPassword(input.currentPassword, staff.passwordHash))) {
    throw new ApiError(400, 'CURRENT_PASSWORD_WRONG', 'That is not your current password.');
  }

  await prisma.staff.update({
    where: { id: staffId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
  await revokeAllSessionsForStaff(prisma, staffId, 'Password changed');
}

/**
 * A manager or owner resetting somebody else's password.
 *
 * THE RULE, kept deliberately simple:
 *
 *   OWNER   may reset anyone, including another owner.
 *   MANAGER may reset CASHIER and KITCHEN only.
 *   Nobody may reset their own password this way - that is `changeOwnPassword`,
 *   which requires knowing the current one.
 *
 * A manager cannot reset an owner, because that would let a manager seize the
 * account that can remove them. An owner can reset another owner because
 * owners are peers who already share full authority, and one of them being
 * locked out with no path back is the worse failure.
 */
export async function resetStaffPassword(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actor: Actor,
  staffId: string,
  rawInput: unknown,
): Promise<void> {
  const input = resetPasswordSchema.parse(rawInput);
  const target = await findStaffOrThrow(prisma, restaurantId, staffId);

  if (target.id === actor.id) {
    throw new ApiError(
      400,
      'USE_CHANGE_PASSWORD',
      'Change your own password from your account instead, using your current one.',
    );
  }
  assertMayManageRole(actor, target.role);

  await prisma.staff.update({
    where: { id: staffId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
  await revokeAllSessionsForStaff(prisma, staffId, 'Password reset by a manager');
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export interface Actor {
  readonly id: string;
  readonly role: StaffRole;
}

/**
 * A manager may not create, edit or reset an OWNER. Without this, the lowest
 * privileged manager could promote themselves by editing the owner's account -
 * the role check on the route only says who may reach the endpoint, not whom
 * they may reach through it.
 */
function assertMayManageRole(actor: Actor, targetRole: StaffRole): void {
  if (actor.role === 'OWNER') return;
  if (targetRole === 'OWNER') {
    throw new ApiError(403, 'OWNER_REQUIRED', 'Only an owner can manage another owner account.');
  }
}

async function findStaffOrThrow(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
): Promise<{ id: string; role: StaffRole; isActive: boolean }> {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, restaurantId },
    select: { id: true, role: true, isActive: true },
  });
  // Scoped: another restaurant's staff read as "not found" rather than leaking
  // that the account exists.
  if (!staff) throw new ApiError(404, 'STAFF_NOT_FOUND', 'That account no longer exists.');
  return staff;
}
