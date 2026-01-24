/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

const tintColorLight = '#0a7ea4';
const tintColorDark = '#fff';

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

interface ColorsType {
  light: ThemeColors;
  dark: ThemeColors;
  default: TeamColors;
  [key: string]: ThemeColors | TeamColors; // Index signature for dynamic team keys
}

export const Colors: ColorsType = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
  },
  default: {
    color: '#ffffff',
    backgroundColor: '#000000',
  },
  'MLB-ARI': {
    color: '#aa1f2e',
    backgroundColor: '#000000',
  },
  'MLB-ATH': {
    color: '#006241',
    backgroundColor: '#efb21e',
  },
  'MLB-ATL': {
    color: '#0c2340',
    backgroundColor: '#ba0c2f',
  },
  'MLB-BAL': {
    color: '#df4601',
    backgroundColor: '#000000',
  },
  'MLB-BOS': {
    backgroundColor: '#0d2b56',
    color: '#bd3039',
  },
  'MLB-CHC': {
    color: '#0e3386',
    backgroundColor: '#cc3433',
  },
  'MLB-CHW': {
    color: '#000000',
    backgroundColor: '#c4ced4',
  },
  'MLB-CIN': {
    color: '#ffffff',
    backgroundColor: '#c6011f',
  },
  'MLB-CLE': {
    backgroundColor: '#002b5c',
    color: '#e31937',
  },
  'MLB-COL': {
    backgroundColor: '#33006f',
    color: '#000000',
  },
  'MLB-DET': {
    color: '#002d5c',
    backgroundColor: '#ff6600',
  },
  'MLB-HOU': {
    color: '#002d62',
    backgroundColor: '#eb6e1f',
  },
  'MLB-KC': {
    color: '#004687',
    backgroundColor: '#7ab2dd',
  },
  'MLB-LAA': {
    color: '#ba0021',
    backgroundColor: '#c4ced4',
  },
  'MLB-LAD': {
    color: '#ffffff',
    backgroundColor: '#005a9c',
  },
  'MLB-MIA': {
    color: '#00a3e0',
    backgroundColor: '#000000',
  },
  'MLB-MIL': {
    color: '#13294b',
    backgroundColor: '#ffc72c',
  },
  'MLB-MIN': {
    color: '#031f40',
    backgroundColor: '#e20e32',
  },
  'MLB-NYM': {
    backgroundColor: '#002d72',
    color: '#ff5910',
  },
  'MLB-NYY': {
    color: '#132448',
    backgroundColor: '#c4ced4',
  },
  'MLB-PHI': {
    color: '#e81828',
    backgroundColor: '#003278',
  },
  'MLB-PIT': {
    backgroundColor: '#000000',
    color: '#fdb827',
  },
  'MLB-SD': {
    color: '#3e2312',
    backgroundColor: '#ffc425',
  },
  'MLB-SF': {
    color: '#fd5a1e',
    backgroundColor: '#000000',
  },
  'MLB-SEA': {
    color: '#005c5c',
    backgroundColor: '#0c2c56',
  },
  'MLB-STL': {
    color: '#be0a14',
    backgroundColor: '#001541',
  },
  'MLB-TB': {
    color: '#092c5c',
    backgroundColor: '#8fbce6',
  },
  'MLB-TEX': {
    backgroundColor: '#003278',
    color: '#c0111f',
  },
  'MLB-TOR': {
    color: '#134a8e',
    backgroundColor: '#6cace5',
  },
  'MLB-WSH': {
    color: '#ab0003',
    backgroundColor: '#11225b',
  },
  'NBA-ATL': {
    color: '#c8102e',
    backgroundColor: '#fdb927',
  },
  'NBA-BOS': {
    backgroundColor: '#008348',
    color: '#ffffff',
  },
  'NBA-BKN': {
    color: '#fffffe',
    backgroundColor: '#000000',
  },
  'NBA-CHA': {
    color: '#008ca8',
    backgroundColor: '#1d1060',
  },
  'NBA-CHI': {
    color: '#ce1141',
    backgroundColor: '#000000',
  },
  'NBA-CLE': {
    color: '#860038',
    backgroundColor: '#bc945c',
  },
  'NBA-DAL': {
    color: '#0064b1',
    backgroundColor: '#bbc4ca',
  },
  'NBA-DEN': {
    color: '#0e2240',
    backgroundColor: '#fec524',
  },
  'NBA-DET': {
    color: '#1d428a',
    backgroundColor: '#c8102e',
  },
  'NBA-GS': {
    color: '#fdb927',
    backgroundColor: '#1d428a',
  },
  'NBA-HOU': {
    color: '#ce1141',
    backgroundColor: '#000000',
  },
  'NBA-IND': {
    color: '#002d62',
    backgroundColor: '#fdbb30',
  },
  'NBA-LAC': {
    backgroundColor: '#1d428a',
    color: '#c8102e',
  },
  'NBA-LAL': {
    color: '#552583',
    backgroundColor: '#fdb927',
  },
  'NBA-MEM': {
    color: '#5d76a9',
    backgroundColor: '#12173f',
  },
  'NBA-MIA': {
    color: '#98002e',
    backgroundColor: '#000000',
  },
  'NBA-MIL': {
    color: '#00471b',
    backgroundColor: '#eee1c6',
  },
  'NBA-MIN': {
    color: '#266092',
    backgroundColor: '#79bc43',
  },
  'NBA-NO': {
    color: '#0a2240',
    backgroundColor: '#b4975a',
  },
  'NBA-NY': {
    backgroundColor: '#1d428a',
    color: '#f58426',
  },
  'NBA-OKC': {
    color: '#007ac1',
    backgroundColor: '#ef3b24',
  },
  'NBA-ORL': {
    color: '#0077c0',
    backgroundColor: '#c4ced4',
  },
  'NBA-PHI': {
    color: '#1d428a',
    backgroundColor: '#e01234',
  },
  'NBA-PHX': {
    color: '#29127a',
    backgroundColor: '#e56020',
  },
  'NBA-POR': {
    color: '#e03a3e',
    backgroundColor: '#000000',
  },
  'NBA-SAC': {
    color: '#5a2d81',
    backgroundColor: '#6a7a82',
  },
  'NBA-SA': {
    color: '#000000',
    backgroundColor: '#c4ced4',
  },
  'NBA-TOR': {
    color: '#d91244',
    backgroundColor: '#000000',
  },
  'NBA-UTAH': {
    color: '#000000',
    backgroundColor: '#fff21f',
  },
  'NBA-WSH': {
    color: '#e31837',
    backgroundColor: '#002b5c',
  },
  'NFL-ARI': {
    backgroundColor: '#a4113e',
    color: '#ffffff',
  },
  'NFL-ATL': {
    color: '#a71930',
    backgroundColor: '#000000',
  },
  'NFL-BAL': {
    backgroundColor: '#29126f',
    color: '#9E7C0C',
  },
  'NFL-BUF': {
    color: '#00338d',
    backgroundColor: '#d50a0a',
  },
  'NFL-CAR': {
    color: '#0085ca',
    backgroundColor: '#000000',
  },
  'NFL-CHI': {
    color: '#0b1c3a',
    backgroundColor: '#e64100',
  },
  'NFL-CIN': {
    color: '#fb4f14',
    backgroundColor: '#000000',
  },
  'NFL-CLE': {
    color: '#472a08',
    backgroundColor: '#ff3c00',
  },
  'NFL-DAL': {
    color: '#002a5c',
    backgroundColor: '#b0b7bc',
  },
  'NFL-DEN': {
    color: '#0a2343',
    backgroundColor: '#fc4c02',
  },
  'NFL-DET': {
    color: '#0076b6',
    backgroundColor: '#bbbbbb',
  },
  'NFL-GB': {
    color: '#204e32',
    backgroundColor: '#ffb612',
  },
  'NFL-HOU': {
    color: '#00143f',
    backgroundColor: '#c41230',
  },
  'NFL-IND': {
    color: '#ffffff',
    backgroundColor: '#003b75',
  },
  'NFL-JAX': {
    color: '#007487',
    backgroundColor: '#d7a22a',
  },
  'NFL-KC': {
    color: '#e31837',
    backgroundColor: '#ffb612',
  },
  'NFL-LAC': {
    color: '#0080c6',
    backgroundColor: '#ffc20e',
  },
  'NFL-LAR': {
    color: '#003594',
    backgroundColor: '#ffd100',
  },
  'NFL-LV': {
    color: '#000000',
    backgroundColor: '#a5acaf',
  },
  'NFL-MIA': {
    color: '#008e97',
    backgroundColor: '#fc4c02',
  },
  'NFL-MIN': {
    color: '#4f2683',
    backgroundColor: '#ffc62f',
  },
  'NFL-NE': {
    color: '#002a5c',
    backgroundColor: '#c60c30',
  },
  'NFL-NO': {
    color: '#d3bc8d',
    backgroundColor: '#000000',
  },
  'NFL-NYG': {
    color: '#003c7f',
    backgroundColor: '#c9243f',
  },
  'NFL-NYJ': {
    backgroundColor: '#115740',
    color: '#ffffff',
  },
  'NFL-PHI': {
    color: '#A5ACAF',
    backgroundColor: '#000000',
  },
  'NFL-PIT': {
    color: '#000000',
    backgroundColor: '#ffb612',
  },
  'NFL-SF': {
    color: '#aa0000',
    backgroundColor: '#b3995d',
  },
  'NFL-SEA': {
    color: '#002a5c',
    backgroundColor: '#69be28',
  },
  'NFL-TB': {
    color: '#bd1c36',
    backgroundColor: '#3e3a35',
  },
  'NFL-TEN': {
    color: '#4b92db',
    backgroundColor: '#002a5c',
  },
  'NFL-WSH': {
    color: '#5a1414',
    backgroundColor: '#ffb612',
  },
  'NHL-ANA': {
    color: '#000000',
    backgroundColor: '#f47a38',
  },
  'NHL-ARI': {
    color: '#e2d6b5',
    backgroundColor: '#8c2633',
  },
  'NHL-BOS': {
    color: '#000000',
    backgroundColor: '#ffb81c',
  },
  'NHL-BUF': {
    color: '#ffb81c',
    backgroundColor: '#003087',
  },
  'NHL-CAR': {
    color: '#ffffff',
    backgroundColor: '#ce1126',
  },
  'NHL-CBJ': {
    color: '#ce1126',
    backgroundColor: '#002654',
  },
  'NHL-CGY': {
    color: '#faaf19',
    backgroundColor: '#d2001c',
  },
  'NHL-CHI': {
    color: '#000000',
    backgroundColor: '#cf0a2c',
  },
  'NHL-COL': {
    color: '#a2aaad',
    backgroundColor: '#6f263d',
  },
  'NHL-DAL': {
    backgroundColor: '#8f8f8c',
    color: '#006847',
  },
  'NHL-DET': {
    color: '#ffffff',
    backgroundColor: '#ce1126',
  },
  'NHL-EDM': {
    color: '#ff4c00',
    backgroundColor: '#041e42',
  },
  'NHL-FLA': {
    color: '#041e42',
    backgroundColor: '#c8102e',
  },
  'NHL-LA': {
    color: '#a2aaad',
    backgroundColor: '#111111',
  },
  'NHL-LAK': {
    color: '#a2aaad',
    backgroundColor: '#111111',
  },
  'NHL-MIN': {
    color: '#a6192e',
    backgroundColor: '#154734',
  },
  'NHL-MTL': {
    color: '#af1e2d',
    backgroundColor: '#192168',
  },
  'NHL-NJ': {
    color: '#000000',
    backgroundColor: '#ce1126',
  },
  'NHL-NJD': {
    color: '#000000',
    backgroundColor: '#ce1126',
  },
  'NHL-NSH': {
    color: '#ffb81c',
    backgroundColor: '#041e42',
  },
  'NHL-NYI': {
    color: '#00539b',
    backgroundColor: '#f47d30',
  },
  'NHL-NYR': {
    color: '#0033a0',
    backgroundColor: '#c8102e',
  },
  'NHL-OTT': {
    color: '#b79257',
    backgroundColor: '#da1a32',
  },
  'NHL-PHI': {
    color: '#000000',
    backgroundColor: '#f74902',
  },
  'NHL-PIT': {
    color: '#000000',
    backgroundColor: '#fcb514',
  },
  'NHL-SEA': {
    color: '#99d9d9',
    backgroundColor: '#001628',
  },
  'NHL-SJ': {
    color: '#ea7200',
    backgroundColor: '#006d75',
  },
  'NHL-SJS': {
    color: '#ea7200',
    backgroundColor: '#006d75',
  },
  'NHL-STL': {
    color: '#fcb514',
    backgroundColor: '#0000ff',
  },
  'NHL-TB': {
    backgroundColor: '#002868',
    color: '#ffffff',
  },
  'NHL-TBL': {
    backgroundColor: '#002868',
    color: '#ffffff',
  },
  'NHL-TOR': {
    color: '#ffffff',
    backgroundColor: '#00205b',
  },
  'NHL-UTA': {
    color: '#090909',
    backgroundColor: '#71afe5',
  },
  'NHL-VAN': {
    color: '#00843d',
    backgroundColor: '#00205b',
  },
  'NHL-VG': {
    color: '#b4975a',
    backgroundColor: '#333f42',
  },
  'NHL-VGK': {
    color: '#b4975a',
    backgroundColor: '#333f42',
  },
  'NHL-WPG': {
    color: '#55565a',
    backgroundColor: '#041e42',
  },
  'NHL-WSH': {
    color: '#c8102e',
    backgroundColor: '#041e42',
  },
  'PWHL-BOS': {
    color: '#b3e2d8',
    backgroundColor: '#153f36',
  },
  'PWHL-TOR': {
    color: '#0067B9',
    backgroundColor: '#0C2340',
  },
  'PWHL-OTT': {
    color: '##a51b2f',
    backgroundColor: '#fdb81e',
  },
  'PWHL-MIN': {
    color: '#9e7dc5',
    backgroundColor: ' #ffffff',
  },
  'PWHL-MTL': {
    color: '#852734',
    backgroundColor: ' #e2d4c4',
  },
  'PWHL-NY': {
    backgroundColor: '#00b9b3',
    color: '#011e42',
  },
  'PWHL-SEA': {
    color: '#0C5256',
    backgroundColor: '#E1DBC9',
  },
  'PWHL-VAN': {
    color: '#0F4777',
    backgroundColor: '#EEE9D8',
  },

  'WNBA-ATL': {
    color: '#e31837',
    backgroundColor: '#5091cc',
  },
  'WNBA-CHI': {
    color: '#5091cd',
    backgroundColor: '#ffd520',
  },
  'WNBA-CON': {
    color: '#f05023',
    backgroundColor: '#0a2240',
  },
  'WNBA-CONN': {
    color: '#f05023',
    backgroundColor: '#0a2240',
  },
  'WNBA-DAL': {
    color: '#002b5c',
    backgroundColor: '#c4d600',
  },
  'WNBA-GS': {
    color: '#b38fcf',
    backgroundColor: '#000000',
  },
  'WNBA-IND': {
    color: '#002d62',
    backgroundColor: '#e03a3e',
  },
  'WNBA-LA': {
    color: '#552583',
    backgroundColor: '#fdb927',
  },
  'WNBA-LV': {
    color: '#a7a8aa',
    backgroundColor: '#000000',
  },
  'WNBA-MIN': {
    color: '#266092',
    backgroundColor: '#79bc43',
  },
  'WNBA-NY': {
    color: '#86cebc',
    backgroundColor: '#000000',
  },
  'WNBA-PHX': {
    color: '#3c286e',
    backgroundColor: '#e56020',
  },
  'WNBA-SEA': {
    color: '#2c5235',
    backgroundColor: '#fee11a',
  },
  'WNBA-WSH': {
    color: '#e03a3e',
    backgroundColor: '#002b5c',
  },
};
