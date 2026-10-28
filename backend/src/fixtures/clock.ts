// backend/src/fixtures/clock.ts
export const FIXED_NOW = new Date("2026-03-02T09:00:00Z"); // Monday, week 1 of the comparison cohort

export function fixedClock() {
  return {
    now: () => new Date(FIXED_NOW)
  };
}

