import { randomBytes } from 'node:crypto';
import { Op } from 'sequelize';
import { Resident, Tenancy, UnitResident, sequelize } from '../../models';
import type { Transaction } from 'sequelize';
import { istDate, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { enqueue } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { normaliseMobile, MOBILE_RE } from '../auth/auth.normalise';
import { societyPorts } from '../societies/societies.ports';
import { setupPorts } from '../society-setup/society-setup.ports';
import { parseImportFile, type Cell } from '../society-setup/society-setup.imports.parse';
import { toCsv, type CsvValue } from '../society-setup/society-setup.csv';
import { settings, units } from '../society-setup/society-setup.public';
import { actorCtx } from '../society-setup/society-setup.shared';
import { AUDIT, ENTITY, IMPORT_MAX_ROWS, JOBS, RESIDENTS_QUEUE, FEATURE } from './residents.constants';
import { inviteResident } from './residents.invite.service';
import { assertShares, createLink, lockLinks } from './residents.links.service';
import { touchReports } from './residents.ports';
import {
  addDaysYmd,
  assertFeatureFor,
  centsToShare,
  isMinor,
  rule,
  shareCents,
  societyToday,
} from './residents.shared';
import { syncMembership } from './residents.sync';
import { liveTenancyOf } from './residents.links.service';
import type { FamilyRelation, LinkRelation } from '../../models/unit-resident.model';

/** Bulk import of residents (8.12): dry run and commit, one transaction per row, a result CSV for every run. */
export const IMPORT_HEADER = [
  'Flat',
  'Relation',
  'Name',
  'Mobile',
  'Email',
  'Date of birth',
  'Share %',
  'Primary',
  'Residing',
  'From date',
  'Agreement start',
  'Agreement end',
  'Maintenance payer',
];
const SYNONYMS: Record<string, string> = {
  flat: 'flat',
  unit: 'flat',
  'flat no': 'flat',
  relation: 'relation',
  name: 'name',
  mobile: 'mobile',
  phone: 'mobile',
  email: 'email',
  'date of birth': 'dob',
  dob: 'dob',
  'share %': 'share',
  share: 'share',
  primary: 'primary',
  residing: 'residing',
  'from date': 'from',
  from: 'from',
  'agreement start': 'agreementStart',
  'agreement end': 'agreementEnd',
  'maintenance payer': 'payer',
};
const REQUIRED_COLUMNS = ['flat', 'relation', 'name'];

export interface ImportRow {
  row: number;
  flat: string;
  relation: string;
  name: string;
  mobile: string;
  email: string;
  dob: string;
  share: string;
  primary: string;
  residing: string;
  from: string;
  agreementStart: string;
  agreementEnd: string;
  payer: string;
}
export interface ImportState {
  jobId: string;
  societyId: number;
  userId: number;
  fileName: string;
  mode: 'DRY_RUN' | 'COMMIT';
  inviteAll: boolean;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  totalRows: number;
  okRows: number;
  errorRows: number;
  resultFileId: number | null;
  failure: string | null;
  rows: ImportRow[];
  startedAt: string;
}

const TTL = 24 * 3600;
const stateKey = (id: string) => `res:import:${id}`;
const lockKey = (societyId: number) => `res:import-lock:${societyId}`;
const saveState = (s: ImportState) => kv().cacheSet(stateKey(s.jobId), JSON.stringify(s), TTL);
const loadState = async (id: string): Promise<ImportState | null> => {
  const raw = await kv().cacheGet(stateKey(id));
  return raw ? (JSON.parse(raw) as ImportState) : null;
};
const formatInvalid = (message: string) =>
  new UnprocessableError('IMPORT_FORMAT_INVALID', message, [{ field: 'fileId', message }]);

const cellText = (c: Cell | undefined): string =>
  c === undefined ? '' : typeof c === 'string' ? c.trim() : c.date;

export async function startImport(
  ctx: Ctx,
  societyId: number,
  input: { fileId: number; mode: 'DRY_RUN' | 'COMMIT'; inviteAll: boolean },
) {
  const userId = ctx.user!.id;
  if (!(await kv().setIfAbsent(lockKey(societyId), 'starting', 3600)))
    throw new AppError(409, 'IMPORT_RUNNING', 'Another import of this society is still running');
  try {
    const file = await setupPorts().files.getImportFile(societyId, userId, input.fileId);
    let sheet;
    try {
      sheet = await parseImportFile(file.content);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'IMPORT_TOO_MANY_ROWS')
        throw new UnprocessableError('IMPORT_TOO_LARGE', `The file has more than ${IMPORT_MAX_ROWS} rows`, [
          { field: 'fileId', message: `At most ${IMPORT_MAX_ROWS} rows` },
        ]);
      if (code === 'IMPORT_FILE_INVALID') throw formatInvalid((err as Error).message);
      throw err;
    }
    const cols = sheet.headers.map(h => SYNONYMS[h.trim().toLowerCase()] ?? '');
    const missing = REQUIRED_COLUMNS.filter(c => !cols.includes(c));
    if (missing.length) throw formatInvalid(`Missing columns: ${missing.join(', ')}`);
    const rows: ImportRow[] = sheet.rows.map(r => {
      const o: Record<string, string> = {
        flat: '',
        relation: '',
        name: '',
        mobile: '',
        email: '',
        dob: '',
        share: '',
        primary: '',
        residing: '',
        from: '',
        agreementStart: '',
        agreementEnd: '',
        payer: '',
      };
      cols.forEach((c, i) => {
        if (c) o[c] = cellText(r.cells[i]);
      });
      return { row: r.row, ...o } as ImportRow;
    });
    const jobId = `imp_${randomBytes(4).toString('hex')}`;
    const state: ImportState = {
      jobId,
      societyId,
      userId,
      fileName: file.name,
      mode: input.mode,
      inviteAll: input.inviteAll,
      status: 'QUEUED',
      totalRows: rows.length,
      okRows: 0,
      errorRows: 0,
      resultFileId: null,
      failure: null,
      rows,
      startedAt: now().toISOString(),
    };
    await saveState(state);
    await kv().cacheSet(lockKey(societyId), jobId, 3600);
    await sequelize.transaction(t =>
      audit(
        ctx,
        {
          action: AUDIT.importStarted,
          entityType: ENTITY.import,
          entityId: jobId,
          societyId,
          after: { mode: input.mode, rows: rows.length, fileId: input.fileId },
        },
        t,
      ),
    );
    await enqueue(RESIDENTS_QUEUE, JOBS.import, { jobId, requestId: ctx.requestId }, { jobId });
    return { jobId, status: 'QUEUED' as const };
  } catch (err) {
    await kv().cacheDel(lockKey(societyId));
    throw err;
  }
}

