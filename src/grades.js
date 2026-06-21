// ============================================================================
// Grade helpers — bridge the normalized `grades` dimension (grade_code) and the
// app's in-memory { grading_company, grade } fields.
//
// grade_code is the composite the DB stores on collected_cards.grade_code and
// sales.grade_code, e.g. 'PSA 10', 'BGS 9.5', 'BGS BL', 'RAW'.
//
// Black Label is modeled as grade === 'BL' (a real grade token) — there is NO
// separate bgs_black flag anywhere in the app. `grade` is a number for numeric
// grades (10, 9.5) and the string 'BL' for Beckett Black Label.
//
// These are pure + deterministic, so the app never needs to JOIN the grades
// table at read time to render a grade.
// ============================================================================

import { store } from './storage.js';

const COMPANY_FULL = {
  PSA: 'Professional Sports Authenticator',
  BGS: 'Beckett Grading Services',
  CGC: 'Certified Guaranty Company',
  SGC: 'Sportscard Guaranty Corporation',
};

const isBL = (grade) => String(grade).trim().toUpperCase() === 'BL';

// Render a grade token for the code: 'BL' stays 'BL', numerics drop trailing
// zeros ('10', '9.5').
const gradeToken = (grade) => {
  if (isBL(grade)) return 'BL';
  const n = Number(grade);
  return Number.isFinite(n) ? String(n) : String(grade).trim();
};

// { grading_company, grade } -> grade_code. Ungraded (no company or no grade)
// maps to 'RAW'.
export function fieldsToGradeCode(company, grade) {
  if (!company || grade === null || grade === undefined || grade === '') return 'RAW';
  return `${String(company).trim().toUpperCase()} ${gradeToken(grade)}`;
}

// grade_code -> { grading_company, grade }. Inverse of the above. Numeric grades
// come back as numbers; Black Label comes back as the string 'BL'; 'RAW' (or
// empty) yields nulls.
export function gradeCodeToFields(code) {
  if (!code || code === 'RAW') return { grading_company: null, grade: null };
  const sp = String(code).indexOf(' ');
  if (sp < 0) return { grading_company: null, grade: null };
  const company = code.slice(0, sp);
  const token = code.slice(sp + 1).trim();
  const grade = isBL(token) ? 'BL' : (Number.isFinite(Number(token)) ? Number(token) : token);
  return { grading_company: company, grade };
}

// Best-effort: make sure the global `grades` dimension carries this code. The
// app never reads grades to render (gradeCodeToFields is authoritative), so
// failures (e.g. duplicate PK) are ignored.
export async function ensureGrade(company, grade) {
  const grade_code = fieldsToGradeCode(company, grade);
  if (grade_code === 'RAW') return;
  const nick = String(company).trim().toUpperCase();
  try {
    await store.insert('grades', {
      grade_code,
      company: COMPANY_FULL[nick] || null,
      company_nickname: nick,
      grade_value: gradeToken(grade),
    });
  } catch { /* best-effort */ }
}
