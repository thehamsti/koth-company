import type { CollectionConfig } from "payload";

export const Users = {
  slug: "users",
  admin: {
    group: "Access",
    useAsTitle: "email",
  },
  auth: true,
  fields: [
    {
      name: "name",
      type: "text",
      label: "Display name",
    },
  ],
} satisfies CollectionConfig;
