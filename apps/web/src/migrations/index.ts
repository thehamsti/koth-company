import * as migration_20260710_213110_initial_payload_schema from "./20260710_213110_initial_payload_schema";
import * as migration_20260710_214428_participant_autocomplete from "./20260710_214428_participant_autocomplete";

export const migrations = [
  {
    up: migration_20260710_213110_initial_payload_schema.up,
    down: migration_20260710_213110_initial_payload_schema.down,
    name: "20260710_213110_initial_payload_schema",
  },
  {
    up: migration_20260710_214428_participant_autocomplete.up,
    down: migration_20260710_214428_participant_autocomplete.down,
    name: "20260710_214428_participant_autocomplete",
  },
];
