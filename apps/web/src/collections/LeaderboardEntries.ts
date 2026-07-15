import type { Access, CollectionConfig } from "payload";

const authenticated: Access = ({ req: { user } }) => Boolean(user);

export const LeaderboardEntries = {
  slug: "leaderboard-entries",
  labels: {
    singular: "Leaderboard entry",
    plural: "Leaderboard",
  },
  admin: {
    group: "Tournament",
    useAsTitle: "participant",
    defaultColumns: ["participant", "wins", "visible", "updatedAt"],
    description:
      "Search for a returning participant or create one inline, then enter their streak.",
  },
  access: {
    read: () => true,
    create: authenticated,
    update: authenticated,
    delete: authenticated,
  },
  defaultSort: "-wins",
  fields: [
    {
      name: "participant",
      type: "relationship",
      relationTo: "participants",
      label: "Participant",
      required: true,
      unique: true,
      admin: {
        allowCreate: true,
        allowEdit: true,
        placeholder: "Search saved participants…",
        description:
          "Type a character name to find a returning player. Use the + button to add a new one without leaving this form.",
      },
    },
    {
      type: "row",
      fields: [
        {
          name: "wins",
          type: "number",
          required: true,
          min: 0,
          defaultValue: 0,
          admin: {
            width: "50%",
            step: 1,
            description: "Their best consecutive wins for this event.",
          },
        },
        {
          name: "visible",
          type: "checkbox",
          defaultValue: true,
          label: "Show on public leaderboard",
          admin: { width: "50%" },
        },
      ],
    },
  ],
} satisfies CollectionConfig;
