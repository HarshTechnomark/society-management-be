'use strict';
/** Module 09 section 7.10: one emergency profile per resident. The medical notes are AES-256-GCM bytes (`iv(12) || tag(16) || ciphertext`). */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE emergency_profiles (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        residentId BIGINT UNSIGNED NOT NULL,
        bloodGroup VARCHAR(8) NULL,
        medicalNotesEnc VARBINARY(2048) NULL,
        isSeniorCitizen TINYINT(1) NOT NULL DEFAULT 0,
        isDifferentlyAbled TINYINT(1) NOT NULL DEFAULT 0,
        mobilityNote VARCHAR(200) NULL,
        preferredHospital VARCHAR(120) NULL,
        contact1Name VARCHAR(120) NULL,
        contact1Relation VARCHAR(40) NULL,
        contact1Mobile CHAR(10) NULL,
        contact2Name VARCHAR(120) NULL,
        contact2Relation VARCHAR(40) NULL,
        contact2Mobile CHAR(10) NULL,
        contact3Name VARCHAR(120) NULL,
        contact3Relation VARCHAR(40) NULL,
        contact3Mobile CHAR(10) NULL,
        consentGivenAt DATETIME(3) NULL,
        consentTextVersion VARCHAR(10) NULL,
        consentByUserId BIGINT UNSIGNED NULL,
        consentWithdrawnAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_ep_resident (residentId),
        KEY ix_ep_society (societyId),
        CONSTRAINT fk_ep_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_ep_resident FOREIGN KEY (residentId) REFERENCES residents (id) ON DELETE CASCADE,
        CONSTRAINT ck_ep_blood CHECK (bloodGroup IS NULL OR bloodGroup IN ('A_POS','A_NEG','B_POS','B_NEG','AB_POS','AB_NEG','O_POS','O_NEG','UNKNOWN')),
        CONSTRAINT ck_ep_flags CHECK (isSeniorCitizen IN (0,1) AND isDifferentlyAbled IN (0,1)),
        CONSTRAINT ck_ep_contact1 CHECK (contact1Mobile IS NULL OR REGEXP_LIKE(contact1Mobile, '^[6-9][0-9]{9}$', 'c')),
        CONSTRAINT ck_ep_contact2 CHECK (contact2Mobile IS NULL OR REGEXP_LIKE(contact2Mobile, '^[6-9][0-9]{9}$', 'c')),
        CONSTRAINT ck_ep_contact3 CHECK (contact3Mobile IS NULL OR REGEXP_LIKE(contact3Mobile, '^[6-9][0-9]{9}$', 'c')),
        CONSTRAINT ck_ep_consent CHECK (consentGivenAt IS NOT NULL OR (bloodGroup IS NULL AND medicalNotesEnc IS NULL AND isSeniorCitizen = 0 AND isDifferentlyAbled = 0 AND mobilityNote IS NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS emergency_profiles');
  },
};
