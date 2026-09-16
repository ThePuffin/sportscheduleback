import { ColorsTeamEnum } from './ColorsTeam';
import { CollegeLeague } from './enum';

export interface TeamColors {
  color: string;
  backgroundColor: string;
}

// Placeholder used whenever a team's real colors could not be retrieved.
export const DEFAULT_TEAM_COLORS: TeamColors = {
  color: '#ffffff',
  backgroundColor: '#000000',
};

// Leagues whose teams represent universities. A university keeps the same
// colors across sports, so a missing/placeholder entry can be borrowed from
// another one of these leagues (e.g. NCAAB-X -> NCAAF-X / NCAAMH-X ...).
export const COLLEGE_LEAGUES: string[] = Object.values(CollegeLeague);

const normalizeHex = (hex: string = '') => hex.trim().toLowerCase();

export const isDefaultTeamColors = (
  colors?: Partial<TeamColors> | null,
): boolean =>
  !!colors &&
  normalizeHex(colors.color) === DEFAULT_TEAM_COLORS.color &&
  normalizeHex(colors.backgroundColor) === DEFAULT_TEAM_COLORS.backgroundColor;

/**
 * Safeguard: a pair where `color` is identical to `backgroundColor` (or the
 * `#NULL` artifact) is unusable for display. Such entries are treated as
 * "unknown" everywhere, exactly like the default placeholder.
 */
export const isDegenerateTeamColors = (
  colors?: Partial<TeamColors> | null,
): boolean => {
  if (!colors) return false;
  const color = normalizeHex(colors.color);
  const backgroundColor = normalizeHex(colors.backgroundColor);
  if (!color || !backgroundColor) return false;
  if (color === '#null' || backgroundColor === '#null') return true;
  return color === backgroundColor;
};

export const Colors: Record<string, TeamColors> = {
  default: DEFAULT_TEAM_COLORS,
  ...ColorsTeamEnum,
};

/**
 * Resolves the colors of a team from its `uniqueId` (`{LEAGUE}-{ABBREV}`).
 *
 * - Known, non-placeholder entry => returned as-is.
 * - University (college) league with a placeholder/missing entry => the same
 *   university abbreviation is looked up in the other college leagues and the
 *   first real entry wins.
 * - Anything else (non-college leagues included) => `Colors.default`.
 */
export const getTeamColors = (uniqueId: string): TeamColors => {
  const isUsable = (colors?: Partial<TeamColors> | null): boolean =>
    !!colors && !isDefaultTeamColors(colors) && !isDegenerateTeamColors(colors);

  const directColors = uniqueId ? Colors[uniqueId] : undefined;
  if (isUsable(directColors)) {
    return directColors;
  }

  const league = COLLEGE_LEAGUES.find((candidate) =>
    uniqueId?.startsWith(`${candidate}-`),
  );

  if (league) {
    const abbrev = uniqueId.slice(league.length + 1);
    for (const otherLeague of COLLEGE_LEAGUES) {
      if (otherLeague === league) continue;
      const crossLeagueColors = Colors[`${otherLeague}-${abbrev}`];
      if (isUsable(crossLeagueColors)) {
        return crossLeagueColors;
      }
    }
  }

  // Safeguard: never return a degenerate (color === background) entry.
  return isUsable(directColors) ? directColors! : DEFAULT_TEAM_COLORS;
};
