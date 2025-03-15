import type { GameFormatted } from './game';
import type { TeamType } from './team';

export interface PropsCards {
  i: number;
  activeTeams: TeamType[];
  id: number;
  teamsSelectedIds: string[];
  teamSelectedId: string;
  teamsGames: GameFormatted[];
}

export interface PropsCard {
  game: GameFormatted;
  isSelected: boolean;
}

export interface TeamBodyProps {
  teamsSelectedIds: string[];
  activeTeams: TeamType[];
  teamsGames: GameFormatted[];
}
