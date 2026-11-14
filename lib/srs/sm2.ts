import { addCalendarDaysInZone } from "../timezone";

export interface SM2Input {
  easeFactor: number;
  interval: number;
  repetitions: number;
  rating: number;
  /**
   * IANA time zone of the user (e.g. "Asia/Hong_Kong"). When given, the
   * next-review boundary is that zone's local midnight, stored as UTC.
   * Omitted -> legacy server-local boundary (old clients, tests).
   */
  timezone?: string;
  /** Reference "now"; defaults to the current time. */
  now?: Date;
}

export interface SM2Output {
  easeFactor: number;
  interval: number;
  repetitions: number;
  nextReviewDate: Date;
}

export function sm2Algorithm(input: SM2Input): SM2Output {
  const { easeFactor, interval, repetitions, rating, timezone, now } = input;
  
  let newEaseFactor = easeFactor;
  let newInterval = interval;
  let newRepetitions = repetitions;
  
  if (rating >= 3) {
    if (repetitions === 0) {
      newInterval = 1;
    } else if (repetitions === 1) {
      newInterval = 6;
    } else {
      newInterval = Math.round(interval * easeFactor);
    }
    newRepetitions = repetitions + 1;
  } else {
    newRepetitions = 0;
    newInterval = 1;
  }
  
  newEaseFactor = Math.max(
    1.3,
    easeFactor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))
  );
  
  const referenceNow = now ?? new Date();
  let nextReviewDate: Date;
  if (timezone) {
    // "Today + interval days" on the user's calendar, at their local
    // midnight, expressed as the exact UTC instant for storage.
    nextReviewDate = addCalendarDaysInZone(timezone, referenceNow, newInterval);
  } else {
    // Legacy behavior (server-local midnight) when no timezone is supplied.
    nextReviewDate = new Date(referenceNow);
    nextReviewDate.setDate(nextReviewDate.getDate() + newInterval);
    nextReviewDate.setHours(0, 0, 0, 0);
  }
  
  return {
    easeFactor: newEaseFactor,
    interval: newInterval,
    repetitions: newRepetitions,
    nextReviewDate,
  };
}

export function getInitialSM2State(): Pick<SM2Input, "easeFactor" | "interval" | "repetitions"> {
  return {
    easeFactor: 2.5,
    interval: 0,
    repetitions: 0,
  };
}

export function formatDateForDB(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function parseRating(rating: "again" | "hard" | "good" | "easy"): number {
  switch (rating) {
    case "again": return 0;
    case "hard": return 3;
    case "good": return 4;
    case "easy": return 5;
    default: return 3;
  }
}
