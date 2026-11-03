import { z } from 'zod';
import { mobileSchema } from '../auth/auth.normalise';
import {
  PERMIT_DOC_TYPES,
  PERMIT_STATUSES,
  VIOLATION_CATEGORIES,
  WORK_CATEGORIES,
} from './residents.part3.constants';
import { docItem, hhmm, id, idParam, listPage, text, version, ymd } from './residents.part3.validation';

/** Zod schemas of renovation permits (section 8.16). Bodies are `.strict()`. */
const permitFields = {
  workCategory: z.enum(WORK_CATEGORIES),
  workDescription: text(10, 1000, 'Description'),
  involvesStructuralChange: z.boolean().optional(),
  contractorName: text(2, 120, 'Name'),
  contractorCompany: text(2, 150, 'Company').nullable().optional(),
  contractorMobile: mobileSchema,
  workerCount: z.number().int().min(1).max(50),
  startDate: ymd,
  endDate: ymd,
  dailyStartTime: hhmm,
  dailyEndTime: hhmm,
};
const files = z.array(docItem(PERMIT_DOC_TYPES)).min(1).max(6);

const create = z.object({ unitId: id, ...permitFields, fileIds: files }).strict();
/** The resident app edit after changes were requested: the create fields except `unitId`, plus `version`. */
const resubmit = z.object({ ...permitFields, fileIds: files.optional(), version }).strict();

const patch = z
  .object({
    conditions: text(0, 1000, 'Conditions').nullable().optional(),
    contractorName: permitFields.contractorName.optional(),
    contractorCompany: permitFields.contractorCompany,
    contractorMobile: permitFields.contractorMobile.optional(),
    workerCount: permitFields.workerCount.optional(),
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');

const versionOnly = z.object({ version }).strict();
const extend = z.object({ endDate: ymd, reason: text(5, 300, 'Reason'), version }).strict();
const violation = z
  .object({
    category: z.enum(VIOLATION_CATEGORIES),
    note: text(5, 500, 'Note'),
    stopWork: z.boolean().default(false),
    finePaise: z.number().int().min(0).max(10_000_000).default(0),
    version,
  })
  .strict();
const suspend = z.object({ reason: text(5, 500, 'Reason'), version }).strict();
const resume = z.object({ note: text(0, 300, 'Note').optional(), version }).strict();
const workDone = z.object({ note: text(0, 300, 'Note').optional(), version }).strict();
const inspect = z
  .object({
    result: z.enum(['PASSED', 'FAILED']),
    note: text(5, 500, 'Note'),
    damageDeductionPaise: z.number().int().min(0).default(0),
    version,
  })
  .strict();
const cancel = z.object({ reason: text(5, 300, 'Reason'), version }).strict();

const list = z.object({
  ...listPage,
  status: z.enum(PERMIT_STATUSES).optional(),
  unitId: id.optional(),
  activeOn: ymd.optional(),
  sortBy: z.enum(['startDate', 'createdAt']).default('startDate'),
});
const gate = z.object({ date: ymd.optional() });

export const permitSchemas = {
  idParam,
  create,
  resubmit,
  patch,
  versionOnly,
  extend,
  violation,
  suspend,
  resume,
  workDone,
  inspect,
  cancel,
  list,
  gate,
};