export async function getImport(societyId: number, userId: number, jobId: string) {
  const s = await loadState(jobId);
  if (!s || s.societyId !== societyId || s.userId !== userId)
    throw new AppError(404, 'IMPORT_JOB_NOT_FOUND', 'Import not found');
  return {
    jobId: s.jobId,
    mode: s.mode,
    status: s.status,
    totalRows: s.totalRows,
    okRows: s.okRows,
    errorRows: s.errorRows,
    resultFileId: s.resultFileId,
  };
}

// ------------------------------------------------------------------ row rules
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DMY = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/;
const realDate = (v: string): boolean =>
  !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
function toYmd(v: string): string | null {
  if (!v) return null;
  let d = v;
  const m = DMY.exec(v);
  if (m) d = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return YMD.test(d) && realDate(d) ? d : 'INVALID';
}
const yes = (v: string): boolean | null =>
  /^(y|yes|true|1)$/i.test(v) ? true : /^(n|no|false|0)$/i.test(v) ? false : null;
const RELATIONS = ['OWNER', 'CO_OWNER', 'FAMILY', 'CARETAKER', 'TENANT'] as const;

interface Parsed {
  relation: LinkRelation;
  name: string;
  mobile: string | null;
  email: string | null;
  dob: string | null;
  share: string | null;
  primary: boolean | undefined;
  residing: boolean | undefined;
  from: string | null;
  agreementStart: string | null;
  agreementEnd: string | null;
  payer: 'OWNER' | 'TENANT';
}

