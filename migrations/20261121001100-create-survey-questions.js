'use strict';
/** Module 16 section 7.11: `survey_questions`. */
module.exports = {
  async up(qi) {
    await qi.sequelize.query(`
      CREATE TABLE survey_questions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        societyId BIGINT UNSIGNED NOT NULL,
        surveyId BIGINT UNSIGNED NOT NULL,
        position TINYINT UNSIGNED NOT NULL,
        type VARCHAR(15) NOT NULL,
        prompt VARCHAR(300) NOT NULL,
        helpText VARCHAR(300) NULL,
        isRequired TINYINT(1) NOT NULL DEFAULT 1,
        options JSON NULL,
        maxSelections TINYINT UNSIGNED NULL,
        \`minValue\` INT NULL,
        \`maxValue\` INT NULL,
        maxLength SMALLINT UNSIGNED NULL,
        createdBy BIGINT UNSIGNED NULL,
        updatedBy BIGINT UNSIGNED NULL,
        createdAt DATETIME(3) NOT NULL,
        updatedAt DATETIME(3) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_survey_q_position (surveyId, position),
        CONSTRAINT fk_survey_q_society FOREIGN KEY (societyId) REFERENCES societies (id) ON DELETE RESTRICT,
        CONSTRAINT fk_survey_q_survey FOREIGN KEY (surveyId) REFERENCES surveys (id) ON DELETE CASCADE,
        CONSTRAINT ck_survey_q_position CHECK (position BETWEEN 1 AND 30),
        CONSTRAINT ck_survey_q_type CHECK (type IN ('SINGLE_CHOICE','MULTI_CHOICE','YES_NO','RATING','NPS','NUMBER','TEXT','DATE'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  },
  async down(qi) {
    await qi.sequelize.query('DROP TABLE IF EXISTS survey_questions');
  },
};
