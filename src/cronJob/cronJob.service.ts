import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GameService } from '../games/games.service';
import { TeamService } from '../teams/teams.service';
import { League } from '../utils/enum';
import { isCurrentSeason, isPlayoffsPeriod } from '../utils/utils';

@Injectable()
export class CronService implements OnModuleInit {
  private isFetchingOldiesInProgress: boolean = false;
  // League rotation state (see refreshLeaguesOneByOne)
  private isRotatingLeagueInProgress: boolean = false;
  private rotatingLeagueCursor: number = 0;
  private rotatingLeaguesDone: boolean = false;
  private rotationDayKey: string = '';

  constructor(
    private readonly teamService: TeamService,
    private readonly gameService: GameService,
  ) {}

  private get isHeavyRefreshRunning(): boolean {
    return this.isRotatingLeagueInProgress || this.isFetchingOldiesInProgress;
  }

  async onModuleInit() {
    console.info(
      '[Cron] Server restart: Scheduling initial fetchGamesScores...',
    );
    setTimeout(() => {
      this.fetchGamesScoresAtStartup();
    }, 30000);

    // Recovery fetch at restart (2 min after boot). The read routes
    // (findAll / findByDate / findByDateHour) are read-only since the
    // call-time refresh removal, so a cold or stale DB would stay empty
    // until the next daily/monthly cron (up to ~24 h). This one-shot
    // `getAllGames(false, new Date())` fills that gap:
    // - season-gated per league (`isCurrentSeason` / `isPlayoffsPeriod`
    //   with today as boundary): off-season leagues are skipped;
    // - warm restarts are cheap: `getLeagueGames`'s 1-hour timestamp
    //   freshness + `needRefresh` staleness gates skip already-fresh
    //   leagues, and each attempt stamps the league so a restart loop
    //   makes progress instead of re-fetching;
    // - fetches teams first when the teams collection is empty (fresh
    //   deploy), which `checkLeagueGamesAvailability` cannot do (its
    //   threshold compares against a zero team count).
    console.info(
      '[Cron] Server restart: Scheduling recovery games fetch (getAllGames, season-gated)...',
    );
    // --- Fix for restart loop ---
    // On a crash/OOM, Render restarts the server almost immediately. Each restart used to
    // re-schedule a full `getAllGames` recovery 2 min later, while the PREVIOUS recovery
    // (or its `findAll()` tail from the pre-fix era) was still OOM-ing → restart → recovery
    // → OOM, forever. Gate the recovery on a dedicated `recovery` RefreshTimestamp: if one
    // already exists within the last 6 h, the previous instance clearly made progress (or
    // already finished), so this boot skips the heavy fetch. 6 h is short enough to cover a
    // legitimate cold-start recovery but long enough to absorb any boot-storm from a crash
    // loop without replaying the full refresh each time.
    setTimeout(() => {
      this.getAllGamesRecovery();
    }, 120000);
  }

  /**
   * Score recovery at startup, guarded by the score-recycle reentrancy flag.
   */
  private async fetchGamesScoresAtStartup(): Promise<void> {
    try {
      await this.gameService.fetchGamesScores();
    } catch (err) {
      console.error('[Cron] initial fetchGamesScores error:', err);
    }
  }

  /**
   * One-shot `getAllGames(false, new Date())` at boot, guarded by a `recovery`
   * RefreshTimestamp so we never replay a full refresh while a previous one is
   * still settling from an OOM-induced restart.
   */
  private async getAllGamesRecovery(): Promise<void> {
    const lastRecovery = await this.gameService.getLastRecoveryTimestamp();
    if (lastRecovery) {
      console.info(
        '[Cron] Recovery games fetch skipped — a recovery already ran within the last 6 hours (last: ' +
          lastRecovery.toISOString() +
          ').',
      );
      return;
    }
    try {
      await this.gameService.getAllGames(false, new Date());
      await this.gameService.addRecoveryTimestamp();
    } catch (err) {
      console.error('[Cron] recovery getAllGames error:', err);
    }
  }

  @Cron('30 0 1 * *') // EVERY MONTH AT 0:30AM
  async updateTeams() {
    await this.teamService.getTeams();
  }

  @Cron('0 1 1 * *') // EVERY MONTH AT 1AM
  async updateAllGames() {
    await this.gameService.getAllGames();
  }

