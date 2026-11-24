-- Cached summary of the plan-vs-actual execution analysis (packages/core workout/execution.ts) so
-- calendar chips can show a state derived from the step-by-step score without decoding streams.
-- The full analysis is computed on read by the detail endpoints; a row is valid only while its
-- fingerprint (analysis version, workout + activity ids and updatedAt, thresholds) still matches.
CREATE TABLE workout_execution (
  workout_id  TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  method      TEXT NOT NULL,   -- laps | streams | session
  score       REAL NOT NULL,   -- 0–100
  state       TEXT NOT NULL,   -- ComplianceState
  computed_at TEXT NOT NULL
);
