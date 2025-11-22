/**
 * Interface for the root response object from the ESPN team detail endpoint.
 * (The provided JSON is missing the outer "sport" and "league" properties,
 * but includes "team", "defaultLeague", and "nextEvent" at the root level).
 */
export interface TeamDetailed {
  team: Team;
  // e.g., "usa.1"

  // The provided JSON does not explicitly include 'sport' at the root,
  // but it's often an implicit field or inferred from 'defaultLeague'.
}

// --- Team and Team-Related Interfaces ---

export interface Team {
  id: string;
  uid: string;
  defaultLeague: League;
  leagueAbbrev: string;
  slug: string; // e.g., "austin_fc"
  location: string; // e.g., "Austin FC"
  name: string; // e.g., "Austin FC"
  abbreviation: string; // e.g., "ATX"
  displayName: string; // e.g., "Austin FC"
  shortDisplayName: string; // e.g., "Austin"
  color: string;
  alternateColor: string;
  isActive: boolean;
  logos: Logo[];
  record: {}; // Empty object in this specific response. Would contain TeamRecord if available.
  groups: { id: string }; // Simplified based on the provided data.
  links: Link[];
  nextEvent: NextEvent[];
  // Roster is often a sub-endpoint and not present in this basic response.
}

export interface Logo {
  href: string;
  width: number;
  height: number;
  alt: string;
  rel: string[];
  lastUpdated: string;
}

// --- League/Competition Interfaces ---

export interface League {
  id: string;
  alternateId: string;
  name: string; // e.g., "MLS"
  abbreviation: string; // e.g., "MLS"
  shortName: string; // e.g., "MLS"
  midsizeName: string; // e.g., "USA.1"
  slug: string; // e.g., "usa.1"
  season: {
    type: {
      hasStandings: boolean;
    };
  };
  links: Link[];
  logos: Logo[];
}

// --- Next Event Interfaces ---

export interface NextEvent {
  id: string;
  date: string; // ISO 8601 date string, e.g., "2026-02-22T01:30Z"
  name: string; // e.g., "Minnesota United FC at Austin FC"
  shortName: string; // e.g., "MIN @ ATX"
  season: {
    year: number;
    displayName: string; // e.g., "2026 MLS"
  };
  seasonType: {
    id: string;
    type: number;
    name: string; // e.g., "Regular Season"
    abbreviation: string; // e.g., "2026 MLS"
  };
  timeValid: boolean;
  competitions: Competition[];
  links: Link[];
  league: League;
}

export interface Competition {
  id: string;
  date: string; // e.g., "2026-02-22T01:30Z"
  attendance: number;
  timeValid: boolean;
  neutralSite: boolean;
  boxscoreAvailable: boolean;
  ticketsAvailable: boolean;
  venue: Venue;
  competitors: Competitor[];
  notes: Note[];
  broadcasts: Broadcast[];
  tickets: Ticket[];
  status: Status;
}

export interface Competitor {
  id: string;
  type: string; // e.g., "team"
  order: number;
  homeAway: 'home' | 'away';
  winner: boolean;
  team: {
    // Simplified team object within a competition
    id: string;
    location: string;
    abbreviation: string;
    displayName: string;
    shortDisplayName: string;
    logos: Logo[];
    links: Link[];
  };
}

export interface Venue {
  fullName: string; // e.g., "Q2 Stadium"
  address: {
    city: string; // e.g., "Austin, Texas"
    country: string; // e.g., "USA"
  };
}

export interface Note {
  type: {
    id: string;
    shortName: string;
  };
  media: {
    shortName: string;
  };
  lang: string;
  region: string;
}

export interface Broadcast {
  type: {
    id: string;
    shortName: string;
  };
  media: {
    shortName: string;
  };
  lang: string;
  region: string;
}

export interface Ticket {
  id: string;
  summary: string;
  description: string;
  maxPrice: number;
  startingPrice: number;
  numberAvailable: number;
  totalPostings: number;
  links: Link[];
}

export interface Status {
  clock: number;
  addedClock: number;
  displayClock: string; // e.g., "0'"
  period: number;
  type: {
    id: string;
    name: string; // e.g., "STATUS_SCHEDULED"
    state: string; // e.g., "pre"
    completed: boolean;
    description: string; // e.g., "Scheduled"
    detail: string; // e.g., "Sat, February 21st at 8:30 PM EST"
    shortDetail: string; // e.g., "2/21 - 8:30 PM EST"
  };
}

// --- Utility Interface ---

export interface Link {
  language?: string;
  rel: string[];
  href: string;
  text: string;
  shortText: string;
  isExternal: boolean;
  isPremium: boolean;
}