  /**
   * League rotation — replaces the former six fixed daily per-league crons
   * (2 AM-7 AM). A single 10-minute cron refreshes ONE league per tick,
   * walking through the whole `League` enum in order:
   *
   * - The cycle opens at **4 AM New York** (`America/New_York`) every day and
   *   ticks only between 4 AM and 11 AM NY; ticks outside the window are no-ops
   *   (a full list takes ~2 h50, well inside the window).
   * - One league per tick: a slow third-party fetch for one league can no
   *   longer block the others, and `getLeagueGames`'s internal freshness
   *   (1-hour timestamp) / staleness (1/3/7 days) gates keep warm ticks cheap.
   * - Season-gated: `isCurrentSeason` / `isPlayoffsPeriod` (10-day cached
   *   league dates) skip off-season leagues without hitting third-party APIs.
   * - When the list is complete, nothing runs until the **next day** — the
   *   cursor resets when a new NY calendar day's window opens (2 AM).
   * - The slot is consumed BEFORE awaiting so a slow refresh never
   *   double-runs the same league; a restart resets the cursor, which just
   *   re-walks the (fresh) leagues skipped by the gates.
   * - Schedule is offset from the score recovery (`2-59/10`) and availability
   *   (`7-59/12`) crons, and those skip while this rotation runs (see
   *   `isHeavyRefreshRunning`) so the cycles never overlap.
   */
  @Cron('*/10 * * * *') // EVERY 10 MINUTES — one league per tick (window: 4 AM-11 AM NY)
  async refreshLeaguesOneByOne() {
    const leagueValues = Object.values(League);

    const nyNow = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    );
    const nyHour = nyNow.getHours();
    if (nyHour < 4 || nyHour >= 11) return; // window: 4 AM-11 AM New York

    const dayKey = nyNow.toISOString().split('T')[0];
    // New NY day (or first tick after a restart) → reset the cycle
    if (this.rotationDayKey !== dayKey) {
      this.rotationDayKey = dayKey;
      this.rotatingLeagueCursor = 0;
      this.rotatingLeaguesDone = false;
    }

    // List complete for today — wait for the next day's window
    if (this.rotatingLeaguesDone) {
      console.info(
        `[Cron] League rotation: all ${leagueValues.length} leagues already refreshed today — waiting for the next 2 AM NY window.`,
      );
      return;
    }

    // Never overlap the score recovery cycle (same function family: third-party
    // APIs + Mongo). The slot is NOT consumed — postponed to the next tick.
    if (this.gameService.isScoreRecoveryRunning) {
      console.info(
        '[Cron] League rotation: score recovery cycle in progress — postponing to the next tick.',
      );
      return;
    }

    if (this.isRotatingLeagueInProgress) {
      console.info(
        '[Cron] League rotation: previous league refresh still running — skipping this tick.',
      );
      return;
    }

    // Consume the slot BEFORE awaiting.
    const league = leagueValues[this.rotatingLeagueCursor];
    this.rotatingLeagueCursor += 1;
    if (this.rotatingLeagueCursor >= leagueValues.length) {
      this.rotatingLeaguesDone = true;
    }

    const inSeason =
      (await isCurrentSeason(league)) || (await isPlayoffsPeriod(league));
    if (!inSeason) {
      console.info(`[Cron] League rotation: ${league} is off-season — skipped.`);
      return;
    }

