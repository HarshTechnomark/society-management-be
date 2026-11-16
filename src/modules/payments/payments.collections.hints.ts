/**
 * In-process hint for the module 11 fund resolver of `collection_request` invoices (BR-11-49a): while `invoices.createAdHoc`
 * runs inside the publish transaction the request row is not committed, so the resolver (another connection) cannot read it.
 * The publish code sets the collection's fund here for the request id; the resolver (`fundOfRequest`) looks here first.
 */
export const requestFundHint = new Map<number, number>();
