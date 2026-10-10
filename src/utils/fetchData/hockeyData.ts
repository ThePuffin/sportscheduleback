import { League } from '../../utils/enum';
import type { GameFormatted } from '../../utils/interface/game';
import type { NHLGameAPI } from '../../utils/interface/gameNHL';
import type {
  PWHLResponse,
  TeamNHL,
  TeamPWHL,
  TeamType,
} from '../../utils/interface/team';
import { getTeamColors } from '../Colors';
import { PWHLGameAPI } from '../interface/gamePWHL';
import { capitalize, getLuminance } from '../utils';
const leagueName = League.NHL;
const pwhlAPI = 'https://lscluster.hockeytech.com/feed/';

/**
 * Known PWHL team-code aliases -> canonical code.
 *
 * The HockeyTech feed is internally inconsistent about the Las Vegas team:
 * the `teamsbyseason` feed and the **pre-season** schedule use `VEG`, while the
 * **regular-season** schedule and its standings use `VGS` (and some feeds have
 * used `LV`). Left untouched, the same team is emitted under several IDs
 * (`PWHL-VEG`, `PWHL-VGS`, `PWHL-LV`), which breaks the team-name/colour lookup,
 * the favourites list, the record tallies and every schedule match.
 *
 * `VGS` is the canonical code: it is the code used by the **regular season**
 * (by far the largest set of games) and its standings feed, so it is the most
 * representative reference for the team.
 */
const PWHL_CODE_ALIASES: Record<string, string> = {
  VEG: 'VGS',
  LV: 'VGS',
};

/**
 * Fold a raw PWHL team code onto its canonical form so that every feed
 * (teams, pre-season, regular season, standings) describes the same team.
 * Codes without a known alias are returned unchanged (original casing is
 * preserved for display, e.g. `MTL`, `mtl`).
 */
const normalizePWHLCode = (code: string): string => {
  if (!code) return code;
  const alias = PWHL_CODE_ALIASES[code.toUpperCase()];
  return alias ?? code;
};

/**
 * A season entry of the HockeyTech feed.
 *
 * Pre-season, **regular season** and **playoffs each carry their own
 * `season_id`**, and several of them overlap the same calendar year: 2025 is
 * covered by the 2024-25 regular season, the 2025 playoffs, the 2025-26
 * pre-season *and* the 2025-26 regular season. A season therefore has to be
 * resolved from the exact date — picking every season that overlaps a year and
 * merging their schedules would tally several seasons into one record.
 */
type PWHLSeason = {
  season_id: string;
  season_name: string;
  start_date: string;
  end_date: string;
};

export class HockeyData {
  /**
   * Fetch the list of PWHL seasons (by default ordered from most recent to oldest).
   */
  private async getPWHLSeasons(): Promise<PWHLSeason[]> {
    const response = await fetch(
      `${pwhlAPI}index.php?feed=modulekit&view=seasons&key=446521baf8c38984&client_code=pwhl&fmt=json`,
    );
    const json = await response.json();
    const seasons = json?.SiteKit?.Seasons;
    return Array.isArray(seasons) ? seasons : [];
  }

  /**
   * Fetch one season's schedule. Without `seasonId` the feed silently answers
   * with its **default** season (currently the 2026-27 pre-season), which is
   * why the season must always be resolved explicitly when reading history.
   */
  private async getPWHLSchedule(seasonId?: string): Promise<PWHLGameAPI[]> {
    const response = await fetch(
      `${pwhlAPI}?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl${
        seasonId ? `&season_id=${seasonId}` : ''
      }`,
    );
    const json = await response.json();
    const games = json?.SiteKit?.Schedule;
    return Array.isArray(games) ? games : [];
  }

