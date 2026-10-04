import { isTerminalGameStatus, TERMINAL_GAME_STATUSES } from './gameStatus';

describe('isTerminalGameStatus', () => {
  it('accepts the canonical terminal statuses', () => {
    for (const status of TERMINAL_GAME_STATUSES) {
      expect(isTerminalGameStatus(status)).toBe(true);
    }
  });

  it('accepts suffixed and lowercase variants', () => {
    expect(isTerminalGameStatus('FINAL AET')).toBe(true);
    expect(isTerminalGameStatus('FINAL PEN')).toBe(true);
    expect(isTerminalGameStatus('final')).toBe(true);
    expect(isTerminalGameStatus('Final')).toBe(true);
    expect(isTerminalGameStatus('FULL TIME')).toBe(true);
  });

  it('rejects a game that is not decided', () => {
    expect(isTerminalGameStatus(undefined)).toBe(false);
    expect(isTerminalGameStatus(null)).toBe(false);
    expect(isTerminalGameStatus('')).toBe(false);
    expect(isTerminalGameStatus('SCHEDULED')).toBe(false);
    expect(isTerminalGameStatus('IN_PROGRESS')).toBe(false);
    expect(isTerminalGameStatus('DELAYED')).toBe(false);
    expect(isTerminalGameStatus('2ND HALF')).toBe(false);
  });

  it('does not match a status merely containing a word', () => {
    expect(isTerminalGameStatus('NOT FINAL YET')).toBe(false);
    expect(isTerminalGameStatus('PRE')).toBe(false);
  });
});
