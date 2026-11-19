'use strict';
/** Module 16 section 7.3: `notification_templates`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE notification_templates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        templateKey VARCHAR(80) NOT NULL,
        locale VARCHAR(10) NOT NULL DEFAULT 'en-IN',
        module CHAR(2) NOT NULL,
        scope VARCHAR(10) NOT NULL,
        category VARCHAR(12) NOT NULL,
        deliveryClass VARCHAR(15) NOT NULL DEFAULT 'STANDARD',
        defaultChannels JSON NOT NULL,
        allowedChannels JSON NOT NULL,
        variablesSchema JSON NOT NULL,
        countsTowardLimit TINYINT(1) NOT NULL DEFAULT 1,
        allowEndedMembers TINYINT(1) NOT NULL DEFAULT 0,
        sendWhenClosed TINYINT(1) NOT NULL DEFAULT 0,
        deepLink VARCHAR(300) NULL,
        inAppTitle VARCHAR(150) NULL,
        inAppBody VARCHAR(1000) NULL,
        pushTitle VARCHAR(80) NULL,
        pushBody VARCHAR(200) NULL,
        smsBody VARCHAR(500) NULL,
        smsDltTemplateId VARCHAR(25) NULL,
        smsDltCategory VARCHAR(20) NULL,
        whatsappTemplateName VARCHAR(60) NULL,
        whatsappCategory VARCHAR(15) NULL,
        whatsappParams JSON NULL,
        whatsappButtonVar VARCHAR(40) NULL,
        whatsappStatus VARCHAR(12) NULL,
        emailSubject VARCHAR(150) NULL,
        emailHtml MEDIUMTEXT NULL,
        emailText TEXT NULL,
        isActive TINYINT(1) NOT NULL DEFAULT 1,
        textEditedAt DATETIME(3) NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_templates_key_locale (templateKey, locale),
        KEY ix_templates_module (module, templateKey),
        CONSTRAINT ck_templates_scope CHECK (scope IN ('USER','SOCIETY','PLATFORM')),
        CONSTRAINT ck_templates_category CHECK (category IN ('ACCOUNT','SECURITY','BILLING','PAYMENTS','NOTICES','EMERGENCY','VISITORS','HELPDESK','APPROVALS','COMMUNITY','GOVERNANCE','SYSTEM','PLATFORM')),
        CONSTRAINT ck_templates_class CHECK (deliveryClass IN ('OTP','SAFETY','SECURITY','TRANSACTIONAL','STANDARD')),
        CONSTRAINT ck_templates_dlt_category CHECK (smsDltCategory IS NULL OR smsDltCategory IN ('SERVICE_IMPLICIT','SERVICE_EXPLICIT','TRANSACTIONAL')),
        CONSTRAINT ck_templates_wa_category CHECK (whatsappCategory IS NULL OR whatsappCategory IN ('UTILITY','AUTHENTICATION')),
        CONSTRAINT ck_templates_wa_status CHECK (whatsappStatus IS NULL OR whatsappStatus IN ('PENDING','APPROVED','REJECTED','PAUSED'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS notification_templates');
  },
};
