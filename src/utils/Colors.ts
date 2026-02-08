
import { ColorsTeamEnum } from "./ColorsTeam";

interface ThemeColors {
  text: string;
  background: string;
  tint: string;
  icon: string;
  tabIconDefault: string;
  tabIconSelected: string;
}

export interface TeamColors {
  color: string;
  backgroundColor: string;
}

export const Colors: Record<string, TeamColors> = {
  default: {
    color: '#ffffff',
    backgroundColor: '#000000',
  },
 ...ColorsTeamEnum
};
