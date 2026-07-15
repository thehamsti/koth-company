import type { Access, CollectionConfig } from "payload";

const authenticated: Access = ({ req: { user } }) => Boolean(user);

export const Participants = {
  slug: "participants",
  labels: {
    singular: "Participant",
    plural: "Participants",
  },
  admin: {
    group: "Tournament",
    useAsTitle: "displayName",
    defaultColumns: ["displayName", "faction", "updatedAt"],
    description: "Reusable player directory for fast leaderboard entry and autocomplete.",
  },
  access: {
    read: () => true,
    create: authenticated,
    update: authenticated,
    delete: authenticated,
  },
  defaultSort: "displayName",
  fields: [
    {
      name: "displayName",
      type: "text",
      label: "Character name",
      required: true,
      unique: true,
      index: true,
      admin: {
        description: "Saved once, then searchable whenever this player returns.",
        placeholder: "Start typing a character name…",
      },
    },
    {
      name: "faction",
      type: "select",
      options: ["Horde", "Alliance"],
      admin: {
        description: "Optional reference for tournament operators.",
      },
    },
    {
      name: "notes",
      type: "textarea",
      admin: {
        description: "Private operator notes; never shown on the public site.",
      },
    },
  ],
} satisfies CollectionConfig;
