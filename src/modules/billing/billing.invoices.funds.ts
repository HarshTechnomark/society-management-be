/** Fund resolvers by `refType` (module 12 registers `collection_request`); used for the fund of a `COLLECTION` line (BR-11-49a). */
export const fundResolvers = new Map<string, (societyId: number, refId: number) => Promise<number | null>>();
