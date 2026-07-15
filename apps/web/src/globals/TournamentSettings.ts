import type { GlobalConfig } from "payload";

const expansionOptions = [
  "Classic",
  "TBC",
  "WotLK",
  "Cataclysm",
  "MoP",
  "WoD",
  "Legion",
  "BfA",
  "Shadowlands",
  "Dragonflight",
  "The War Within",
  "Midnight",
].map((value) => ({ label: value, value }));

export const TournamentSettings = {
  slug: "tournament-settings",
  label: "Tournament Control",
  admin: {
    group: "Tournament",
    description: "Control the active event, page copy, and viewer destinations.",
  },
  access: {
    read: () => true,
    update: ({ req: { user } }) => Boolean(user),
  },
  fields: [
    {
      type: "tabs",
      tabs: [
        {
          label: "Event",
          fields: [
            {
              type: "row",
              fields: [
                {
                  name: "expansion",
                  type: "select",
                  required: true,
                  defaultValue: "TBC",
                  options: expansionOptions,
                  admin: { width: "50%" },
                },
                {
                  name: "season",
                  type: "number",
                  required: true,
                  min: 1,
                  defaultValue: 2,
                  admin: { width: "25%", step: 1 },
                },
                {
                  name: "week",
                  type: "number",
                  required: true,
                  min: 1,
                  defaultValue: 1,
                  admin: { width: "25%", step: 1 },
                },
              ],
            },
            {
              name: "heroSlogan",
              type: "text",
              required: true,
              defaultValue: "Win. Stay. Climb.",
            },
          ],
        },
        {
          label: "Signup & rules",
          fields: [
            {
              type: "row",
              fields: [
                {
                  name: "hordeCharacter",
                  type: "text",
                  required: true,
                  defaultValue: "Hydramon-Spineshatter",
                  admin: { width: "50%" },
                },
                {
                  name: "allianceCharacter",
                  type: "text",
                  required: true,
                  defaultValue: "hydraa-Spineshatter",
                  admin: { width: "50%" },
                },
              ],
            },
            {
              name: "signupCommand",
              type: "text",
              required: true,
              defaultValue: "!koth",
            },
            {
              name: "rules",
              type: "array",
              required: true,
              minRows: 1,
              defaultValue: [
                { text: "Rank 1 players: Gladiator cutoff rating minimum." },
                { text: "All other players: within 150 rating of your season high." },
                { text: "Play until you lose. Your best streak lands on the leaderboard." },
                { text: "The top score wins the donation pool." },
              ],
              fields: [{ name: "text", type: "textarea", required: true }],
            },
          ],
        },
        {
          label: "Power-ups",
          fields: [
            {
              name: "soulstoneText",
              type: "textarea",
              required: true,
              defaultValue:
                "Type SS in party chat within 15 seconds after the gates open. If you lose, you stay in.",
            },
            {
              name: "bloodlustText",
              type: "textarea",
              required: true,
              defaultValue:
                "Type BL in party chat within 15 seconds after the gates open. Win before Eyes spawn and it counts as two wins.",
            },
          ],
        },
        {
          label: "Viewer actions",
          fields: [
            {
              type: "row",
              fields: [
                {
                  name: "resurrectionPrice",
                  type: "text",
                  required: true,
                  defaultValue: "$5 × current wins",
                  admin: { width: "50%" },
                },
                {
                  name: "shufflePrice",
                  type: "text",
                  required: true,
                  defaultValue: "$30",
                  admin: { width: "50%" },
                },
              ],
            },
            {
              name: "resurrectionText",
              type: "textarea",
              required: true,
              defaultValue:
                "Resurrect an eliminated contestant within two minutes. Maximum once per contestant.",
            },
            {
              name: "shuffleText",
              type: "textarea",
              required: true,
              defaultValue: "Randomize the queue order.",
            },
          ],
        },
        {
          label: "Links & sponsors",
          fields: [
            {
              name: "twitchUrl",
              type: "text",
              required: true,
              defaultValue: "https://www.twitch.tv/hydramist",
            },
            {
              name: "donationUrl",
              type: "text",
              required: true,
              defaultValue: "https://streamlabs.com/hydramist",
            },
            {
              name: "sponsorCredit",
              type: "text",
              required: true,
              defaultValue: "KOTH is sponsored by Hamsti.",
            },
          ],
        },
      ],
    },
  ],
} satisfies GlobalConfig;
