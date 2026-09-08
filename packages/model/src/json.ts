import { z } from "zod";

/** Any value that survives a JSON round trip. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/** Free-form bag for facts the IR does not model as first-class fields yet. */
export const PropertiesSchema = z.record(z.string(), JsonValueSchema);
export type Properties = z.infer<typeof PropertiesSchema>;
