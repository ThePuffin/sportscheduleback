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

export class HockeyData {
  /**
   * Fetch the list of PWHL seasons (by default ordered from most recent to oldest).
   */
  private async getPWHLSeasons(): Promise<
    {
      season_id: string;
      season_name: string;
      start_date: string;
      end_date: string;
    }[]
  > {
    const response = await fetch(
      `${pwhlAPI}index.php?feed=modulekit&view=seasons&key=446521baf8c38984&client_code=pwhl&fmt=json`,
    );
    const json = await response.json();
    const seasons = json?.SiteKit?.Seasons;
    return Array.isArray(seasons) ? seasons : [];
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
        const {
          teamAbbrev,
          teamName,
          teamLogo,
          divisionName,
          teamCommonName,
          conferenceName,
        } = team;
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
          value: uniqueId,
          id: teamID,
          abbrev: teamID,
          label: capitalize(teamName?.default),
          teamLogo: teamLogo,
          teamLogoDark: teamLogo,
          teamCommonName: capitalize(teamCommonName.default),
          conferenceName,
          divisionName,
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
        const { code, name, team_logo_url, division_long_name } = team;
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
          value: uniqueId,
          id: teamID,
          abbrev: teamID,
          label: capitalize(name),
          teamLogo: team_logo_url,
          teamLogoDark: team_logo_url,
          teamCommonName: capitalize(name),
          conferenceName: '',
          divisionName: division_long_name,
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
            const { id, value, color, backgroundColor } = team;
            const leagueID = `${league}-${id}`;
            allGames[leagueID] = await this.getNHLTeamschedule(
              id,
              value,
              leagueLogos,
              color,
              backgroundColor,
              season,
            );
          }
          if (league === League.PWHL) {
            const { id, value, color, backgroundColor } = team;
            const leagueID = `${league}-${id}`;
            allGames[leagueID] = await this.getPWHLTeamschedule(
              id,
              value,
              leagueLogos,
              color,
              backgroundColor,
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
    value: string,
    leagueLogos: { string },
    color: string | undefined,
    backgroundColor: string | undefined,
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
          timezone,
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
        const now = new Date();
        const isActive = true;

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
          backgroundColor: backgroundColor || undefined,
          color: color || undefined,
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
          show: home_team_code === id,
          startTimeUTC: new Date(GameDateISO8601).toISOString(),
          teamSelectedId: value,
          isActive,
          uniqueId: `${value}-${date_played}-${game.id}`,
          venueTimezone: timezone,
          urlLive: `https://www.thepwhl.com/en/stats/game-center/${game.id}`,
        };
      })
      .filter((game) => game !== undefined && game !== null);
    return gamesData;
  };

  getNHLTeamschedule = async (
    id: string,
    value: string,
    leagueLogos: { string },
    color: string | undefined,
    backgroundColor: string | undefined,
    season?: number,
  ) => {
    const games: NHLGameAPI[] = await this.fetchGamesData(
      id,
      League.NHL,
      season,
    );

    let gamesData: GameFormatted[] = games.map((game: NHLGameAPI) => {
      const {
        awayTeam,
        homeTeam,
        venue,
        gameDate,
        venueTimezone,
        startTimeUTC,
        gameCenterLink,
      } = game;

      const now = new Date();
      const isActive = true;

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
        backgroundColor: backgroundColor || undefined,
        color: color || undefined,
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
        show: homeTeam.abbrev === id,
        startTimeUTC: new Date(startTimeUTC).toISOString(),
        teamSelectedId: value,
        isActive,
        uniqueId: `${value}-${gameDate}-1`,
        venueTimezone: venueTimezone,
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
   * finished regular-season games are walked in chronological order and each
   * team's W/L/OTL is incremented (OT/SO loss when `overtime`/`shootout` is
   * set or `game_status` mentions OT/SO, regulation loss otherwise). Playoff
   * games are skipped, mirroring the standings view.
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

  getPWHLScores = async (date: string) => {
    try {
      const fetchedGames = await fetch(
        `${pwhlAPI}?feed=modulekit&view=schedule&key=446521baf8c38984&client_code=pwhl`,
      );
      const response = await fetchedGames.json();
      const allGames: PWHLGameAPI[] = response.SiteKit.Schedule;
      const { finals, seasonOver } = this.applyPWHLHistoricalRecords(allGames);

      return allGames
        .filter((game) => game.date_played === date)
        .map((game) => {
          let gameStatus = game.game_status;
          if (
            gameStatus === 'In Progress' &&
            (game as any).game_clock &&
            (game as any).period
          ) {
            gameStatus = `${(game as any).game_clock} - ${(game as any).period}`;
          }
          const gameKey = (code: string) => `${String(game.id)}::${code}`;
          // Same rule as the ESPN leagues (`applySeasonFinalRecords`): a
          // finished season shows that year's final tally on every game;
          // a season in progress leaves records empty so readers fall
          // back to the live `team.record` (most recent tally, kept via
          // `syncGameWithScore()` -> `_nextRecord()`).
          const homeRecord = seasonOver
            ? finals.get(game.home_team_code) || ''
            : '';
          const awayRecord = seasonOver
            ? finals.get(game.visiting_team_code) || ''
            : '';
          void gameKey;
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