/** The field-level checks of a row; a failure is `VALIDATION_FAILED`. */
function parseRow(r: ImportRow): Parsed | string[] {
  const bad: string[] = [];
  const relation = r.relation.trim().toUpperCase().replace(/[ -]/g, '_');
  if (!(RELATIONS as readonly string[]).includes(relation)) bad.push('relation');
  const name = r.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120 || !/^[\p{L}\p{M} .'-]+$/u.test(name)) bad.push('name');
  let mobile: string | null = null;
  if (r.mobile) {
    mobile = normaliseMobile(r.mobile);
    if (!MOBILE_RE.test(mobile)) bad.push('mobile');
  }
  const email = r.email ? r.email.trim().toLowerCase() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad.push('email');
  const dob = toYmd(r.dob);
  const from = toYmd(r.from);
  const as = toYmd(r.agreementStart);
  const ae = toYmd(r.agreementEnd);
  for (const [k, v] of [
    ['dateOfBirth', dob],
    ['fromDate', from],
    ['agreementStart', as],
    ['agreementEnd', ae],
  ] as const)
    if (v === 'INVALID') bad.push(k);
  let share: string | null = null;
  if (r.share) {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(r.share) || shareCents(r.share) < 1 || shareCents(r.share) > 10000)
      bad.push('share');
    else share = centsToShare(shareCents(r.share));
  }
  const primary = r.primary ? yes(r.primary) : undefined;
  const residing = r.residing ? yes(r.residing) : undefined;
  if (primary === null) bad.push('primary');
  if (residing === null) bad.push('residing');
  const payer = r.payer ? r.payer.trim().toUpperCase() : 'OWNER';
  if (payer !== 'OWNER' && payer !== 'TENANT') bad.push('maintenancePayer');
  if (bad.length) return bad;
  return {
    relation: relation as LinkRelation,
    name,
    mobile,
    email,
    dob: dob === 'INVALID' ? null : dob,
    share,
    primary: primary ?? undefined,
    residing: residing ?? undefined,
    from: from === 'INVALID' ? null : from,
    agreementStart: as === 'INVALID' ? null : as,
    agreementEnd: ae === 'INVALID' ? null : ae,
    payer: payer as 'OWNER' | 'TENANT',
  };
}

interface Outcome {
  codes: string[];
  skipped?: boolean;
  residentId?: number;
  created?: boolean;
}

