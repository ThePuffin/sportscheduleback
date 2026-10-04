/**
 * Game status constants shared by the score cycle and the stale-game purge.
 *
 * A status is "terminal" when the game reached a decided state: it was played,
 * cancelled or postponed. Anything else (`SCHEDULED`, `IN_PROGRESS`, `DELAYED`,
 * a live period/clock, ...) means the result is still to be recovered.
 *
 * The exact spelling varies with the source and the era of the record:
 * - `GameService._resolveStatus()` writes the canonical uppercase values.
 * - The ESPN team-schedule path normalizes through `resolveScheduleGameStatus()`,
 *   which also emits `FINISHED` for `STATUS_FINAL_AET` / `STATUS_FINAL_PEN`.
 * - Legacy or third-party records may still carry differently cased or suffixed
 *   values (`"final"`, `"FINAL AET"`, `"Full Time"`), hence the regex check below.
 */

/** Canonical terminal statuses, used directly in Mongo `$nin` queries. */
export const TERMINAL_GAME_STATUSES = [
  'FINISHED',
  'FINAL',
  'CANCELLED',
  'POSTPONED',
];

/**
 * Whether `status` describes a decided game.
 *
 * Matches the canonical values plus their suffixed variants (`FINAL AET`,
 * `FINAL PEN`, `FULL TIME`) so a game that was fully played is never mistaken
 * for a stuck one, whatever the case or suffix used by its source.
 */
export const isTerminalGameStatus = (status?: string | null): boolean => {
  if (!status) return false;
  return /^\s*(FINISHED|FINAL\b|FULL[\s_-]?TIME|CANCELLED|CANCELED|POSTPONED)\b/i.test(
    status,
  );
};
