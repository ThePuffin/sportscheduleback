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
  const directColors = uniqueId ? Colors[uniqueId] : undefined;
  if (directColors && !isDefaultTeamColors(directColors)) {
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
      if (crossLeagueColors && !isDefaultTeamColors(crossLeagueColors)) {
        return crossLeagueColors;
      }
    }
  }

  return directColors ?? DEFAULT_TEAM_COLORS;
};
