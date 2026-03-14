import { League } from './enum';
import {
  capitalize,
  getLeagueConfig,
  getLuminance,
  isInThePeriod,
  needRefresh,
  randomNumber,
} from './utils'; // Adaptez le chemin

describe('Utility Functions', () => {
  describe('randomNumber', () => {
    it('should return a number between 0 and max', () => {
      const max = 10;
      const result = randomNumber(max);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(max);
    });
  });

  describe('capitalize', () => {
    it('should capitalize the first letter of each word and lowercase the rest', () => {
      expect(capitalize('hello world')).toBe('Hello World');
      expect(capitalize('MAJOR LEAGUE SOCCER')).toBe('Major League Soccer');
      expect(capitalize('nba')).toBe('Nba');
    });

    it('should handle empty strings or undefined', () => {
      expect(capitalize('')).toBe('');
      expect(capitalize(undefined as any)).toBe('');
    });
  });

  describe('getLuminance', () => {
    it('should calculate luminance correctly for hex colors', () => {
      // Blanc: (0.2126 * 255) + (0.7152 * 255) + (0.0722 * 255) = 255
      expect(getLuminance('#FFFFFF')).toBeCloseTo(255);
      // Noir: 0
      expect(getLuminance('#000000')).toBe(0);
      // Un gris spécifique
      expect(getLuminance('#808080')).toBeGreaterThan(0);
    });

    it('should handle invalid hex codes gracefully', () => {
      expect(getLuminance('invalid-hex')).toBeNaN();
    });
  });

  describe('Logic Season & Refresh (getLeagueConfig / isInThePeriod)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should return true for needRefresh if games object is empty', () => {
      expect(needRefresh(League.NHL, {})).toBe(true);
    });

    it('should return false for needRefresh if updateDate is recent', () => {
      jest.setSystemTime(new Date('2024-01-05'));
      const mockGames = {
        '2024-01-05': [{ updateDate: '2024-01-04' }],
      };
      expect(needRefresh(League.NHL, mockGames)).toBe(false);
    });

    it('should handle missing updateDate gracefully', () => {
      jest.setSystemTime(new Date('2024-01-05'));
      const mockGames = { '2024-01-05': [{}] };

      expect(needRefresh(League.NHL, mockGames)).toBe(true);
    });

    it('should return 3 days refresh during NHL regular season (Oct to April)', () => {
      // On simule le 15 Novembre 2025
      jest.setSystemTime(new Date('2025-11-15'));

      const mockGames = {
        '2025-11-15': [{ updateDate: '2025-11-13' }], // 2 jours d'écart
      };

      // En saison régulière NHL, refresh = 3 jours.
      // 2 jours < 3 jours => false
      expect(needRefresh(League.NHL, mockGames)).toBe(false);

      // 4 jours d'écart => true
      const oldGames = {
        '2025-11-15': [{ updateDate: '2025-11-10' }],
      };
      expect(needRefresh(League.NHL, oldGames)).toBe(true);
    });

    it('should return 1 day refresh during Playoffs (MLS example)', () => {
      // MLS EndSeason: 10, EndPlayoffs: 12. On simule le 15 Novembre.
      jest.setSystemTime(new Date('2025-11-15'));

      const mockGames = {
        '2025-11-15': [{ updateDate: '2025-11-14' }], // ~1.5 jour d'écart
      };

      // En playoffs, refresh = 1 jour.
      expect(needRefresh(League.MLS, mockGames)).toBe(true);
    });

    it('should handle Olympic years correctly (Winter 2026)', () => {
      // Février 2026 (Année % 4 === 2)
      jest.setSystemTime(new Date('2026-02-10'));

      const mockGames = {
        '2026-02-10': [{ updateDate: '2026-02-07' }],
      };

      // C'est la saison olympique, refresh attendu à 3 jours.
      // 3 jour d'écart => true
      expect(needRefresh(League['OLYMPICS-MEN'], mockGames)).toBe(true);
    });

    describe('getLeagueConfig', () => {
      it('should return the correct league config for OLYMPICS-MEN during Winter Olympics', () => {
        jest.setSystemTime(new Date('2026-02-15'));
        const config = getLeagueConfig(League['OLYMPICS-MEN']);
        expect(config.league).toBe('olympics.men');
      });

      it('should return the correct league config for OLYMPICS-WOMEN during Summer Olympics', () => {
        jest.setSystemTime(new Date('2028-07-01')); // July 2028, Summer Olympics
        const config = getLeagueConfig('OLYMPICS-WOMEN');
        expect(config.sport).toBe('basket');
        expect(config.league).toBe('olympics.women');
      });

      it("should return the default config for Olympics when it's not Olympics year", () => {
        jest.setSystemTime(new Date('2027-06-01'));
        const config = getLeagueConfig(League['OLYMPICS-MEN']);
        expect(config.startSeason).toBe('99');
        expect(config.endSeason).toBe('99');
        expect(config.endPlayoffs).toBe('99');
      });

      it('should handle the edge case of month boundaries for Winter Olympics', () => {
        jest.setSystemTime(new Date('2026-03-31'));
        let config = getLeagueConfig('OLYMPICS-MEN');
        expect(config.sport).toBe('hockey');

        jest.setSystemTime(new Date('2026-04-01'));
        const config2 = getLeagueConfig(League['OLYMPICS-MEN']);
        expect(config2.startSeason).toBe('99');
      });

      it('should handle summer olympics at the start and end of the period', () => {
        jest.setSystemTime(new Date('2028-05-01'));
        const config = getLeagueConfig('OLYMPICS-WOMEN');
        expect(config.sport).toBe('basket');

        jest.setSystemTime(new Date('2028-09-30'));
        const config2 = getLeagueConfig('OLYMPICS-WOMEN');
        expect(config2.sport).toBe('basket');

        jest.setSystemTime(new Date('2028-04-30'));
        const config3 = getLeagueConfig(League['OLYMPICS-WOMEN']);
        expect(config3.startSeason).toBe('99');

        jest.setSystemTime(new Date('2028-10-01'));
        const config4 = getLeagueConfig(League['OLYMPICS-WOMEN']);
        expect(config4.startSeason).toBe('99');
      });

      it('should handle winter olympics at the start and end of the period', () => {
        jest.setSystemTime(new Date('2026-01-01'));
        const config = getLeagueConfig('OLYMPICS-MEN');
        expect(config.sport).toBe('hockey');
      });
    });

    it('should return off-season refresh (7 days) when no Olympics are active', () => {
      // Juin 2025 (Pas d'Olympiques)
      jest.setSystemTime(new Date('2025-06-10'));

      const mockGames = {
        '2025-06-10': [{ updateDate: '2025-06-05' }], // 5 jours d'écart
      };

      // Hors saison = 7 jours. 5 < 7 => false
      expect(needRefresh(League['OLYMPICS-MEN'], mockGames)).toBe(false);
    });

    describe('isInThePeriod', () => {
      it('should return true if the date is within the period', () => {
        jest.setSystemTime(new Date('2024-03-15'));
        expect(isInThePeriod('03', '05')).toBe(true);
      });

      it('should return false if the date is outside the period', () => {
        jest.setSystemTime(new Date('2024-01-15'));
        expect(isInThePeriod('03', '05')).toBe(false);
      });
    });

    it('isInThePeriod should handle year spanning seasons correctly', () => {
      jest.setSystemTime(new Date('2024-01-15'));
      expect(isInThePeriod('10', '04')).toBe(true); // Oct to April

      jest.setSystemTime(new Date('2024-11-15'));
      expect(isInThePeriod('10', '04')).toBe(true); // Oct to April

      jest.setSystemTime(new Date('2024-05-15'));
      expect(isInThePeriod('10', '04')).toBe(false);

      jest.setSystemTime(new Date('2024-09-15'));
      expect(isInThePeriod('10', '04')).toBe(false);
    });
  });
});