/** BR-09-27 and BR-09-28 for an imported TENANT row; the row becomes an ACTIVE tenancy (APPROVED when it starts later). */
async function importTenancy(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  residentId: number,
  p: Parsed,
  t: Transaction,
): Promise<void> {
  const today = await societyToday(societyId);
  const start = p.agreementStart;
  const end = p.agreementEnd;
  const maxMonths = (await settings.get(societyId, 'residents.tenancyMaxMonths')) as number;
  const limit = end && start ? new Date(`${start}T00:00:00Z`) : null;
  if (limit) limit.setUTCMonth(limit.getUTCMonth() + maxMonths);
  if (
    !start ||
    !end ||
    end <= start ||
    start < addDaysYmd(today, -365) ||
    (limit && new Date(`${end}T00:00:00Z`) > limit)
  )
    throw rule(422, 'TENANCY_DATES_INVALID', 'The agreement dates are not valid', 'agreementStart');
  await assertFeatureFor(societyId, FEATURE.tenancies);
  const links = await lockLinks(societyId, unitId, t);
  const owner = links.find(l => l.toDate === null && l.relation === 'OWNER');
  if (!owner) throw rule(422, 'OWNER_REQUIRED', 'The flat needs an owner before a tenant', 'relation');
  const resident = (await Resident.findByPk(residentId, { transaction: t }))!;
  if (isMinor(resident.dateOfBirth, today))
    throw rule(422, 'MINOR_NOT_ALLOWED', 'A minor cannot be a tenant', 'dateOfBirth');
  if (
    !(await settings.get(societyId, 'residents.allowMultipleTenancies')) &&
    (await liveTenancyOf(societyId, unitId, t))
  )
    throw rule(409, 'TENANCY_ALREADY_ACTIVE', 'The flat already has a live tenancy', 'relation');
  const moved = start <= today;
  const tenancy = await Tenancy.create(
    {
      societyId,
      unitId,
      tenantResidentId: residentId,
      landlordResidentId: owner.residentId,
      status: moved ? 'ACTIVE' : 'APPROVED',
      agreementType: 'LEAVE_AND_LICENCE',
      agreementStart: start,
      agreementEnd: end,
      agreementRegistrationNo: null,
      monthlyRentPaise: 0,
      securityDepositPaise: 0,
      maintenancePayer: p.payer,
      occupantCount: 1,
      policeVerificationStatus: 'NOT_SUBMITTED',
      policeVerificationRef: null,
      policeVerifiedOn: null,
      policeVerificationNote: null,
      policeReminderSentAt: null,
      source: 'IMPORT',
      submittedAt: null,
      submittedBy: null,
      decidedBy: null,
      decidedAt: now(),
      decisionReason: null,
      moveInDate: moved ? start : null,
      endedOn: null,
      endReason: null,
      endNote: null,
      renewalCount: 0,
      previousAgreementEnd: null,
      lastExpiryReminderDays: null,
      overstayAlertedAt: null,
      version: 1,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  await createLink(
    ctx,
    societyId,
    {
      residentId,
      unitId,
      relation: 'TENANT',
      tenancyId: tenancy.id!,
      isResiding: moved,
      canLogin: true,
      fromDate: start,
      source: 'IMPORT',
    },
    t,
    { internal: true },
  );
}

/** One row inside the caller's transaction. Throws an AppError for a refused row. */
async function applyRow(
  ctx: Ctx,
  societyId: number,
  r: ImportRow,
  p: Parsed,
  group: { lastRow: number; shares: Map<number, string> } | null,
  rowResident: Map<number, number>,
  t: Transaction,
): Promise<Outcome> {
  const unit = await units.getByLabel(societyId, r.flat);
  if (!unit) throw new NotFoundError('UNIT_NOT_FOUND', 'No flat with this label');
  let resident: Resident | null = null;
  if (p.mobile) {
    resident = await Resident.findOne({ where: { societyId, mobile: p.mobile }, transaction: t });
    if (resident && resident.name.trim().toLowerCase() !== p.name.toLowerCase())
      throw rule(409, 'RESIDENT_MOBILE_EXISTS', 'This mobile number belongs to another resident', 'mobile', {
        residentId: resident.id,
      });
  } else {
    const same = await Resident.findAll({ where: { societyId, name: p.name }, transaction: t });
    for (const s of same) {
      const open = await UnitResident.count({
        where: { societyId, unitId: unit.id, residentId: s.id!, relation: p.relation, toDate: null },
        transaction: t,
      });
      if (open) return { codes: [], skipped: true, residentId: s.id! };
    }
  }
  if (resident) {
    const open = await UnitResident.findOne({
      where: { societyId, unitId: unit.id, residentId: resident.id!, toDate: null },
      transaction: t,
    });
    if (open && open.relation === p.relation) {
      rowResident.set(r.row, resident.id!);
      return { codes: [], skipped: true, residentId: resident.id! };
    }
    if (open) throw rule(409, 'LINK_ALREADY_ACTIVE', 'This person is already linked to the flat', 'mobile');
  }
  const today = await societyToday(societyId);
  const fromDate = p.from ?? today;
  let created = false;
  if (!resident) {
    resident = await Resident.create(
      {
        societyId,
        userId: null,
        memberId: null,
        name: p.name,
        mobile: p.mobile,
        alternateMobile: null,
        email: p.email,
        dateOfBirth: p.dob,
        gender: null,
        photoFileId: null,
        preferredLanguage: 'en-IN',
        isNri: false,
        overseasPhone: null,
        localRepresentativeResidentId: null,
        status: 'ACTIVE',
        source: 'IMPORT',
        directoryVisible: true,
        showMobileInDirectory: false,
        showEmailInDirectory: false,
        showPhotoInDirectory: false,
        adminNote: null,
        anonymisedAt: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        deletedAt: null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.residentCreated,
        entityType: ENTITY.resident,
        entityId: resident.id!,
        entityLabel: resident.name,
        societyId,
        after: { name: resident.name, mobile: resident.mobile, source: 'IMPORT' },
      },
      t,
    );
    created = true;
  }
  rowResident.set(r.row, resident.id!);
  if (p.relation === 'TENANT') {
    await units.lockActive(societyId, unit.id, t);
    await importTenancy(ctx, societyId, unit.id, resident.id!, p, t);
  } else {
    const fam = p.relation === 'FAMILY';
    await createLink(
      ctx,
      societyId,
      {
        residentId: resident.id!,
        unitId: unit.id,
        relation: p.relation,
        ...(fam ? { familyRelation: 'RELATIVE' as FamilyRelation } : {}),
        ...(fam || p.relation === 'CARETAKER' ? { householdOf: 'OWNER' as const } : {}),
        ...(p.primary !== undefined ? { isPrimary: p.primary } : {}),
        ...(p.residing !== undefined ? { isResiding: p.residing } : {}),
        fromDate,
        source: 'IMPORT',
      },
      t,
      { skipShareCheck: true },
    );
    if (group && group.lastRow === r.row) {
      const links = await UnitResident.findAll({
        where: {
          societyId,
          unitId: unit.id,
          toDate: null,
          relation: { [Op.in]: ['OWNER', 'CO_OWNER'] },
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      const byResident = new Map<number, string>();
      for (const [row, rid] of rowResident) {
        const s = group.shares.get(row);
        if (s) byResident.set(rid, s);
      }
      const next = links.map(l => ({ l, share: byResident.get(l.residentId) ?? null }));
      if (links.length > 1) {
        assertShares(next.map(n => ({ sharePercent: n.share })));
        for (const n of next) {
          n.l.sharePercent = n.share;
          n.l.version += 1;
          await n.l.save({ transaction: t });
        }
      }
    }
  }
  await syncMembership(ctx, t, resident.id!, { societyId });
  touchReports(t, societyId);
  return { codes: [], residentId: resident.id!, created };
}

const codeOf = (err: unknown): string =>
  (err as { code?: string }).code ??
  ((err as { name?: string }).name === 'SequelizeUniqueConstraintError'
    ? 'LINK_ALREADY_ACTIVE'
    : 'ROW_FAILED');

class DryRunRollback extends Error {}

/** Share groups: rows of one flat with an OWNER or CO_OWNER relation, checked as a whole before any row runs. */
function shareGroups(parsed: Map<number, Parsed>, rows: ImportRow[]) {
  const groups = new Map<string, { rows: number[]; shares: Map<number, string>; lastRow: number }>();
  for (const r of rows) {
    const p = parsed.get(r.row);
    if (!p || (p.relation !== 'OWNER' && p.relation !== 'CO_OWNER')) continue;
    const key = r.flat.trim().toLowerCase();
    const g = groups.get(key) ?? { rows: [] as number[], shares: new Map<number, string>(), lastRow: 0 };
    g.rows.push(r.row);
    if (p.share) g.shares.set(r.row, p.share);
    g.lastRow = r.row;
    groups.set(key, g);
  }
  const invalid = new Set<number>();
  for (const g of groups.values()) {
    if (!g.shares.size) continue;
    const sum = [...g.shares.values()].reduce((a, s) => a + shareCents(s), 0);
    if (g.shares.size !== g.rows.length || sum !== 10000) g.rows.forEach(n => invalid.add(n));
  }
  return { groups, invalid };
}

export async function runImport(d: { jobId: string; requestId: string }): Promise<void> {
  const state = await loadState(d.jobId);
  if (!state || state.status !== 'QUEUED') return;
  state.status = 'RUNNING';
  await saveState(state);
  try {
    const societyId = state.societyId;
    const ctx = await actorCtx(state.userId, d.requestId);
    const commit = state.mode === 'COMMIT';
    const parsed = new Map<number, Parsed>();
    const results = new Map<number, string[]>();
    for (const r of state.rows) {
      const p = parseRow(r);
      if (Array.isArray(p)) results.set(r.row, ['VALIDATION_FAILED']);
      else parsed.set(r.row, p);
    }
    const { groups, invalid } = shareGroups(parsed, state.rows);
    for (const n of invalid) {
      results.set(n, ['OWNERSHIP_SHARE_INVALID']);
      parsed.delete(n);
    }
    const groupOf = (r: ImportRow) => groups.get(r.flat.trim().toLowerCase()) ?? null;
    const rowResident = new Map<number, number>();
    const created: number[] = [];
    const todo = state.rows.filter(r => parsed.has(r.row));
    const run = async (r: ImportRow, t: Transaction): Promise<void> => {
      const g = groupOf(r);
      const o = await applyRow(
        ctx,
        societyId,
        r,
        parsed.get(r.row)!,
        g && g.shares.size ? g : null,
        rowResident,
        t,
      );
      results.set(r.row, o.skipped ? ['ALREADY_IMPORTED'] : ['OK']);
      if (o.created && o.residentId) created.push(o.residentId);
    };
    if (commit) {
      for (const r of todo)
        try {
          await sequelize.transaction(t => run(r, t));
        } catch (err) {
          results.set(r.row, [codeOf(err)]);
        }
    } else {
      try {
        await sequelize.transaction(async t => {
          for (const r of todo) {
            await sequelize.query('SAVEPOINT import_row', { transaction: t });
            try {
              await run(r, t);
            } catch (err) {
              await sequelize.query('ROLLBACK TO SAVEPOINT import_row', { transaction: t });
              results.set(r.row, [codeOf(err)]);
            }
          }
          throw new DryRunRollback();
        });
      } catch (err) {
        if (!(err instanceof DryRunRollback)) throw err;
      }
    }
    if (commit && state.inviteAll)
      for (const id of created)
        try {
          await inviteResident(ctx, societyId, id, {});
        } catch {
          /* a refused invitation is reported by the resident list, not by the import */
        }
    const lines: CsvValue[][] = state.rows.map(r => [
      r.row,
      r.flat,
      r.relation,
      r.name,
      r.mobile ? `${r.mobile.slice(0, 2)}XXXXX${r.mobile.slice(-3)}` : '',
      (results.get(r.row) ?? ['ROW_FAILED']).join(';'),
    ]);
    const file = await societyPorts().files.storeSystemFile({
      societyId,
      purpose: 'EXPORT_FILE',
      content: toCsv(['Row', 'Flat', 'Relation', 'Name', 'Mobile', 'Result'], lines),
      name: `residents-import-${state.jobId}-${istDate(now())}.csv`,
      contentType: 'text/csv',
      ownerUserId: state.userId,
    });
    const ok = [...results.values()].filter(c => c[0] === 'OK' || c[0] === 'ALREADY_IMPORTED').length;
    state.okRows = ok;
    state.errorRows = state.rows.length - ok;
    state.resultFileId = file.fileId;
    state.status = 'COMPLETED';
    state.rows = [];
    await saveState(state);
    await sequelize.transaction(t =>
      audit(
        ctx,
        {
          action: AUDIT.importCompleted,
          entityType: ENTITY.import,
          entityId: state.jobId,
          societyId,
          after: { mode: state.mode, ok, errors: state.errorRows },
        },
        t,
      ),
    );
  } catch (err) {
    logger.error({ err, jobId: d.jobId }, 'residents:import failed');
    state.status = 'FAILED';
    state.failure = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
    state.rows = [];
    await saveState(state);
  } finally {
    await kv().cacheDel(lockKey(state.societyId));
  }
}
