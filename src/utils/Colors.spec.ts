import {
  COLLEGE_LEAGUES,
  Colors,
  DEFAULT_TEAM_COLORS,
  getTeamColors,
  isDefaultTeamColors,
} from './Colors';

describe('Colors helpers', () => {
  // Synthetic keys are injected into the shared `Colors` map and removed after
  // each test so the assertions never depend on the generated ColorsTeam data.
  const testKeys = [
    'NCAAF-TESTU',
    'NCAAB-TESTU',
    'NCAAWH-TESTU',
    'NCAAMH-TESTU',
    'XYZ-TESTU',
  ];

  afterEach(() => {
    testKeys.forEach((key) => delete Colors[key]);
  });

  describe('COLLEGE_LEAGUES', () => {
    it('contains all six university leagues', () => {
      expect(COLLEGE_LEAGUES).toEqual(
        expect.arrayContaining([
          'NCAAF',
          'NCAAB',
          'NCCABB',
          'WNCAAB',
          'NCAAMH',
          'NCAAWH',
        ]),
      );
    });
  });

  describe('isDefaultTeamColors', () => {
    it('detects the white-on-black placeholder (case-insensitive)', () => {
      expect(
        isDefaultTeamColors({ color: '#ffffff', backgroundColor: '#000000' }),
      ).toBe(true);
      expect(
        isDefaultTeamColors({ color: '#FFFFFF', backgroundColor: '#000000' }),
      ).toBe(true);
    });

    it('returns false for real colors, partial objects and nullish values', () => {
      expect(
        isDefaultTeamColors({ color: '#9E1B32', backgroundColor: '#FFFFFF' }),
      ).toBe(false);
      expect(
        isDefaultTeamColors({ color: '#ffffff', backgroundColor: '#123456' }),
      ).toBe(false);
      expect(isDefaultTeamColors({})).toBe(false);
      expect(isDefaultTeamColors(null)).toBe(false);
      expect(isDefaultTeamColors(undefined)).toBe(false);
    });
  });

  describe('getTeamColors', () => {
    it('returns the exact entry when it is not a placeholder', () => {
      Colors['NCAAB-TESTU'] = {
        color: '#123456',
        backgroundColor: '#abcdef',
      };

      expect(getTeamColors('NCAAB-TESTU')).toEqual({
        color: '#123456',
        backgroundColor: '#abcdef',
      });
    });

    it('borrows the colors from another college league when the entry is missing', () => {
      Colors['NCAAF-TESTU'] = {
        color: '#111111',
        backgroundColor: '#222222',
      };

      expect(getTeamColors('NCAAB-TESTU')).toEqual({
        color: '#111111',
        backgroundColor: '#222222',
      });
    });

    it('borrows the colors from another college league when the entry is the placeholder', () => {
      Colors['NCAAMH-TESTU'] = {
        color: '#ffffff',
        backgroundColor: '#000000',
      };
      Colors['NCAAWH-TESTU'] = {
        color: '#333333',
        backgroundColor: '#444444',
      };

      expect(getTeamColors('NCAAMH-TESTU')).toEqual({
        color: '#333333',
        backgroundColor: '#444444',
      });
    });

    it('keeps the default placeholder for non-college leagues', () => {
      Colors['XYZ-TESTU'] = {
        color: '#ffffff',
        backgroundColor: '#000000',
      };

      expect(getTeamColors('XYZ-TESTU')).toEqual(DEFAULT_TEAM_COLORS);
    });

    it('returns the default placeholder when nothing can be found', () => {
      expect(getTeamColors('XYZ-NOPE')).toEqual(DEFAULT_TEAM_COLORS);
      expect(getTeamColors('NCAAB-NOPE')).toEqual(DEFAULT_TEAM_COLORS);
    });

    it('handles an empty uniqueId safely', () => {
      expect(getTeamColors('')).toEqual(DEFAULT_TEAM_COLORS);
    });
  });
});
