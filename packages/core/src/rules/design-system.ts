import type { Finding, JsonValue } from "@drumlin/model";
import { graphEvidence } from "./engine.js";
import type { Rule, RuleContext } from "./types.js";

/**
 * Design-system drift and controls that do not scale.
 *
 * Both rules are kept narrow. Telling a developer their component is a
 * duplicate when it is not is a false accusation about their code, and that
 * costs more trust than the finding is worth.
 */

function stringProperty(
  properties: Record<string, JsonValue> | undefined,
  key: string,
): string | undefined {
  const value = properties?.[key];
  return typeof value === "string" ? value : undefined;
}

export const duplicatePrimitive: Rule = {
  id: "ds.duplicate-primitive",
  scope: "component",
  classification: "deterministic",
  severity: "low",
  principles: ["jakobs-law", "aesthetic-usability-effect"],
  summary:
    "A local component reimplements a design-system primitive instead of using it.",
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const component of view.nodesOfType("Component")) {
      const primitive = stringProperty(
        component.properties,
        "duplicatesPrimitive",
      );
      if (!primitive) continue;

      const primitiveFile = stringProperty(
        component.properties,
        "duplicatesPrimitiveFile",
      );
      const location = component.sources?.[0];

      const evidence = [graphEvidence(component.id)];
      if (location) evidence.push({ type: "source", location });
      if (primitiveFile) {
        evidence.push({
          type: "source",
          location: { file: primitiveFile },
          note: `${primitive} primitive`,
        });
      }

      findings.push({
        ruleId: duplicatePrimitive.id,
        scope: "component",
        severity: "low",
        // Requires an exact match on both the rendered element and the full
        // variant union, so a match is strong evidence.
        confidence: 0.85,
        classification: "deterministic",
        principles: duplicatePrimitive.principles!,
        target: {
          kind: "file",
          ...(location?.file ? { file: location.file } : {}),
        },
        evidence,
        message: `${component.label ?? component.id} reimplements the ${primitive} primitive with the same variants, so the two will drift apart.`,
        proposal: `Replace ${component.label ?? "it"} with ${primitive}, extending the primitive if a variant is genuinely missing.`,
        acceptance: [
          `No component outside the design system renders the same element and variant set as ${primitive}.`,
        ],
      });
    }

    return findings;
  },
};

export const selectOverload: Rule = {
  id: "component.select-overload",
  scope: "component",
  classification: "deterministic",
  severity: "low",
  principles: ["hicks-law", "millers-law"],
  summary:
    "A select is bound to a collection whose size is not knowable, so it becomes unusable as the data grows.",
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const node of [
      ...view.nodesOfType("Screen"),
      ...view.nodesOfType("Component"),
    ]) {
      const raw = node.properties?.["unboundedSelects"];
      if (!Array.isArray(raw) || raw.length === 0) continue;

      const collections: string[] = [];
      for (const entry of raw) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          continue;
        }
        const collection = (entry as Record<string, JsonValue>)["collection"];
        if (typeof collection === "string") collections.push(collection);
      }
      if (collections.length === 0) continue;

      const location = node.sources?.[0];
      const evidence = [graphEvidence(node.id)];
      if (location) evidence.push({ type: "source", location });

      const target: Finding["target"] = { kind: "node", node: node.id };
      if (node.route !== undefined) target.route = node.route;

      findings.push({
        ruleId: selectOverload.id,
        scope: "component",
        severity: "low",
        // Whether a collection is genuinely unbounded is inferred, not proven.
        confidence: 0.6,
        classification: "deterministic",
        principles: selectOverload.principles!,
        target,
        evidence,
        message: `${view.labelOf(node.id)} fills a select from ${collections
          .slice(0, 2)
          .join(" and ")}, whose size is not knowable, with no way to search or filter.`,
        proposal:
          "Use a searchable combobox, or virtualise the list, so the control stays usable at any size.",
        acceptance: [
          "The control remains usable with a thousand options: the user can find a specific one without scrolling.",
        ],
      });
    }

    return findings;
  },
};
