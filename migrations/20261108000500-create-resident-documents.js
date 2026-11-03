'use strict';
/** Module 09 section 7.4: KYC and request documents (metadata; the bytes live in module 01 files). Paranoid. No foreign key on `fileId` until the files table exists. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE resident_documents (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        residentId BIGINT UNSIGNED NULL,
        unitId BIGINT UNSIGNED NULL,
        refType VARCHAR(20) NULL,
        refId BIGINT UNSIGNED NULL,
        docType VARCHAR(26) NOT NULL,
        fileId BIGINT UNSIGNED NOT NULL,
        title VARCHAR(120) NULL,
        idLast4 CHAR(4) NULL,
        expiresOn DATE NULL,
        verificationStatus VARCHAR(10) NOT NULL DEFAULT 'PENDING',
        verifiedBy BIGINT UNSIGNED NULL,
        verifiedAt DATETIME(3) NULL,
        rejectReason VARCHAR(300) NULL,
        uploadedByUserId BIGINT UNSIGNED NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_rd_file (fileId),
        KEY ix_rd_resident (societyId, residentId, docType),
        KEY ix_rd_ref (societyId, refType, refId),
        KEY ix_rd_pending (societyId, verificationStatus, createdAt),
        KEY ix_rd_unit (unitId),
        KEY ix_rd_resident_id (residentId),
        KEY ix_rd_uploader (uploadedByUserId),
        CONSTRAINT fk_rd_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_rd_resident FOREIGN KEY (residentId) REFERENCES residents (id) ON DELETE RESTRICT,
        CONSTRAINT fk_rd_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT fk_rd_uploader FOREIGN KEY (uploadedByUserId) REFERENCES users (id) ON DELETE RESTRICT,
        CONSTRAINT ck_rd_ref_type CHECK (refType IS NULL OR refType IN ('tenancy','move_request','renovation_permit','ownership_transfer','join_request','pet')),
        CONSTRAINT ck_rd_doc_type CHECK (docType IN ('AADHAAR','PAN','PASSPORT','DRIVING_LICENCE','VOTER_ID','OTHER_ID','ADDRESS_PROOF','RENT_AGREEMENT','POLICE_VERIFICATION','SALE_DEED','INDEX_II','STAMP_DUTY_RECEIPT','ORIGINAL_SHARE_CERTIFICATE','MEMBERSHIP_APPLICATION','NOC','DEATH_CERTIFICATE','SUCCESSION_CERTIFICATE','CONTRACTOR_ID','WORK_PLAN','STRUCTURAL_CERTIFICATE','VACCINATION_CERTIFICATE','OTHER')),
        CONSTRAINT ck_rd_status CHECK (verificationStatus IN ('PENDING','VERIFIED','REJECTED')),
        CONSTRAINT ck_rd_last4 CHECK (idLast4 IS NULL OR REGEXP_LIKE(idLast4, '^[0-9A-Z]{4}$', 'c')),
        CONSTRAINT ck_rd_owner CHECK (residentId IS NOT NULL OR refType = 'join_request'),
        CONSTRAINT ck_rd_ref CHECK ((refType IS NULL) = (refId IS NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS resident_documents');
  },
};
