import { z } from 'zod';

/** Zod schemas for module 03 (section 8). Every body is `.strict()`; ids are positive integers. */
const id = z.coerce.number().int().positive();
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const reason = (min = 5, max = 500) =>
  z.string().trim().min(min, `Give a reason (at least ${min} characters)`).max(max);
const mobile = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
const personName = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(120)
  .regex(/^[A-Za-z][A-Za-z .'-]*$/, 'Name has characters that are not allowed');
const email = z.string().trim().toLowerCase().max(254).pipe(z.email('Enter a valid email address'));
const keyList = (min: number, max: number) =>
  z
    .array(z.string().min(3).max(80))
    .min(min)
    .max(max)
    .refine(a => new Set(a).size === a.length, 'Keys must be unique');
const version = z.number().int().min(1);
const emptyBody = z.object({}).strict();
const search = (min: number, max: number) => z.string().trim().min(min).max(max).optional();
const dir = z.enum(['asc', 'desc']);
const roleName = z
  .string()
  .trim()
  .min(3, 'Name must be at least 3 characters')
  .max(50, 'Name must be at most 50 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9 &()'.-]*$/, 'Name has characters that are not allowed');
const iso = z.iso.datetime({ message: 'Use an ISO 8601 date and time' }).transform(s => new Date(s));

export const accessSchemas = {
  idParam: z.object({ id }),
  memberGrantParams: z.object({ id, grantId: id }),
  catalogueQuery: z.object({ scope: z.enum(['society', 'gate', 'work', 'resident']).default('society') }),
  rolesQuery: z.object({
    scope: z.enum(['society', 'resident', 'gate', 'work']).optional(),
    type: z.enum(['system', 'custom']).optional(),
    search: search(1, 50),
    sortBy: z.enum(['name', 'createdAt', 'memberCount']).default('name'),
    sortOrder: dir.default('asc'),
    ...page,
  }),
  createRole: z
    .object({
      name: roleName,
      description: z.string().trim().max(300).optional(),
      scope: z.enum(['society', 'gate', 'work', 'resident', 'platform']),
      basedOnRoleId: id.optional(),
      permissionKeys: keyList(1, 300).optional(),
      requiresMfa: z.boolean().optional(),
    })
    .strict()
    .refine(b => b.permissionKeys !== undefined || b.basedOnRoleId !== undefined, {
      message: 'Give permissionKeys or basedOnRoleId',
      path: ['permissionKeys'],
    }),
  updateRole: z
    .object({
      version,
      name: roleName.optional(),
      description: z.string().trim().max(300).nullable().optional(),
      permissionKeys: keyList(1, 300).optional(),
      requiresMfa: z.boolean().optional(),
      reason: reason().optional(),
    })
    .strict()
    .refine(
      b =>
        b.name !== undefined ||
        b.description !== undefined ||
        b.permissionKeys !== undefined ||
        b.requiresMfa !== undefined,
      { message: 'Nothing to change', path: ['name'] },
    )
    .refine(b => (b.permissionKeys === undefined && b.requiresMfa === undefined) || b.reason !== undefined, {
      message: 'A reason is required',
      path: ['reason'],
    }),
  versionReason: z.object({ version, reason: reason() }).strict(),

  membersQuery: z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'ENDED']).optional(),
    roleId: id.optional(),
    scope: z.enum(['society', 'resident', 'gate', 'work']).optional(),
    search: search(2, 60),
    sortBy: z.enum(['name', 'joinedAt', 'lastLoginAt', 'role']).default('name'),
    sortOrder: dir.default('asc'),
    ...page,
  }),
  exportQuery: z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'ENDED']).optional(),
    roleId: id.optional(),
    scope: z.enum(['society', 'resident', 'gate', 'work']).optional(),
    search: search(2, 60),
    sortBy: z.enum(['name', 'joinedAt', 'lastLoginAt', 'role']).default('name'),
    sortOrder: dir.default('asc'),
  }),
  invite: z
    .object({
      name: personName,
      mobile,
      email: email.optional(),
      roleId: id,
      locationLabel: z.string().trim().min(1).max(60).optional(),
      message: z.string().trim().max(300).optional(),
    })
    .strict(),
  patchMember: z
    .object({
      version,
      roleId: id.optional(),
      locationLabel: z.string().trim().min(1).max(60).nullable().optional(),
      reason: reason().optional(),
    })
    .strict()
    .refine(b => b.roleId !== undefined || b.locationLabel !== undefined, {
      message: 'Nothing to change',
      path: ['roleId'],
    })
    .refine(b => b.roleId === undefined || b.reason !== undefined, {
      message: 'A reason is required to change the role',
      path: ['reason'],
    }),
  reasonOnly: z.object({ reason: reason() }).strict(),
  grantsQuery: z.object({ status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'ALL']).default('ACTIVE') }),
  createGrant: z
    .object({
      permissionKey: z.string().min(3).max(80),
      startsAt: iso.optional(),
      endsAt: iso,
      reason: reason(5, 300),
    })
    .strict(),
  revokeGrant: z.object({ reason: reason(5, 300) }).strict(),
  invitationsQuery: z.object({
    status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED', 'ALL']).default('PENDING'),
    roleId: id.optional(),
    scope: z.enum(['society', 'resident', 'gate', 'work']).optional(),
    search: search(2, 60),
    sortBy: z.enum(['createdAt', 'expiresAt', 'name']).default('createdAt'),
    sortOrder: dir.default('desc'),
    ...page,
  }),
  emptyBody,
  tokenParam: z.object({ token: z.string().max(200) }),
  decline: z.object({ reason: z.string().trim().max(300).optional() }).strict(),
  householdParams: z.object({ memberId: id }),
  householdPatch: z
    .object({
      unitId: id,
      allow: z
        .array(z.string())
        .max(7)
        .refine(a => new Set(a).size === a.length, 'Keys must be unique'),
      deny: z
        .array(z.string())
        .max(3)
        .refine(a => new Set(a).size === a.length, 'Keys must be unique'),
    })
    .strict(),

  // platform
  teamQuery: z.object({
    status: z.enum(['ACTIVE', 'DISABLED', 'INVITED', 'ALL']).default('ALL'),
    roleId: id.optional(),
    search: search(1, 60),
    sortBy: z.enum(['name', 'lastLoginAt']).default('name'),
    sortOrder: dir.default('asc'),
    ...page,
  }),
  platformInvite: z.object({ name: personName, mobile, email, roleId: id }).strict(),
  userIdParam: z.object({ userId: id }),
  platformChangeRole: z.object({ roleId: id, reason: reason() }).strict(),
  platformSocietyParams: z.object({ id }),
  platformRoleParams: z.object({ id, roleId: id }),
  platformMemberParams: z.object({ id, memberId: id }),
  platformEditRole: z
    .object({
      version,
      permissionKeys: keyList(1, 300).optional(),
      requiresMfa: z.boolean().optional(),
      reason: reason(10, 500),
    })
    .strict()
    .refine(b => b.permissionKeys !== undefined || b.requiresMfa !== undefined, {
      message: 'Nothing to change',
      path: ['permissionKeys'],
    }),
  platformReasonLong: z.object({ reason: reason(10, 500) }).strict(),
};