    this.isRotatingLeagueInProgress = true;
    try {
      console.info(
        `[Cron] League rotation: refreshing ${league} (${this.rotatingLeagueCursor}/${leagueValues.length})`,
      );
      await this.gameService.getLeagueGames({ league });
    } catch (err) {
      console.error(`[Cron] League rotation: error refreshing ${league}:`, err);
    } finally {
      this.isRotatingLeagueInProgress = false;
    }
  }

  @Cron('2-59/10 * * * *') // EVERY 10 MINUTES, offset :02 — never same minute as the league rotation
  async fetchAndApplyScores() {
    // Never overlap the heavy refresh cycles (league rotation / oldies):
    // two concurrent third-party + Mongo cycles is one of the blocking causes.
    if (this.isHeavyRefreshRunning) {
      console.info(
        '[Cron] Skipping fetchGamesScores — heavy league refresh in progress.',
      );
      return;
    }
    try {
      // get current time in New York
      const nyNow = new Date(
        new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
      );
      const hour = nyNow.getHours();

      // run only between 11:00 (11am) and 02:00 (2am next day) New York time
      if (!(hour >= 11 || hour < 4)) {
        return;
      }

      console.info(
        `[Cron] Running fetchGamesScores cron job (NY hour=${hour})`,
      );
      const updates = await this.gameService.fetchGamesScores();
      console.info(
        '[Cron] fetchGamesScores result count:',
        updates?.length ?? 0,
      );
    } catch (err) {
      console.error('[Cron] Error running fetchGamesScores:', err);
    }
  }

  @Cron('0 10 * * *') // EVERY DAY AT 10AM
  async getOldGames() {
    // Anti-reentrancy guard: only a single heavy oldies refresh at a time. A server
    // restart can re-trigger crons while one is already running; this flag makes sure we
    // never run two big refreshes concurrently (one of the restart causes).
    if (this.isFetchingOldiesInProgress) {
      console.info(
        '[Cron] Oldies refresh already in progress - skipping this tick (reentrancy guard).',
      );
      return;
    }

    this.isFetchingOldiesInProgress = true;
    try {
      const currentYear = new Date().getFullYear();
      const maxYearsBeforeDelete = this.gameService.maxYearBeforeDelete; // 10
      const minYear = currentYear - maxYearsBeforeDelete;

      // 1. Pick a random league from the League enum
      const leagueValues = Object.values(League);
      const randomLeague =
        leagueValues[Math.floor(Math.random() * leagueValues.length)];

      // 2. Pick a single random year to refresh per run, instead of looping over all
      // 11 years at once. This dramatically limits the per-tick work volume, which was
      // one of the causes of the Render restarts during the data update. It will take up to
      // ~11 days to cover the whole window, one year per day.
      const randomYear =
        minYear + Math.floor(Math.random() * (currentYear - minYear + 1));

      console.info(
        `[Cron] Oldies refresh: checking league ${randomLeague} for year ${randomYear} (1 of up to ${maxYearsBeforeDelete + 1} years, one per tick).`,
      );

      try {
        // Dry-run comparison: API games vs games already in DB (nothing saved)
        const status = await this.gameService.getSeasonStatus(
          randomLeague,
          randomYear,
        );

        // The current season (or upcoming) is still in progress: always refresh it.
        if (status.isCurrentSeason) {
          console.info(
            `[Cron] ${randomLeague} ${randomYear}: current season - refreshing it.`,
          );
          await this.gameService.getOldiesGames(
            randomYear.toString(),
            randomLeague,
          );
        } else if (status.complete) {
          console.info(
            `[Cron] ${randomLeague} ${randomYear}: ${status.obtained} games already in DB (${status.stored}/${status.obtained}) - skipping (no modification; will be retried on a later day].`,
          );
        } else {
          console.info(
            `[Cron] ${randomLeague} ${randomYear}: DB has ${status.stored}/${status.obtained} games - refreshing this season.;`,
          );
          await this.gameService.getOldiesGames(
            randomYear.toString(),
            randomLeague,
          );
        }
      } catch (error) {
        console.error(
          `[Cron] Error checking ${randomLeague} for ${randomYear}:`,
          error,
        );
      }
    } finally {
      this.isFetchingOldiesInProgress = false;
    }
  }

  @Cron('7-59/12 * * * *') // EVERY 12 MINUTES, offset :07 — never same minute as the rotation / scores
  async checkLeagueGamesAvailability() {
    if (this.isHeavyRefreshRunning) {
      console.info(
        '[Cron] Skipping checkLeagueGamesAvailability — heavy league refresh in progress.',
      );
      return;
    }
    try {
      const laNow = new Date(
        new Date().toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles',
        }),
      );
      const hour = laNow.getHours();
      if (hour < 0 || hour >= 11) {
        return;
      }

      console.info(
        `[Cron] Running checkLeagueGamesAvailability cron job (LA hour=${hour})`,
      );
      await this.gameService.checkLeagueGamesAvailability();
    } catch (err) {
      console.error('[Cron] Error running checkLeagueGamesAvailability:', err);
    }
  }

  @Cron('0 3,15 * * *') // TWICE DAILY AT 3AM & 3PM (UTC) — purge the oldest month of games
  async purgeOldestMonth() {
    try {
      console.info('[Cron] Running monthly purge of oldest games...');
      const result = await this.gameService.purgeOldestMonth();

      if (result.action === 'purged') {
        console.info(
          `[Cron] Purged ${result.deletedCount} games from ${result.purgedYear}-${result.purgedMonth?.toString().padStart(2, '0')}. Remaining years: ${result.remainingYears?.join(', ')}`,
        );
      } else {
        console.info('[Cron] No games to purge.');
      }
    } catch (err) {
      console.error('[Cron] Error running monthly purge:', err);
    }
  }

  @Cron('0 */6 * * *') // EVERY 6 HOURS
  async monitorDiskCapacity() {
    try {
      console.info('[Cron] Running disk capacity check...');
      const result = await this.gameService.purgeOldestYearsIfNeeded();

      if (result.action === 'purged') {
        console.warn(
          `[Cron] Purged years: ${result.purgedYears?.join(', ')}. Remaining years: ${result.remainingYears?.join(', ')}`,
        );
      } else {
        console.info(
          `[Cron] Disk usage: ${(result.diskUsage.percentage * 100).toFixed(1)}% - No purge needed.`,
        );
      }
    } catch (err) {
      console.error('[Cron] Error running disk capacity check:', err);
    }
  }
}
