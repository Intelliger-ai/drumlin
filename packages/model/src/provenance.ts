import { z } from "zod";

/**
 * Where a fact came from. Ordered by precedence: an earlier source overrides a
 * later one, so a human confirmation always beats an inference.
 *
 * See vault/Architecture/Provenance.md and vault/Loop/Context Sources.md
 */
export const PROVENANCE_SOURCES = [
  "human",
  "repository",
  "runtime",
  "agent",
  "inferred",
  "external",
] as const;

export const ProvenanceSourceSchema = z.enum(PROVENANCE_SOURCES);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

/** Lower index wins. Used by `overrides` and by context merge. */
const PRECEDENCE: readonly ProvenanceSource[] = PROVENANCE_SOURCES;

/**
 * True when `candidate` may replace `existing`.
 *
 * Equal sources are allowed to overwrite — a fresher run of the same kind of
 * evidence supersedes a stale one. A weaker source never silently wins.
 */
export function overrides(
  candidate: ProvenanceSource,
  existing: ProvenanceSource,
): boolean {
  return PRECEDENCE.indexOf(candidate) <= PRECEDENCE.indexOf(existing);
}

export const SourceLocationSchema = z.object({
  /** Repository-relative path. Never absolute — paths must survive a clone. */
  file: z.string(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  /** Enclosing symbol, when known. More stable than a line number. */
  symbol: z.string().optional(),
});
export type SourceLocation = z.infer<typeof SourceLocationSchema>;

export const ProvenanceSchema = z.object({
  source: ProvenanceSourceSchema,
  /** Files, graph refs, or trace IDs that justify the fact. */
  evidence: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  lastVerified: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Provenance for something read directly out of the repository. */
export function fromRepository(evidence: string[], confidence = 1): Provenance {
  return { source: "repository", evidence, confidence };
}

/** Provenance for something guessed. Confidence is required in spirit. */
export function inferred(evidence: string[], confidence: number): Provenance {
  return { source: "inferred", evidence, confidence };
}

/** Provenance for a fact a human confirmed. Confidence is 1 by definition. */
export function fromHuman(evidence: string[] = []): Provenance {
  return {
    source: "human",
    evidence,
    confidence: 1,
    lastVerified: new Date().toISOString(),
  };
}
