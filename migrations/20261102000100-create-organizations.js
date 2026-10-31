'use strict';
/** Module 01 section 7.1: optional grouping of societies (Enterprise). Added on the module 03 branch because module 01 was structure only. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE organizations (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(150) NOT NULL,
        slug VARCHAR(60) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        gstin VARCHAR(15) NULL,
        contactEmail VARCHAR(254) NULL,
        contactMobile CHAR(10) NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_organizations_slug (slug),
        CONSTRAINT ck_organizations_status CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
        CONSTRAINT ck_organizations_slug CHECK (slug REGEXP '^[a-z0-9]+(-[a-z0-9]+)*$'),
        CONSTRAINT ck_organizations_mobile CHECK (contactMobile IS NULL OR contactMobile REGEXP '^[6-9][0-9]{9}$')
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS organizations');
  },
};
