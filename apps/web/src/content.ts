export type TournamentContent = {
  expansion: string;
  season: number;
  week: number;
  heroSlogan: string;
  hordeCharacter: string;
  allianceCharacter: string;
  signupCommand: string;
  rules: string[];
  soulstoneText: string;
  bloodlustText: string;
  resurrectionPrice: string;
  resurrectionText: string;
  shufflePrice: string;
  shuffleText: string;
  twitchUrl: string;
  donationUrl: string;
  sponsorCredit: string;
};

export const defaultTournamentContent = {
  expansion: "TBC",
  season: 2,
  week: 1,
  heroSlogan: "Win. Stay. Climb.",
  hordeCharacter: "Hydramon-Spineshatter",
  allianceCharacter: "hydraa-Spineshatter",
  signupCommand: "!koth",
  rules: [
    "Rank 1 players: Gladiator cutoff rating minimum.",
    "All other players: within 150 rating of your season high.",
    "Play until you lose. Your best streak lands on the leaderboard.",
    "The top score wins the donation pool.",
  ],
  soulstoneText:
    "Type SS in party chat within 15 seconds after the gates open. If you lose, you stay in.",
  bloodlustText:
    "Type BL in party chat within 15 seconds after the gates open. Win before Eyes spawn and it counts as two wins.",
  resurrectionPrice: "$5 × current wins",
  resurrectionText:
    "Resurrect an eliminated contestant within two minutes. Maximum once per contestant.",
  shufflePrice: "$30",
  shuffleText: "Randomize the queue order.",
  twitchUrl: "https://www.twitch.tv/hydramist",
  donationUrl: "https://streamlabs.com/hydramist",
  sponsorCredit: "KOTH is sponsored by Hamsti.",
} as const satisfies TournamentContent;
