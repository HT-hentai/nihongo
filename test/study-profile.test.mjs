import test from "node:test";
import assert from "node:assert/strict";
import {
  allPlanLevelsForProfile,
  diagnosticLevelsForProfile,
  mainLevelsForProfile,
  normalizeStudyProfile,
} from "../src/study-profile.mjs";

test("study profile keeps current-level review and target-level main path stable", () => {
  const profile = normalizeStudyProfile({
    currentLevel: "N4",
    targetLevel: "N2",
    dailyMinutes: 240,
    examDate: "2026-07-05",
    startDate: "2026-05-17",
  });

  assert.deepEqual(diagnosticLevelsForProfile(profile), ["N5", "N4"]);
  assert.deepEqual(mainLevelsForProfile(profile), ["N3", "N2"]);
  assert.deepEqual(allPlanLevelsForProfile(profile), ["N5", "N4", "N3", "N2"]);
});

test("study profile clamps invalid target and daily capacity", () => {
  const profile = normalizeStudyProfile({
    currentLevel: "N2",
    targetLevel: "N4",
    dailyMinutes: 999,
  });

  assert.equal(profile.targetLevel, "N2");
  assert.equal(profile.dailyMinutes, 480);
  assert.deepEqual(mainLevelsForProfile(profile), ["N2"]);
});
