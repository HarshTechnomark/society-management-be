import type { RequestHandler } from 'express';
import ipaddr from 'ipaddr.js';
import { AppError } from '../../utils/errors';
import { getPlatformSetting } from './platform-ops.settings.service';

/** True when the address is inside at least one CIDR. IPv4-mapped IPv6 addresses are compared as IPv4. */
export function ipAllowed(ip: string, cidrs: readonly string[]): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  return cidrs.some(c => {
    try {
      const [range, bits] = ipaddr.parseCIDR(c);
      return range.kind() === addr.kind() && addr.match(range, bits);
    } catch {
      return false;
    }
  });
}

/**
 * BR-07-43: while `security.ipAllowlist` is not empty, every `/api/v1/platform/*` request from an address outside all
 * listed CIDRs is `403 IP_NOT_ALLOWED`. Mounted in front of the platform routes.
 */
export const platformIpAllowlist = (): RequestHandler => async (req, _res, next) => {
  try {
    const list = await getPlatformSetting('security.ipAllowlist');
    if (list.length && !ipAllowed(req.ip ?? req.ctx?.ip ?? '', list))
      return next(
        new AppError(403, 'IP_NOT_ALLOWED', 'This address is not allowed to use the platform console'),
      );
    next();
  } catch (err) {
    next(err);
  }
};
