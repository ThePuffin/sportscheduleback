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
   * Every season whose date span covers `date` — pre-season, regular season and
   * playoffs each have their own `season_id`, and two of them can overlap (the
   * 2024-25 pre-season runs until 2024-11-29 while the regular season already
   * starts on the 25th). Returning **all** of them lets each game be replayed
   * against its own group, so a tally never mixes a pre-season with a regular
   * season or a playoff run.
   *
   * Empty when the seasons feed is unreachable or matches nothing; callers then
   * fall back to the feed's default season.
   */
  private async getPWHLSeasonsCovering(date: string): Promise<PWHLSeason[]> {
    try {
      const seasons = await this.getPWHLSeasons();
      if (!Array.isArray(seasons) || seasons.length === 0) return [];
      return seasons.filter((s) => s.start_date <= date && s.end_date >= date);
    } catch (error) {
      console.error(
        'Error resolving PWHL seasons for date:',
        error instanceof Error ? error.message : String(error),
      );
      return [];
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

      const nowStr = new Date().toISOString().slice(0, 10);
      const ongoing = seasons.find(
        (s) => s.start_date <= nowStr && s.end_date >= nowStr,
      );
      if (ongoing) return [ongoing.season_id];

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
      const seasonId = fetchTeams?.SiteKit?.Parameters?.season_id;
      const standings = await this.getPWHLStandings(seasonId);

      const activeTeams = allTeams.map((team: TeamPWHL) => {
        const { code, name, team_logo_url } = team;
        const teamID = code;
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
            allGames[leagueID] = await this.getNHLTeamschedule(
              id,
              uniqueId,
              leagueLogos,
              season,
            );
          }
          if (league === League.PWHL) {
            const { id, uniqueId } = team;
            const leagueID = `${league}-${id}`;
            allGames[leagueID] = await this.getPWHLTeamschedule(
              id,
              uniqueId,
              leagueLogos,
              forceUpdate,
              season,
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

    for (const team of Object.keys(allGames)) {
      if (allGames[team].length === 0) {
        delete allGames[team];
      }
    }

    console.info('updated ', league);
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
            game.home_team_code === id || game.visiting_team_code === id,
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

  /**
   * The regular season a "current" record belongs to, chosen **by date**.
   *
   * The feed lists seasons most recent first, so the previous
   * `[...seasons].reverse().find(...)` walked them **oldest first** and returned
   * the 2024 inaugural regular season (24 games) instead of the current one —
   * which is why every PWHL team record read like a two-year-old tally.
   *
   * Preference: the regular season covering today (live standings), else the
   * most recent one already ended (an off-season keeps the last completed
   * tally), else the closest upcoming one.
   */
  private resolveCurrentRegularSeason(
    seasons: PWHLSeason[],
  ): PWHLSeason | undefined {
    const regulars = seasons.filter((s) =>
      /regular season/i.test(s.season_name),
    );
    if (regulars.length === 0) return undefined;

    const today = new Date().toISOString().slice(0, 10);

    const covering = regulars.find(
      (s) => s.start_date <= today && s.end_date >= today,
    );
    if (covering) return covering;

    const ended = regulars
      .filter((s) => s.end_date < today)
      .sort((a, b) => b.end_date.localeCompare(a.end_date));
    if (ended.length > 0) return ended[0];

    const upcoming = regulars
      .filter((s) => s.start_date > today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    return upcoming[0];
  }

  getPWHLStandings = async (seasonId?: string) => {
    try {
      if (!seasonId) {
        const seasons = await this.getPWHLSeasons();
        seasonId = this.resolveCurrentRegularSeason(seasons)?.season_id;
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
        const code = team.team_code || team.code;
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
          awayTeamId: `${leagueName}-${visiting_team_code}`,
          awayTeamLogo: leagueLogos[visiting_team_code],
          awayTeamLogoDark: leagueLogos[visiting_team_code],
          awayTeamShort: visiting_team_code,
          gameDate: date_played,
          homeTeam: capitalize(homeTeamName),
          homeTeamId: `${leagueName}-${home_team_code}`,
          homeTeamLogo: leagueLogos[home_team_code],
          homeTeamLogoDark: leagueLogos[home_team_code],
          homeTeamShort: home_team_code,
          homeTeamScore: isFinished ? Number(home_goal_count) : null,
          awayTeamScore: isFinished ? Number(visiting_goal_count) : null,
          gameStatus: status,
          league: leagueName,
          placeName: capitalize(venue_location),
          selectedTeam: home_team_code === id,
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
  /**
   * Replays a schedule into each team's `W-L-OTL`.
   *
   * `asOf` restricts the tally to games that started **before** it, so a group
   * still running can still describe an individual game: the record it began
   * with, rather than nothing. Without `asOf` the whole group is tallied — the
   * number a finished season shows on every one of its games.
   *
   * `seasonOver` is always computed over the whole group, never on the `asOf`
   * slice, because it answers a different question: "is this group done?".
   *
   * Callers must pass a schedule belonging to a **single group** (pre-season,
   * regular season or playoffs — each has its own `season_id`): HockeyTech gives
   * no per-game record, and the three groups must never be totalled together.
   */
  private applyPWHLHistoricalRecords(
    allGames: PWHLGameAPI[],
    asOf?: string,
  ): {
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
    const asOfTime = asOf ? new Date(asOf).getTime() : NaN;
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
      if (Number.isFinite(asOfTime)) {
        const startedAt = g?.GameDateISO8601
          ? new Date(g.GameDateISO8601).getTime()
          : NaN;
        // The record a team *brings* to a game: everything already played.
        if (Number.isFinite(startedAt) && startedAt >= asOfTime) continue;
      }

      const homeGoals = Number(g.home_goal_count);
      const awayGoals = Number(g.visiting_goal_count);
      if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) continue;
      if (homeGoals === awayGoals) continue;

      const home = g.home_team_code;
      const away = g.visiting_team_code;
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
   * Past groups use the **local schedule replay** (`applyPWHLHistoricalRecords`,
   * one tally **per group** — pre-season, regular season and playoffs have
   * distinct `season_id`s and several of them overlap a single calendar year,
   * so merging every season that overlaps the year would total several seasons
   * into one plausible-looking but wrong tally).
   *
   * The **current** group (the season covering today) keeps the old behaviour:
   * records come from the official standings feed (`getPWHLStandings()`).
   */
  getPWHLScores = async (date: string) => {
    try {
      const seasons = await this.getPWHLSeasons().catch(() => []);
      const covering = Array.isArray(seasons)
        ? seasons.filter((s) => s.start_date <= date && s.end_date >= date)
        : [];
      const todayStr = new Date().toISOString().slice(0, 10);
      const coveringToday = Array.isArray(seasons)
        ? seasons.filter(
            (s) => s.start_date <= todayStr && s.end_date >= todayStr,
          )
        : [];

      // Current season (pre-season, regular season or playoffs covering today):
      // keep the behaviour from a month ago — records come from the official
      // standings feed. Past groups use the local schedule replay instead.
      let isCurrent = false;
      if (coveringToday.length > 0) {
        isCurrent = covering.some((c) =>
          coveringToday.some((t) => t.season_id === c.season_id),
        );
      } else {
        const curReg = this.resolveCurrentRegularSeason(seasons ?? []);
        if (curReg) {
          isCurrent = covering.some((c) => c.season_id === curReg.season_id);
        }
      }

      if (isCurrent) {
        // The one-month-ago behaviour: records from the official standings
        // feed. Pass the covering season explicitly so a current pre-season
        // or playoff group reads its own standings instead of falling back
        // to the regular-season resolution (which finds nothing during a
        // pre-season and would leave every record empty).
        const currentSeasonId =
          covering.length === 1 ? covering[0].season_id : undefined;
        const standings = await this.getPWHLStandings(currentSeasonId);
        const groups: (PWHLSeason | undefined)[] =
          covering.length > 0 ? covering : [undefined];
        const day: PWHLGameAPI[] = [];
        for (const season of groups) {
          const groupGames = await this.getPWHLSchedule(season?.season_id);
          for (const game of groupGames) {
            if (game.date_played === date) day.push(game);
          }
        }
        return day.map((game) => {
          let gameStatus = game.game_status;
          if (
            gameStatus === 'In Progress' &&
            (game as any).game_clock &&
            (game as any).period
          ) {
            gameStatus = `${(game as any).game_clock} - ${(game as any).period}`;
          }
          return {
            homeTeamScore: Number(game.home_goal_count),
            awayTeamScore: Number(game.visiting_goal_count),
            homeTeamShort: game.home_team_code,
            awayTeamShort: game.visiting_team_code,
            homeTeamId: `${League.PWHL}-${game.home_team_code}`,
            awayTeamId: `${League.PWHL}-${game.visiting_team_code}`,
            isFinal: game.final === '1',
            homeTeamRecord: standings[game.home_team_code] || '',
            awayTeamRecord: standings[game.visiting_team_code] || '',
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
      }

      // Past group(s): local tally only — replay each covering season
      // separately so a tally never mixes pre-season, regular season and
      // playoffs. When no season covers the date (or the seasons feed
      // failed) this falls back to the feed's default season rather than
      // losing the whole day.
      const groups: (PWHLSeason | undefined)[] =
        covering.length > 0 ? covering : [undefined];

      const day: { game: PWHLGameAPI; tally: Map<string, string> }[] = [];

      for (const season of groups) {
        const groupGames = await this.getPWHLSchedule(season?.season_id);
        const { finals, seasonOver } =
          this.applyPWHLHistoricalRecords(groupGames);

        for (const game of groupGames) {
          if (game.date_played !== date) continue;

          const kickoff = new Date(game.GameDateISO8601);
          // A finished group shows its final tally on every one of its games,
          // exactly like the ESPN leagues. While the group is still running it
          // is replayed only up to this game, so a mid-season game carries the
          // record it actually took the ice with instead of nothing.
          const tally = seasonOver
            ? finals
            : this.applyPWHLHistoricalRecords(
                groupGames,
                Number.isNaN(kickoff.getTime())
                  ? undefined
                  : kickoff.toISOString(),
              ).finals;

          day.push({ game, tally });
        }
      }

      return day.map(({ game, tally }) => {
        let gameStatus = game.game_status;
        if (
          gameStatus === 'In Progress' &&
          (game as any).game_clock &&
          (game as any).period
        ) {
          gameStatus = `${(game as any).game_clock} - ${(game as any).period}`;
        }
        const homeRecord = tally.get(game.home_team_code) || '';
        const awayRecord = tally.get(game.visiting_team_code) || '';
        return {
          homeTeamScore: Number(game.home_goal_count),
          awayTeamScore: Number(game.visiting_goal_count),
          homeTeamShort: game.home_team_code,
          awayTeamShort: game.visiting_team_code,
          homeTeamId: `${League.PWHL}-${game.home_team_code}`,
          awayTeamId: `${League.PWHL}-${game.visiting_team_code}`,
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
