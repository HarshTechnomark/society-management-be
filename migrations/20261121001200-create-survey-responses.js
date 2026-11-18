'use strict';
/** Module 16 section 7.12: `survey_responses`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE survey_responses (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        surveyId BIGINT UNSIGNED NOT NULL,
        questionId BIGINT UNSIGNED NOT NULL,
        submissionId CHAR(36) NOT NULL,
        respondentKey CHAR(64) NOT NULL,
        userId BIGINT UNSIGNED NULL,
        unitId BIGINT UNSIGNED NULL,
        optionKey VARCHAR(4) NULL,
        numberValue INT NULL,
        textValue VARCHAR(1000) NULL,
        dateValue DATE NULL,
        answerKey VARCHAR(4) GENERATED ALWAYS AS (COALESCE(optionKey, '-')) STORED NOT NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_survey_answer (surveyId, respondentKey, questionId, answerKey),
        KEY ix_survey_resp_question (surveyId, questionId, optionKey),
        KEY ix_survey_resp_respondent (surveyId, respondentKey),
        CONSTRAINT fk_survey_resp_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_survey_resp_survey FOREIGN KEY (surveyId) REFERENCES surveys (id) ON DELETE RESTRICT,
        CONSTRAINT fk_survey_resp_question FOREIGN KEY (questionId) REFERENCES survey_questions (id) ON DELETE RESTRICT,
        CONSTRAINT fk_survey_resp_user FOREIGN KEY (userId) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT fk_survey_resp_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS survey_responses');
  },
};
