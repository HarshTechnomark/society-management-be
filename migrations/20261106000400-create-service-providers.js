'use strict';
/** Module 07 section 7.4: service providers (SMS, WhatsApp, email, push, payment gateway, storage, IVR). Paranoid. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE service_providers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        providerKey VARCHAR(40) NOT NULL,
        channel VARCHAR(20) NOT NULL,
        vendor VARCHAR(20) NOT NULL,
        displayName VARCHAR(80) NOT NULL,
        description VARCHAR(200) NULL,
        isEnabled TINYINT(1) NOT NULL DEFAULT 0,
        priority TINYINT UNSIGNED NULL,
        credentialsSource VARCHAR(10) NOT NULL DEFAULT 'DATABASE',
        configJson JSON NOT NULL,
        credentialsEnc VARBINARY(4200) NULL,
        credentialsIv BINARY(12) NULL,
        credentialsTag BINARY(16) NULL,
        credentialsKeyVersion TINYINT UNSIGNED NULL,
        credentialsMasked JSON NULL,
        credentialsUpdatedAt DATETIME(3) NULL,
        credentialsUpdatedBy BIGINT UNSIGNED NULL,
        healthStatus VARCHAR(12) NOT NULL DEFAULT 'UNKNOWN',
        statusMode VARCHAR(10) NOT NULL DEFAULT 'AUTOMATIC',
        statusReason VARCHAR(300) NULL,
        statusChangedAt DATETIME(3) NULL,
        consecutiveFailures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        degradedLatencyMs INT UNSIGNED NOT NULL DEFAULT 3000,
        lastCheckAt DATETIME(3) NULL,
        lastCheckOk TINYINT(1) NULL,
        lastCheckLatencyMs INT UNSIGNED NULL,
        lastCheckError VARCHAR(300) NULL,
        uptime30dPct DECIMAL(6,3) NULL,
        lastTestAt DATETIME(3) NULL,
        lastTestOk TINYINT(1) NULL,
        lastTestBy BIGINT UNSIGNED NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        deletedAt DATETIME(3) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_sp_key (providerKey),
        UNIQUE KEY uq_sp_channel_priority (channel, priority),
        KEY ix_sp_channel_enabled (channel, isEnabled),
        CONSTRAINT ck_sp_channel CHECK (channel IN ('SMS','WHATSAPP','EMAIL','PUSH','PAYMENT_GATEWAY','STORAGE','IVR')),
        CONSTRAINT ck_sp_vendor CHECK (vendor IN ('MSG91','GUPSHUP','KALEYRA','META_CLOUD','AWS_SES','SENDGRID','WEB_PUSH_VAPID','RAZORPAY','CASHFREE','S3_COMPATIBLE','EXOTEL','FAKE')),
        CONSTRAINT ck_sp_source CHECK (credentialsSource IN ('DATABASE','ENV')),
        CONSTRAINT ck_sp_health CHECK (healthStatus IN ('OPERATIONAL','DEGRADED','OUTAGE','UNKNOWN')),
        CONSTRAINT ck_sp_mode CHECK (statusMode IN ('AUTOMATIC','MANUAL')),
        CONSTRAINT ck_sp_priority CHECK (priority IS NULL OR priority BETWEEN 1 AND 9),
        CONSTRAINT ck_sp_latency CHECK (degradedLatencyMs BETWEEN 500 AND 30000),
        CONSTRAINT ck_sp_uptime CHECK (uptime30dPct IS NULL OR uptime30dPct BETWEEN 0 AND 100),
        CONSTRAINT ck_sp_credentials CHECK (
          (credentialsEnc IS NULL) = (credentialsIv IS NULL)
          AND (credentialsEnc IS NULL) = (credentialsTag IS NULL)
          AND (credentialsEnc IS NULL) = (credentialsKeyVersion IS NULL))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS service_providers');
  },
};
