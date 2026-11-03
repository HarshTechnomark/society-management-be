'use strict';
/** Module 09 section 7.9: the pets register. Paranoid. No foreign key on `photoFileId` until the files table exists. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE pets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        unitId BIGINT UNSIGNED NOT NULL,
        ownerResidentId BIGINT UNSIGNED NOT NULL,
        name VARCHAR(60) NOT NULL,
        species VARCHAR(8) NOT NULL,
        breed VARCHAR(60) NULL,
        gender VARCHAR(8) NOT NULL DEFAULT 'UNKNOWN',
        colour VARCHAR(40) NULL,
        dateOfBirth DATE NULL,
        photoFileId BIGINT UNSIGNED NULL,
        licenceNo VARCHAR(40) NULL,
        isNeutered TINYINT(1) NULL,
        temperamentNote VARCHAR(200) NULL,
        lastVaccineName VARCHAR(80) NULL,
        lastVaccinatedOn DATE NULL,
        vaccinationValidUntil DATE NULL,
        vaccinationReminderFor DATE NULL,
        status VARCHAR(8) NOT NULL DEFAULT 'ACTIVE',
        inactiveReason VARCHAR(16) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        KEY ix_pets_unit (societyId, unitId, status),
        KEY ix_pets_vacc (societyId, status, vaccinationValidUntil),
        KEY ix_pets_owner (ownerResidentId),
        KEY ix_pets_unit_id (unitId),
        CONSTRAINT fk_pets_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_pets_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT,
        CONSTRAINT fk_pets_owner FOREIGN KEY (ownerResidentId) REFERENCES residents (id) ON DELETE RESTRICT,
        CONSTRAINT ck_pets_species CHECK (species IN ('DOG','CAT','BIRD','RABBIT','FISH','OTHER')),
        CONSTRAINT ck_pets_gender CHECK (gender IN ('MALE','FEMALE','UNKNOWN')),
        CONSTRAINT ck_pets_neutered CHECK (isNeutered IS NULL OR isNeutered IN (0,1)),
        CONSTRAINT ck_pets_status CHECK (status IN ('ACTIVE','INACTIVE')),
        CONSTRAINT ck_pets_reason CHECK (inactiveReason IS NULL OR inactiveReason IN ('MOVED_OUT','DECEASED','REHOMED','OTHER')),
        CONSTRAINT ck_pets_vaccination CHECK (vaccinationValidUntil IS NULL OR lastVaccinatedOn IS NULL OR vaccinationValidUntil >= lastVaccinatedOn)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS pets');
  },
};
