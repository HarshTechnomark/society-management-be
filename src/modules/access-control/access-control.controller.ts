import type { Request, RequestHandler, Response } from 'express';
import { Society } from '../../models';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import { AppError } from '../../utils/errors';
import { hasPermission } from './access-control.policies';
import * as roles from './access-control.roles.service';
import * as members from './access-control.members.service';
import * as grants from './access-control.grants.service';
import * as invitations from './access-control.invitations.service';
import * as household from './access-control.household.service';
import * as platform from './access-control.platform.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const ctxOf = (req: Request) => req.ctx;
const reveal = (req: Request) => hasPermission(req.ctx, 'residents.contacts.view');
const maskOf = (req: Request) => ({ revealContacts: reveal(req) });
const selfId = (req: Request) => req.ctx.user?.id ?? null;
const sid = (req: Request) => req.ctx.society!.id;

async function societyOr404(id: number): Promise<void> {
  if (!(await Society.findByPk(id, { attributes: ['id'] })))
    throw new AppError(404, 'SOCIETY_NOT_FOUND', 'Society not found');
}

export const accessController = {
  // ---- catalogue and roles
  permissions: h(async (req, res) => {
    ok(res, roles.listPermissions(ctxOf(req), req.valid.query.scope));
  }),
  listRoles: h(async (req, res) => {
    const r = await roles.listRoles(sid(req), req.valid.query, !req.ctx.supportGrant);
    okList(res, r.data, r.pagination);
  }),
  getRole: h(async (req, res) => {
    ok(res, await roles.getRole(sid(req), req.valid.params.id, !req.ctx.supportGrant));
  }),
  createRole: h(async (req, res) => {
    created(res, await roles.createRole(ctxOf(req), req.valid.body), 'Role created');
  }),
  updateRole: h(async (req, res) => {
    ok(res, await roles.updateRole(ctxOf(req), req.valid.params.id, req.valid.body), 'Role saved');
  }),
  resetRole: h(async (req, res) => {
    ok(res, await roles.resetRole(ctxOf(req), req.valid.params.id, req.valid.body), 'Role reset to default');
  }),
  deleteRole: h(async (req, res) => {
    await roles.deleteRole(ctxOf(req), req.valid.params.id, req.valid.body);
    noContent(res);
  }),

  // ---- members
  listMembers: h(async (req, res) => {
    const r = await members.listMembers(sid(req), req.valid.query, selfId(req), maskOf(req));
    okList(res, r.data, r.pagination);
  }),
  exportMembers: h(async (req, res) => {
    ok(res, await members.exportMembers(ctxOf(req), req.valid.query), 'Export ready');
  }),
  getMember: h(async (req, res) => {
    ok(res, await members.memberDetail(sid(req), req.valid.params.id, selfId(req), maskOf(req)));
  }),
  invite: h(async (req, res) => {
    created(res, await invitations.inviteMember(ctxOf(req), req.valid.body, reveal(req)), 'Invitation sent');
  }),
  patchMember: h(async (req, res) => {
    ok(res, await members.patchMember(ctxOf(req), req.valid.params.id, req.valid.body), 'Member updated');
  }),
  suspend: h(async (req, res) => {
    await members.suspendMember(ctxOf(req), req.valid.params.id, req.valid.body);
    ok(res, null, 'Member suspended');
  }),
  reactivate: h(async (req, res) => {
    await members.reactivateMember(ctxOf(req), req.valid.params.id, req.valid.body);
    ok(res, null, 'Member reactivated');
  }),
  endMember: h(async (req, res) => {
    await members.endMemberRoute(ctxOf(req), req.valid.params.id, req.valid.body);
    noContent(res);
  }),
  resetMfa: h(async (req, res) => {
    await members.resetMemberMfa(ctxOf(req), req.valid.params.id, req.valid.body.reason);
    ok(res, null, 'Two-step sign-in reset');
  }),
  revokeSessions: h(async (req, res) => {
    ok(
      res,
      await members.revokeMemberSessions(ctxOf(req), req.valid.params.id, req.valid.body.reason),
      'Signed out everywhere',
    );
  }),

  // ---- grants
  listGrants: h(async (req, res) => {
    ok(res, await grants.listGrants(sid(req), req.valid.params.id, req.valid.query.status));
  }),
  createGrant: h(async (req, res) => {
    created(
      res,
      await grants.createGrant(ctxOf(req), req.valid.params.id, req.valid.body),
      'Permission added',
    );
  }),
  revokeGrant: h(async (req, res) => {
    await grants.revokeGrant(
      ctxOf(req),
      req.valid.params.id,
      req.valid.params.grantId,
      req.valid.body.reason,
    );
    noContent(res);
  }),

  // ---- invitations
  listInvitations: h(async (req, res) => {
    const r = await invitations.listInvitations(sid(req), req.valid.query, reveal(req));
    okList(res, r.data, r.pagination);
  }),
  resend: h(async (req, res) => {
    ok(
      res,
      await invitations.resendInvitation(ctxOf(req), sid(req), req.valid.params.id, reveal(req)),
      'Invitation sent again',
    );
  }),
  revoke: h(async (req, res) => {
    ok(
      res,
      await invitations.revokeInvitation(
        ctxOf(req),
        sid(req),
        req.valid.params.id,
        req.valid.body.reason,
        reveal(req),
      ),
      'Invitation revoked',
    );
  }),
  preview: h(async (req, res) => {
    ok(res, await invitations.previewInvitation(ctxOf(req), req.valid.params.token));
  }),
  decline: h(async (req, res) => {
    await invitations.declineInvitation(ctxOf(req), req.valid.params.token, req.valid.body.reason);
    ok(res, null, 'Invitation declined');
  }),
  accept: h(async (req, res) => {
    const r = await invitations.acceptInvitation(ctxOf(req), req.valid.params.token);
    ok(res, r.data, r.message);
  }),

  // ---- household
  householdGet: h(async (req, res) => {
    ok(res, await household.getHouseholdGrants(ctxOf(req), req.valid.params.memberId));
  }),
  householdSet: h(async (req, res) => {
    ok(
      res,
      await household.setHouseholdGrants(ctxOf(req), req.valid.params.memberId, req.valid.body),
      'Permissions saved',
    );
  }),

  // ---- platform
  platformPermissions: h(async (_req, res) => {
    ok(res, platform.platformCatalogue());
  }),
  platformRoles: h(async (_req, res) => {
    ok(res, await platform.platformRoles());
  }),
  platformTeam: h(async (req, res) => {
    const r = await platform.listTeam(ctxOf(req), req.valid.query);
    okList(res, r.data, r.pagination);
  }),
  platformInvite: h(async (req, res) => {
    created(res, await platform.invitePlatformMember(ctxOf(req), req.valid.body), 'Invitation sent');
  }),
  platformResend: h(async (req, res) => {
    ok(
      res,
      await invitations.resendInvitation(ctxOf(req), null, req.valid.params.id, true),
      'Invitation sent again',
    );
  }),
  platformRevoke: h(async (req, res) => {
    ok(
      res,
      await invitations.revokeInvitation(ctxOf(req), null, req.valid.params.id, req.valid.body.reason, true),
      'Invitation revoked',
    );
  }),
  platformChangeRole: h(async (req, res) => {
    ok(
      res,
      await platform.changePlatformRole(ctxOf(req), req.valid.params.userId, req.valid.body),
      'Role changed',
    );
  }),
  platformDisable: h(async (req, res) => {
    await platform.disablePlatformMember(ctxOf(req), req.valid.params.userId, req.valid.body.reason);
    ok(res, null, 'Account disabled');
  }),
  platformEnable: h(async (req, res) => {
    await platform.enablePlatformMember(ctxOf(req), req.valid.params.userId, req.valid.body.reason);
    ok(res, null, 'Account enabled');
  }),
  platformResetMfa: h(async (req, res) => {
    await platform.resetPlatformMfa(ctxOf(req), req.valid.params.userId, req.valid.body.reason);
    ok(res, null, 'Two-step sign-in reset');
  }),
  platformRemove: h(async (req, res) => {
    await platform.removePlatformMember(ctxOf(req), req.valid.params.userId, req.valid.body.reason);
    noContent(res);
  }),
  platformSocietyRoles: h(async (req, res) => {
    const r = await roles.listRolesOfSociety(req.valid.params.id, req.valid.query);
    okList(res, r.data, r.pagination);
  }),
  platformSocietyMembers: h(async (req, res) => {
    await societyOr404(req.valid.params.id);
    const r = await members.listMembers(req.valid.params.id, req.valid.query, null, {
      revealContacts: false,
      alwaysMask: true,
      maskEmail: true,
    });
    okList(res, r.data, r.pagination);
  }),
  platformEditRole: h(async (req, res) => {
    await societyOr404(req.valid.params.id);
    ok(
      res,
      await roles.updateRoleCore(
        ctxOf(req),
        req.valid.params.id,
        req.valid.params.roleId,
        req.valid.body,
        'platform',
      ),
      'Role saved',
    );
  }),
  platformSocietyResetMfa: h(async (req, res) => {
    await societyOr404(req.valid.params.id);
    await members.resetMemberMfaAsPlatform(
      ctxOf(req),
      req.valid.params.id,
      req.valid.params.memberId,
      req.valid.body.reason,
    );
    ok(res, null, 'Two-step sign-in reset');
  }),
};
