import { Injectable, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GameService } from '../games/games.service';
import { TeamService } from '../teams/teams.service';
import { League } from '../utils/enum';

@Injectable()
export class CronService implements OnModuleInit {
  private isFetchingOldiesInProgress: boolean = false;

  constructor(
    private readonly teamService: TeamService,
    private readonly gameService: GameService,
  ) {}

  async onModuleInit() {
    console.info(
      '[Cron] Server restart: Scheduling initial fetchGamesScores...',
    );
    setTimeout(() => {
      this.gameService
        .fetchGamesScores()
        .catch((err) =>
          console.error('[Cron] initial fetchGamesScores error:', err),
        );
    }, 30000);
  }

  @Cron('30 0 1 * *') // EVERY MONTH AT 0:30AM
  async updateTeams() {
    await this.teamService.getTeams();
  }

  @Cron('0 1 1 * *') // EVERY MONTH AT 1AM
  async updateAllGames() {
    await this.gameService.getAllGames();
  }

  @Cron('0 2 * * *') // EVERY DAY AT 2AM
  async updateMLBGames() {
    await this.gameService.getLeagueGames({ league: League.MLB });
  }

  @Cron('0 3 * * *') // EVERY DAY AT 3AM
  async updateNBAGames() {
    await this.gameService.getLeagueGames({ league: League.NBA });
  }

  @Cron('0 4 * * *') // EVERY DAY AT 4AM
  async updateNFLGames() {
    await this.gameService.getLeagueGames({ league: League.NFL });
  }

  @Cron('0 5 * * *') // EVERY DAY AT 5AM
  async updateNHLGames() {
    await this.gameService.getLeagueGames({ league: League.NHL });
  }

  @Cron('0 10 * * *') // EVERY DAY AT 10AM
  async getOldGames() {
    // Anti-reentrancy guard: only a single heavy oldies refresh at a time. A server
    // restart can re-trigger crons while one is already running; this flag makes sure we
    // never run two big refreshes concurrently (one of the restart causes).
    if (this.isFetchingOldiesInProgress) {
      console.info('[Cron] Oldies refresh already in progress - skipping this tick (reentrancy guard).');
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
          console.info(`[Cron] ${randomLeague} ${randomYear}: current season - refreshing it.`);
          await this.gameService.getOldiesGames(randomYear.toString(), randomLeague);
        } else if (status.complete) {
          console.info(`[Cron] ${randomLeague} ${randomYear}: ${status.obtained} games already in DB (${status.stored}/${status.obtained}) - skipping (no modification; will be retried on a later day].`);
        } else {
          console.info(`[Cron] ${randomLeague} ${randomYear}: DB has ${status.stored}/${status.obtained} games - refreshing this season.;`);
          await this.gameService.getOldiesGames(randomYear.toString(), randomLeague);
        }
      } catch (error) {
        console.error(`[Cron] Error checking ${randomLeague} for ${randomYear}:`, error);
      }
    } finally {
      this.isFetchingOldiesInProgress = false;
    }
  }

  @Cron('*/10 * * * *') // EVERY 10 MINUTES
  async fetchAndApplyScores() {
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

      console.info(`[Cron] Running fetchGamesScores cron job (NY hour=${hour})`);
      const updates = await this.gameService.fetchGamesScores();
      console.info('[Cron] fetchGamesScores result count:', updates?.length ?? 0);
    } catch (err) {
      console.error('[Cron] Error running fetchGamesScores:', err);
    }
  }

  @Cron('*/12 * * * *') // EVERY 12 MINUTES
  async checkLeagueGamesAvailability() {
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

      console.info(`[Cron] Running checkLeagueGamesAvailability cron job (LA hour=${hour})`);
      await this.gameService.checkLeagueGamesAvailability();
    } catch (err) {
      console.error('[Cron] Error running checkLeagueGamesAvailability:', err);
    }
  }

  @Cron('0 */6 * * *') // EVERY 6 HOURS
  async monitorDiskCapacity() {
    try {
      console.info('[Cron] Running disk capacity check...');
      const result = await this.gameService.purgeOldestYearsIfNeeded();

      if (result.action === 'purged') {
        console.warn(`[Cron] Purged years: ${result.purgedYears?.join(', ')}. Remaining years: ${result.remainingYears?.join(', ')}`);
      } else {
        console.info(`[Cron] Disk usage: ${(result.diskUsage.percentage * 100).toFixed(1)}% - No purge needed.`);
      }
    } catch (err) {
      console.error('[Cron] Error running disk capacity check:', err);
    }
  }
}