  /**
   * Resolve, for one exact date, the season holding its games and the season
   * the record must be replayed from.
   *
   * - `gameSeason` — the entry whose date span covers the date (regular season
   *   first, then playoffs, then pre-season when two entries overlap).
   * - `recordSeason` — the regular season a team's W-L-OTL comes from: the one
   *   covering the date, or, for a playoff date, the most recent regular season
   *   that ended before it. Pre-season dates therefore show the last completed
   *   tally rather than the upcoming season's (still empty) one.
   */
  private async getPWHLSeasonsForDate(
    date: string,
  ): Promise<{ gameSeason?: PWHLSeason; recordSeason?: PWHLSeason }> {
    try {
      const seasons = await this.getPWHLSeasons();
      if (!Array.isArray(seasons) || seasons.length === 0) return {};

      const isRegular = (s: PWHLSeason) =>
        /regular season/i.test(s.season_name);
      const covers = (s: PWHLSeason) =>
        s.start_date <= date && s.end_date >= date;
      const rank = (s: PWHLSeason) =>
        isRegular(s) ? 0 : /playoff/i.test(s.season_name) ? 1 : 2;

      const covering = seasons.filter(covers);
      const gameSeason = [...covering].sort((a, b) => rank(a) - rank(b))[0];

      const regulars = seasons.filter(isRegular);
      const recordSeason =
        regulars.find(covers) ??
        regulars
          .filter((s) => s.end_date <= date)
          .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];

      return { gameSeason, recordSeason };
    } catch (error) {
      console.error(
        'Error resolving PWHL seasons for date:',
        error instanceof Error ? error.message : String(error),
      );
      return {};
    }
  }

  /**
   * Resolve the PWHL `season_id`(s) to request for a specific calendar year.
   *
   * - When `year` is provided, returns every season whose date span overlaps that
   *   calendar year (a PWHL season runs across two years, e.g. 2024-25), so a full
   *   calendar year of results is recovered.
   * - When `year` is omitted, returns the currently live season, falling back to the
   *   most recent regular season, to avoid hitting the API's default (often a
   *   pre-season) which has an empty schedule.
   */
  private async getPWHLSeasonIds(year?: number): Promise<string[]> {
    try {
      const seasons = await this.getPWHLSeasons();
      if (!Array.isArray(seasons) || seasons.length === 0) return [];

      if (year) {
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year}-12-31`;
        return seasons
          .filter((s) => s.start_date <= yearEnd && s.end_date >= yearStart)
          .map((s) => s.season_id);
      }

      // No year: resolve the season phases for the season that is currently active (or upcoming).
      const nowStr = new Date().toISOString().slice(0, 10);

      const baseKey = (s: PWHLSeason): string => {
        const name = s.season_name || '';
        const parts = name.split(' ');
        return parts.length > 0 ? parts[0] : '';
      };

      const isRegular = (s: PWHLSeason) =>
        /regular season/i.test(s.season_name);
      const rank = (s: PWHLSeason) =>
        isRegular(s) ? 0 : /playoff/i.test(s.season_name) ? 1 : 2;

      // 1) If any season already covers today, fetch all phases of that season.
      const covering = seasons.filter(
        (s) => s.start_date <= nowStr && s.end_date >= nowStr,
      );
      if (covering.length > 0) {
        // Choose the "most important" covering season (regular → playoffs → pre‑season)
        const best = covering.sort((a, b) => rank(a) - rank(b))[0];
        const currentBase = baseKey(best);
        return seasons
          .filter((s) => baseKey(s) === currentBase)
          .map((s) => s.season_id);
      }

      // 2) No season covers today: pick the earliest season that starts later.
      const upcoming = seasons
        .filter((s) => s.start_date > nowStr)
        .sort((a, b) => a.start_date.localeCompare(b.start_date));

      if (upcoming.length > 0) {
        const upcomingBase = baseKey(upcoming[0]);
        return seasons
          .filter((s) => baseKey(s) === upcomingBase)
          .map((s) => s.season_id);
      }

      // 3) Fallback to the previous behaviour: most recent ended regular season.
      const latestReg = seasons.find((s) =>
        s.season_name.toLowerCase().includes('regular season'),
      );
      return latestReg ? [latestReg.season_id] : [];
    } catch (error) {
      console.error('Error fetching PWHL seasons:', error);
      return [];
    }
  }

  async getNHLTeams(): Promise<TeamType[]> {
    try {
      let allTeams: TeamNHL[];

      const fetchedTeams = await fetch(
        'https://api-web.nhle.com/v1/standings/now',
      );
      const fetchTeams = await fetchedTeams.json();
      allTeams = await fetchTeams.standings;

      allTeams = allTeams.map((team: TeamNHL) => {
        if (team.teamAbbrev.default === 'ARI') {
          team.teamAbbrev.default = 'UTA';
          team.teamCommonName.default = 'Utah';
        }
        return team;
      });

      const activeTeams = allTeams.map((team: TeamNHL) => {
        const { teamAbbrev, teamName, teamLogo, teamCommonName } = team;
        const teamID = teamAbbrev.default;
        const uniqueId = `${leagueName}-${teamID}`;

        const resolvedColors = getTeamColors(uniqueId);
        let colorTeam = resolvedColors.color;
        let backgroundColorTeam = resolvedColors.backgroundColor;

        if (getLuminance(colorTeam) < getLuminance(backgroundColorTeam)) {
          const temp = colorTeam;
          colorTeam = backgroundColorTeam;
          backgroundColorTeam = temp;
        }

        return {
          uniqueId,
          id: teamID,
          abbrev: teamID,
          label: capitalize(teamName?.default),
          teamLogo: teamLogo,
          teamLogoDark: teamLogo,
          teamCommonName: capitalize(teamCommonName.default),
          league: leagueName.toUpperCase(),
          color: colorTeam,
          backgroundColor: backgroundColorTeam,
          wins: team.wins,
          losses: team.losses,
          otLosses: team.otLosses,
        };
      });

      return activeTeams;
    } catch (error) {
      console.error('Error fetching data =>', error);
      return [];
    }
  }

  async getPWHLTeams(): Promise<TeamType[]> {
    try {
      const leagueName = League.PWHL;

      const fetchedTeams = await fetch(
        `${pwhlAPI}index.php?feed=modulekit&view=teamsbyseason&key=446521baf8c38984&client_code=pwhl&fmt=json`,
      );
      const fetchTeams: PWHLResponse = await fetchedTeams.json();
      const allTeams: TeamPWHL[] = await fetchTeams?.SiteKit?.Teamsbyseason;
      // Resolve the season that should provide standings. Use the regular
      // season covering today when one exists (so pre‑season requests do not
      // accidentally read the default pre‑season feed); otherwise use the most
      // recent regular season that has ended.
      const nowStr = new Date().toISOString().slice(0, 10);
      const dateResolution = await this.getPWHLSeasonsForDate(nowStr);
      const standingsSeasonId =
        dateResolution.recordSeason?.season_id ??
        fetchTeams?.SiteKit?.Parameters?.season_id;
      const standings = await this.getPWHLStandings(standingsSeasonId);

      const activeTeams = allTeams.map((team: TeamPWHL) => {
        const { code, name, team_logo_url } = team;
        const teamID = normalizePWHLCode(code);
        const uniqueId = `${leagueName}-${teamID}`;

        const recordStr = standings[teamID];
        let wins = 0,
          losses = 0,
          otLosses = 0;
        if (recordStr) {
          const parts = recordStr.split('-');
          wins = Number.parseInt(parts[0]) || 0;
          losses = Number.parseInt(parts[1]) || 0;
          otLosses = Number.parseInt(parts[2]) || 0;
        }

        const resolvedColors = getTeamColors(uniqueId);
        let colorTeam = resolvedColors.color;
        let backgroundColorTeam = resolvedColors.backgroundColor;

        if (getLuminance(colorTeam) < getLuminance(backgroundColorTeam)) {
          const temp = colorTeam;
          colorTeam = backgroundColorTeam;
          backgroundColorTeam = temp;
        }

        return {
          uniqueId,
          id: teamID,
          abbrev: teamID,
          label: capitalize(name),
          teamLogo: team_logo_url,
          teamLogoDark: team_logo_url,
          teamCommonName: capitalize(name),
          league: leagueName.toUpperCase(),
          color: colorTeam,
          backgroundColor: backgroundColorTeam,
          wins,
          losses,
          otLosses,
        };
      });

      return activeTeams;
    } catch (error) {
      console.error('Error fetching data =>', error);
      return [];
    }
  }

  /**
   * Fills `teamRecords` with the **current** PWHL tally of every team
   * (`PWHL-<CODE>` -> `"W-L-OTL"`), read from HockeyTech's official standings
   * feed (`getPWHLStandings()`), which already resolves the current regular
   * season for us.
   *
   * PWHL needs this because — unlike the ESPN leagues, where the team schedule
   * carries a per-game cumulative record — `getHockeySchedule()` has no
   * per-game record at all, so without this the `teamRecords` map stays empty
   * for the PWHL and no `team.record` is ever refreshed.
   *
   * Falls back to the local replay of the schedule (`applyPWHLHistoricalRecords`,
   * which recomputes W-L-OTL from the played games) when the standings feed is
   * unavailable, so one failing source does not leave the PWHL without records.
   */
  private async collectPWHLTeamRecords(
    teamRecords: Map<string, string>,
  ): Promise<void> {
    const apply = (records: Record<string, string>) => {
      for (const [code, record] of Object.entries(records ?? {})) {
        if (record) teamRecords.set(`${League.PWHL}-${code}`, record);
      }
    };

    try {
      const standings = await this.getPWHLStandings();
      if (standings && Object.keys(standings).length > 0) {
        apply(standings);
        return;
      }
      console.warn(
        '[Records] PWHL standings returned nothing — falling back to the schedule replay.',
      );
    } catch (error) {
      console.error(
        '[Records] Error fetching PWHL standings:',
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      const response = await fetch(
        `${pwhlAPI}?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl`,
      );
      const json = await response.json();
      const allGames: PWHLGameAPI[] = json?.SiteKit?.Schedule;
      if (Array.isArray(allGames) && allGames.length > 0) {
        const { finals } = this.applyPWHLHistoricalRecords(allGames);
        apply(Object.fromEntries(finals));
      }
    } catch (error) {
      console.error(
        '[Records] PWHL schedule replay fallback failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  getHockeySchedule = async (
    activeTeams,
    leagueLogos,
    league,
    forceUpdate = false,
    season?: number,
    teamRecords?: Map<string, string>,
  ) => {
    const allGames = {};

    // Standings-based tallies are only harvested for the CURRENT season: during
    // oldies the historical record must stay frozen (same rule as the ESPN
    // leagues, which is handled in `GameService.getLeagueGames`).
    if (teamRecords && league === League.PWHL && season === undefined) {
      try {
        await this.collectPWHLTeamRecords(teamRecords);
      } catch (error) {
        console.error(
          'Error collecting PWHL team records:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    await Promise.all(
      activeTeams.map(async (team) => {
        try {
          if (league === League.NHL) {
            const { id, uniqueId } = team;
            const leagueID = `${league}-${id}`;
            const teamGames = await this.getNHLTeamschedule(
              id,
              uniqueId,
              leagueLogos,
              season,
            );
            allGames[leagueID] = teamGames;
            console.info(
              `[Schedule] ${league} ${team.label || uniqueId}: ${teamGames.length} game(s) fetched.`,
            );
          }
          if (league === League.PWHL) {
            const { id, uniqueId } = team;
            const leagueID = `${league}-${id}`;
            const teamGames = await this.getPWHLTeamschedule(
              id,
              uniqueId,
              leagueLogos,
              forceUpdate,
              season,
            );
            allGames[leagueID] = teamGames;
            console.info(
              `[Schedule] ${league} ${team.label || uniqueId}: ${teamGames.length} game(s) fetched.`,
            );
          }
        } catch (error) {
          console.error(
            `Error fetching schedule for hockey team ${error.id}:`,
            error,
          );
          throw team;
        }
      }),
    );

    const fetchedGames = Object.values(allGames).flat() as any[];
    const distinctGames = new Set(
      fetchedGames.map((game) =>
        game?.startTimeUTC && game?.homeTeamId && game?.awayTeamId
          ? `${game.startTimeUTC}|${game.homeTeamId}|${game.awayTeamId}`
          : game?.uniqueId,
      ),
    );

    for (const team of Object.keys(allGames)) {
      if (allGames[team].length === 0) {
        delete allGames[team];
      }
    }

    console.info(
      `[Schedule] ${league}: fetched schedules for ${activeTeams.length} team(s), ${distinctGames.size} distinct game(s) across those schedules.`,
    );
    return allGames;
  };

  fetchGamesData = async (id: string, league: string, season?: number) => {
    try {
      let fetchGames;
      if (league === League.NHL) {
        const seasonParam = season ? `${season}${season + 1}` : 'now';
        const fetchedGames = await fetch(
          `https://api-web.nhle.com/v1/club-schedule-season/${id}/${seasonParam}`,
        );
        const tempGames = await fetchedGames.json();

        fetchGames = await tempGames.games;
      }
      if (league === League.PWHL) {
        const seasonIds = await this.getPWHLSeasonIds(season);
        const urls = seasonIds.length
          ? seasonIds.map(
              (seasonId) =>
                `${pwhlAPI}?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl&season_id=${seasonId}`,
            )
          : [
              `${pwhlAPI}?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl`,
            ];
        const fetchedSchedules = await Promise.all(
          urls.map((url) => fetch(url).then((res) => res.json())),
        );
        const allFetchGames = fetchedSchedules.flatMap(
          (json) => json?.SiteKit?.Schedule || [],
        );
        fetchGames = allFetchGames.filter(
          (game) =>
            normalizePWHLCode(game.home_team_code || '').toLowerCase() ===
              normalizePWHLCode(id || '').toLowerCase() ||
            normalizePWHLCode(game.visiting_team_code || '').toLowerCase() ===
              normalizePWHLCode(id || '').toLowerCase(),
        );
        return (await fetchGames.games) || fetchGames;
      }
      console.info('yes', id);
      return (await fetchGames.games) || fetchGames;
    } catch (error) {
      console.error('Error fetching games:', id, error);
      throw id;
    }
  };

  getPWHLStandings = async (seasonId?: string) => {
    try {
      if (!seasonId) {
        const seasonsResponse = await fetch(
          `${pwhlAPI}index.php?feed=modulekit&view=seasons&key=446521baf8c38984&client_code=pwhl&fmt=json`,
        );
        const seasonsJson = await seasonsResponse.json();
        const seasons = seasonsJson?.SiteKit?.Seasons;
        if (Array.isArray(seasons) && seasons.length > 0) {
          const regularSeason = [...seasons]
            .reverse()
            .find((s) => s.season_name.includes('Regular Season'));
          if (regularSeason) {
            seasonId = regularSeason.season_id;
          } else {
            seasonId = seasons.at(-1).season_id;
          }
        }
      }

      if (!seasonId) return {};

      const standingsResponse = await fetch(
        `${pwhlAPI}index.php?feed=modulekit&view=statviewtype&stat=conference&type=standings&season_id=${seasonId}&key=446521baf8c38984&client_code=pwhl&fmt=json`,
      );
      const standingsJson = await standingsResponse.json();
      const standingsList =
        standingsJson?.SiteKit?.Statviewtype || standingsJson;
      if (!standingsList) return {};

      const records = {};

      standingsList.forEach((team) => {
        const code = normalizePWHLCode(team.team_code || team.code);
        if (code) {
          let wins = Number.parseInt(team.wins, 10) || 0;
          const losses = Number.parseInt(team.losses, 10) || 0;
          const otWins = Number.parseInt(team.ot_wins, 10) || 0;
          const shootoutWins = Number.parseInt(team.shootout_wins, 10) || 0;
          const otLosses =
            (Number.parseInt(team.ot_losses, 10) || 0) +
            (Number.parseInt(team.shootout_losses, 10) || 0);
          const gamesPlayed = Number.parseInt(team.games_played, 10) || 0;

          if (gamesPlayed > 0 && wins + losses + otLosses !== gamesPlayed) {
            wins += otWins + shootoutWins;
          }
          records[code] = `${wins}-${losses}-${otLosses}`;
        }
      });
      return records;
    } catch (error) {
      console.error('Error fetching PWHL standings:', error);
      return {};
    }
  };

  getNHLStandings = async () => {
    try {
      const response = await fetch('https://api-web.nhle.com/v1/standings/now');
      const json = await response.json();
      const standings = json.standings;
      const records = {};
      standings.forEach((team) => {
        const abbrev =
          team.teamAbbrev.default === 'ARI' ? 'UTA' : team.teamAbbrev.default;
        records[abbrev] = `${team.wins}-${team.losses}-${team.otLosses}`;
      });
      return records;
    } catch (error) {
      console.error('Error fetching NHL standings:', error);
      return {};
    }
  };

  getPWHLTeamschedule = async (
    id: string,
    teamUniqueId: string,
    leagueLogos: { string },
    forceUpdate = false,
    season?: number,
  ) => {
    const leagueName = League.PWHL;

    const games: PWHLGameAPI[] = await this.fetchGamesData(
      id,
      League.PWHL,
      season,
    );
    if (!games || games.length === 0) {
      return [];
    }
    const isActive = true;
    // Built once, not per game: the filters below compare against "now".
    const now = new Date();
    const gamesData: GameFormatted[] = games
      .map((game: PWHLGameAPI) => {
        const {
          home_team_code,
          visiting_team_code,
          home_team_name,
          visiting_team_name,
          home_team_city,
          visiting_team_city,
          venue_name,
          date_played,
          GameDateISO8601,
          home_goal_count,
          visiting_goal_count,
          venue_location,
        } = game;
        const isFinished = Boolean(
          game.final === '1' ||
            game.status === '4' ||
            game.game_status?.toUpperCase().startsWith('FINAL'),
        );
        const status = isFinished ? 'FINISHED' : null;

        // Fold feed aliases (e.g. VGS in the regular season vs VEG in the
        // pre-season / teams feed) onto the canonical code so the same Las
        // Vegas team keeps a single id, logo, colour and record everywhere.
        const homeCode = normalizePWHLCode(home_team_code);
        const awayCode = normalizePWHLCode(visiting_team_code);

        if (season) {
          const gameYear = new Date(GameDateISO8601).getFullYear();
          // `season` is the requested calendar year: keep only games played that
          // year (a PWHL season spans two years, e.g. 2024-25).
          if (gameYear !== season) return;
        } else {
          const tenMonthAgo = new Date(
            now.getTime() - 300 * 24 * 60 * 60 * 1000,
          );
          const untilDate = forceUpdate ? tenMonthAgo : now;
          if (new Date(GameDateISO8601) < untilDate) return;
        }

        const awayTeamName = visiting_team_name.includes(visiting_team_city)
          ? visiting_team_name
          : `${visiting_team_city} ${visiting_team_name}`;
        const homeTeamName = home_team_name.includes(home_team_city)
          ? home_team_name
          : `${home_team_city} ${home_team_name}`;
        const arena = venue_name.split('|')[0];

        return {
          arenaName: capitalize(arena) || '',
          awayTeam: capitalize(awayTeamName),
          awayTeamId: `${leagueName}-${awayCode}`,
          awayTeamLogo: leagueLogos[awayCode],
          awayTeamLogoDark: leagueLogos[awayCode],
          awayTeamShort: awayCode,
          gameDate: date_played,
          homeTeam: capitalize(homeTeamName),
          homeTeamId: `${leagueName}-${homeCode}`,
          homeTeamLogo: leagueLogos[homeCode],
          homeTeamLogoDark: leagueLogos[homeCode],
          homeTeamShort: homeCode,
          homeTeamScore: isFinished ? Number(home_goal_count) : null,
          awayTeamScore: isFinished ? Number(visiting_goal_count) : null,
          gameStatus: status,
          league: leagueName,
          placeName: capitalize(venue_location),
          selectedTeam: homeCode === normalizePWHLCode(id),
          startTimeUTC: new Date(GameDateISO8601).toISOString(),
          teamSelectedId: teamUniqueId,
          isActive,
          uniqueId: `${teamUniqueId}-${date_played}-${game.id}`,
          urlLive: `https://www.thepwhl.com/en/stats/game-center/${game.id}`,
        };
      })
      .filter((game) => game !== undefined && game !== null);
    return gamesData;
  };

  getNHLTeamschedule = async (
    id: string,
    teamUniqueId: string,
    leagueLogos: { string },
    season?: number,
  ) => {
    const games: NHLGameAPI[] = await this.fetchGamesData(
      id,
      League.NHL,
      season,
    );

    const now = new Date();
    const isActive = true;

    let gamesData: GameFormatted[] = games.map((game: NHLGameAPI) => {
      const {
        awayTeam,
        homeTeam,
        venue,
        gameDate,
        startTimeUTC,
        gameCenterLink,
      } = game;

      if (!season) {
        if (new Date(startTimeUTC) < now) return;
      }

      const awayTeamName = `${awayTeam.placeName.default} ${awayTeam.commonName.default}`;
      const homeTeamName = `${homeTeam.placeName.default} ${homeTeam.commonName.default}`;

      return {
        arenaName: capitalize(venue?.default) || '',
        awayTeam: capitalize(awayTeamName),
        awayTeamId: `${leagueName}-${awayTeam.abbrev}`,
        awayTeamLogo: leagueLogos[awayTeam.abbrev],
        awayTeamLogoDark: leagueLogos[awayTeam.abbrev],
        awayTeamShort: awayTeam.abbrev,
        gameDate: gameDate,
        homeTeam: capitalize(homeTeamName),
        homeTeamId: `${leagueName}-${homeTeam.abbrev}`,
        homeTeamLogo: leagueLogos[homeTeam.abbrev],
        homeTeamLogoDark: leagueLogos[homeTeam.abbrev],
        homeTeamShort: homeTeam.abbrev,
        homeTeamScore: null,
        awayTeamScore: null,
        gameStatus: null,
        seriesSummary: (game as any).seriesSummary?.seriesStatusShort,
        seriesStatus: (game as any).seriesSummary?.seriesStatusLong,
        league: leagueName,
        placeName: capitalize(homeTeam.placeName.default),
        selectedTeam: homeTeam.abbrev === id,
        startTimeUTC: new Date(startTimeUTC).toISOString(),
        teamSelectedId: teamUniqueId,
        isActive,
        uniqueId: `${teamUniqueId}-${gameDate}-1`,
        urlLive: `https://www.nhl.com/${gameCenterLink}`,
      };
    });

    gamesData = gamesData.filter((game) => game !== undefined && game !== null);

    return gamesData;
  };

  /**
   * Replays a PWHL season schedule to compute each team's final W-L-OTL.
   *
   * Same rule as the ESPN leagues in `espnAllData.ts` / `syncGameWithScore()`:
   * - past season (every game already started): the **final** season tally is
   *   copied onto every game of the team, so opening a game of a finished
   *   season shows that year's record, not today's;
   * - season in progress: records stay empty so readers fall back to the live
   *   `team.record` (most recent tally).
   *
   * HockeyTech exposes no per-game cumulative record, hence the local replay:
   * finished games are walked in chronological order and each team's W/L/OTL is
   * incremented (OT/SO loss when `overtime`/`shootout` is set or `game_status`
   * mentions OT/SO, regulation loss otherwise).
   *
   * Callers must pass a **regular season** schedule: HockeyTech gives the
   * playoffs their own `season_id`, and a W-L-OTL tally is a regular-season
   * figure (that is what the standings show). `getPWHLScores()` therefore picks
   * the regular season covering the date — or, on a playoff date, the regular
   * season that ended just before it. Note that `game_type` is an empty string
   * in **both** feeds today, so the `isPlayoff` guard below never actually
   * filters anything; the season choice, not that guard, is what keeps
   * playoff games out of the tally.
   */
  private applyPWHLHistoricalRecords(allGames: PWHLGameAPI[]): {
    finals: Map<string, string>;
    seasonOver: boolean;
  } {
    const finals = new Map<string, string>();
    const sorted = [...allGames].sort(
      (a, b) =>
        new Date(a.GameDateISO8601).getTime() -
        new Date(b.GameDateISO8601).getTime(),
    );
    const now = Date.now();
    const seasonOver = sorted.every((g) => {
      const start = g?.GameDateISO8601
        ? new Date(g.GameDateISO8601).getTime()
        : NaN;
      return Number.isFinite(start) && start < now;
    });

    const tallies = new Map<string, { w: number; l: number; otl: number }>();
    const tally = (code: string) => {
      let t = tallies.get(code);
      if (!t) {
        t = { w: 0, l: 0, otl: 0 };
        tallies.set(code, t);
      }
      return t;
    };

    for (const g of sorted) {
      const isFinished = Boolean(
        g.final === '1' ||
          g.status === '4' ||
          g.game_status?.toUpperCase().startsWith('FINAL'),
      );
      const isPlayoff =
        g.game_type !== undefined &&
        g.game_type !== null &&
        String(g.game_type) !== '' &&
        String(g.game_type) !== '1';
      if (!isFinished || isPlayoff) continue;

      const homeGoals = Number(g.home_goal_count);
      const awayGoals = Number(g.visiting_goal_count);
      if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
      if (homeGoals === awayGoals) continue;

      const home = normalizePWHLCode(g.home_team_code);
      const away = normalizePWHLCode(g.visiting_team_code);
      const winner = homeGoals > awayGoals ? home : away;
      const loser = homeGoals > awayGoals ? away : home;
      const wentExtra =
        g.overtime === '1' ||
        g.shootout === '1' ||
        /OT|SO/i.test(g.game_status || '');
      tally(winner).w += 1;
      if (wentExtra) tally(loser).otl += 1;
      else tally(loser).l += 1;
    }

    for (const [code, t] of tallies) finals.set(code, `${t.w}-${t.l}-${t.otl}`);
    return { finals, seasonOver };
  }

  /**
   * Scores of one day, with each team's record for that day.
   *
   * The season is resolved from the **exact date**. Without it the feed
   * answers with its default season (the live pre-season), so the requested day
   * is simply absent from the payload: the `date_played` filter returns nothing
   * and `applyPWHLHistoricalRecords` finds no finished game, which left both
   * `seasonOver` false and `finals` empty — hence no record on any past date.
   *
   * Records come from the **regular season alone**: pre-season, playoffs and
   * regular season have distinct `season_id`s and several of them overlap a
   * single calendar year, so merging every season that overlaps the year would
   * total several seasons into one (plausible-looking but wrong) tally.
   */
  getPWHLScores = async (date: string) => {
    try {
      const { gameSeason, recordSeason } =
        await this.getPWHLSeasonsForDate(date);

      // Games of the requested day, from the season that actually covers it.
      // When no season covers the date (or the seasons feed failed) this falls
      // back to the default season rather than losing the whole day.
      const dayGames = await this.getPWHLSchedule(gameSeason?.season_id);
      const gamesOfDay = dayGames.filter((game) => game.date_played === date);

      // The tally is replayed from the regular season — the same schedule when
      // the day already belongs to it, one extra request otherwise.
      const recordGames =
        recordSeason && recordSeason.season_id !== gameSeason?.season_id
          ? await this.getPWHLSchedule(recordSeason.season_id)
          : dayGames;
      const { finals, seasonOver } =
        this.applyPWHLHistoricalRecords(recordGames);

      return gamesOfDay.map((game) => {
        let gameStatus = game.game_status;
        if (
          gameStatus === 'In Progress' &&
          (game as any).game_clock &&
          (game as any).period
        ) {
          gameStatus = `${(game as any).game_clock} - ${(game as any).period}`;
        }
        // Same rule as the ESPN leagues (`applySeasonFinalRecords`): a
        // finished season shows that year's final tally on every game;
        // a season in progress leaves records empty so readers fall
        // back to the live `team.record` (most recent tally, kept via
        // `syncGameWithScore()` -> `_nextRecord()`).
        const homeRecord = seasonOver
          ? finals.get(normalizePWHLCode(game.home_team_code)) || ''
          : '';
        const awayRecord = seasonOver
          ? finals.get(normalizePWHLCode(game.visiting_team_code)) || ''
          : '';
        return {
          homeTeamScore: Number(game.home_goal_count),
          awayTeamScore: Number(game.visiting_goal_count),
          homeTeamShort: normalizePWHLCode(game.home_team_code),
          awayTeamShort: normalizePWHLCode(game.visiting_team_code),
          homeTeamId: `${League.PWHL}-${normalizePWHLCode(game.home_team_code)}`,
          awayTeamId: `${League.PWHL}-${normalizePWHLCode(game.visiting_team_code)}`,
          isFinal: game.final === '1',
          homeTeamRecord: homeRecord,
          awayTeamRecord: awayRecord,
          status: game.game_status,
          gameStatus: gameStatus,
          gameClock: (game as any).game_clock,
          gamePeriod: (game as any).period,
          startTimeUTC: new Date(game.GameDateISO8601).toISOString(),
          uniqueId: game.id,
          gameDate: date,
          league: League.PWHL,
          seriesSummary: game?.game_number ? `Game ${game.game_number}` : '',
          seriesStatus: game?.game_number ? `Game ${game.game_number}` : '',
        };
      });
    } catch (error) {
      console.error('Error fetching PWHL scores:', error);
      return [];
    }
  };

  async getPWHLRealTimeData(): Promise<any[]> {
    try {
      const auth = 'uwM69pPkdUhb0UuVAxM8IcA6pBAzATAxOc8979oJ';
      const key = 'AIzaSyBVn0Gr6zIFtba-hQy3StkifD8bb7Hi68A';

      const [liveRes, clockRes] = await Promise.all([
        fetch(
          `https://leaguestat-b9523.firebaseio.com/svf/pwhl.json?auth=${auth}&key=${key}`,
        ).catch(() => null),
        fetch(
          `https://leaguestat-b9523.firebaseio.com/svf/pwhl/runningclock.json?auth=${auth}`,
        ).catch(() => null),
      ]);

      if (!liveRes?.ok || !clockRes?.ok) return [];

      const liveData = await liveRes.json();
      const clockData = await clockRes.json();

      const gamesMap = liveData?.goalssummary?.[1]?.games || {};
      const clockGamesMap = clockData?.games || {};
      const results = [];

      for (const [gameId, data] of Object.entries(gamesMap)) {
        const clockEntry = clockGamesMap[gameId] || {};
        const gameData = data as any;

        const homeScore = gameData.HomeGoalTotal;
        const awayScore = gameData.VisitorGoalTotal;

        let clock = '';
        let period = '';
        const clockInfo = clockEntry.Clock;
        if (clockInfo) {
          const mins = clockInfo.Minutes || '00';
          const secs = clockInfo.Seconds || '00';
          clock = `${mins}:${secs}`;
          period = clockInfo.period || '';
        }

        const statusId = clockEntry.status_id;

        let isFinal = false;
        let gameStatus = 'SCHEDULED';

        if (statusId === 4) {
          gameStatus = 'FINISHED';
          isFinal = true;
        } else if (clock && period) {
          gameStatus = `${clock} - ${period}`;
        } else if (homeScore != null && awayScore != null) {
          gameStatus = 'FINISHED';
          isFinal = true;
        }

        results.push({
          uniqueId: gameId,
          league: League.PWHL,
          homeTeamScore:
            homeScore != null ? Number.parseInt(homeScore, 10) : null,
          awayTeamScore:
            awayScore != null ? Number.parseInt(awayScore, 10) : null,
          isFinal: isFinal,
          gameStatus: gameStatus,
          gameClock: clock,
          gamePeriod: period,
          startTimeUTC: '',
        });
      }
      return results;
    } catch (error) {
      console.error('Error fetching PWHL RealTime data:', error);
      return [];
    }
  }
}
