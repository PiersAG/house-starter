import "server-only";

// What crosses from the settings page (server) to each SettingControl (browser)
// — issue 794: a DTO at each parent/child boundary holding only the data that
// boundary needs. The control renders a label, a description, an input of the
// right type and the value's source, and sends back the version it showed; the
// rest of the resolved setting (its capability, group, scope flags) stays on
// the server.

import { z } from "zod";
import { defineDto } from "@/lib/dto";

export const SettingRow = defineDto({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  valueType: z.string(),
  enumValues: z.array(z.string()).optional(),
  bounds: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  effectiveValue: z.unknown(),
  source: z.enum(["factory", "operator", "owner", "client"]),
  locked: z.boolean(),
  version: z.number(),
});

export type SettingRowData = z.infer<typeof SettingRow.schema>;
