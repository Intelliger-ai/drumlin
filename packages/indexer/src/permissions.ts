import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { SourceLocation } from "@drumlin/model";
import { relativePath, type NextApp } from "./discover.js";
import { addSourceDirectory, createProject } from "./project.js";

/**
 * Candidate role and permission model.
 *
 * Everything here is a proposal. Drumlin can see that a route checks a role; it
 * cannot see which roles are *supposed* to reach it, and guessing produces
 * confident nonsense about access control. So this reports what it believes,
 * with how sure it is, and says plainly what it cannot determine.
 *
 * The first real app shows why the grading matters: it declares a clean
 * `UserRole` union, and separately compares a `role` field against "user" and
 * "assistant" twenty-six times — those are LLM chat message roles. A detector
 * that treated every `role === "…"` as an application role would invent two
 * roles that do not exist and look certain doing it.
 */

export interface RoleBelief {
  id: string;
  /** Why we believe this is a role. */
  reason: string;
  confidence: number;
  locations: SourceLocation[];
}

export interface RoleGroup {
  id: string;
  members: string[];
  locations: SourceLocation[];
}

export interface GuardObservation {
  /** The check as written, e.g. `hasRole(session, "admin")`. */
  check: string;
  roles: string[];
  location: SourceLocation;
}

export interface OpenQuestion {
  subject: string;
  question: string;
  candidates?: string[];
}

export interface PermissionInference {
  roles: RoleBelief[];
  /** Boolean flags that behave like permissions, e.g. `isOrgAdmin`. */
  capabilityFlags: RoleBelief[];
  groups: RoleGroup[];
  guards: GuardObservation[];
  questions: OpenQuestion[];
}

/** Type names that plausibly enumerate application roles. */
const ROLE_TYPE_NAME = /^(user)?roles?$|role(type|name|enum)$|^app(user)?role$/i;

/** Helper functions whose string arguments are roles by construction. */
const ROLE_GUARD_FUNCTIONS = new Set([
  "hasRole",
  "hasAnyRole",
  "requireRole",
  "requireAnyRole",
  "assertRole",
  "checkRole",
  "withRole",
  "isRole",
  "can",
]);

/** Fields that read as a capability rather than a role. */
const CAPABILITY_FLAG = /^(is|can|has)[A-Z]\w*$/;

/**
 * Words that appear in a `role` comparison but belong to another domain.
 *
 * Chat and agent APIs use `role` for message authorship. Excluding these by
 * name would be fragile on its own, which is why bare comparisons only ever
 * become questions, never beliefs.
 */
const FOREIGN_ROLE_WORDS = new Set([
  "user",
  "assistant",
  "system",
  "tool",
  "function",
  "model",
  "developer",
]);

export function inferPermissionModel(app: NextApp): PermissionInference {
  const project = createProject();
  const files = addSourceDirectory(project, app.root);
  const rel = (file: string): string => relativePath(app.root, file);

  const roles = new Map<string, RoleBelief>();
  const capabilityFlags = new Map<string, RoleBelief>();
  const groups: RoleGroup[] = [];
  const guards: GuardObservation[] = [];
  const questions: OpenQuestion[] = [];
  const bareComparisons = new Map<string, SourceLocation[]>();

  const believe = (
    map: Map<string, RoleBelief>,
    id: string,
    reason: string,
    confidence: number,
    location: SourceLocation,
  ): void => {
    const existing = map.get(id);
    if (!existing) {
      map.set(id, { id, reason, confidence, locations: [location] });
      return;
    }
    existing.locations.push(location);
    // Keep the strongest justification rather than the most recent.
    if (confidence > existing.confidence) {
      existing.confidence = confidence;
      existing.reason = reason;
    }
  };

  for (const file of files) {
    const source = project.getSourceFile(file);
    if (!source) continue;
    const relFile = rel(file);

    // 1. A declared union of role names. The strongest signal available.
    for (const alias of source.getTypeAliases()) {
      if (!ROLE_TYPE_NAME.test(alias.getName())) continue;
      const literals = stringLiteralsOf(alias.getTypeNode());
      if (literals.length === 0) continue;
      for (const literal of literals) {
        believe(
          roles,
          literal,
          `declared in the ${alias.getName()} union`,
          0.9,
          { file: relFile, line: alias.getStartLineNumber(), symbol: alias.getName() },
        );
      }
    }

    for (const declaration of source.getEnums()) {
      if (!ROLE_TYPE_NAME.test(declaration.getName())) continue;
      for (const member of declaration.getMembers()) {
        const value = member.getValue();
        believe(
          roles,
          typeof value === "string" ? value : member.getName(),
          `declared in the ${declaration.getName()} enum`,
          0.9,
          {
            file: relFile,
            line: member.getStartLineNumber(),
            symbol: declaration.getName(),
          },
        );
      }
    }

    // 2. Named groupings of roles, e.g. EXPERT_ROLES.
    for (const declaration of source.getVariableDeclarations()) {
      const name = declaration.getName();
      if (!/roles$/i.test(name)) continue;
      const initializer = declaration.getInitializer();
      const array = initializer?.asKind(SyntaxKind.ArrayLiteralExpression);
      if (!array) continue;
      const members = array
        .getElements()
        .map((element) => element.asKind(SyntaxKind.StringLiteral))
        .map((literal) => literal?.getLiteralValue())
        .filter((value): value is string => value !== undefined);
      if (members.length === 0) continue;
      groups.push({
        id: name,
        members,
        locations: [
          { file: relFile, line: declaration.getStartLineNumber(), symbol: name },
        ],
      });
    }

    // 3. Guard calls whose arguments are roles by construction.
    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const name = Node.isPropertyAccessExpression(callee)
        ? callee.getName()
        : callee.getText();
      if (!ROLE_GUARD_FUNCTIONS.has(name)) continue;

      const found: string[] = [];
      for (const argument of call.getArguments()) {
        const literal = argument.asKind(SyntaxKind.StringLiteral);
        if (literal) {
          found.push(literal.getLiteralValue());
          continue;
        }
        const array = argument.asKind(SyntaxKind.ArrayLiteralExpression);
        if (!array) continue;
        for (const element of array.getElements()) {
          const inner = element.asKind(SyntaxKind.StringLiteral);
          if (inner) found.push(inner.getLiteralValue());
        }
      }
      if (found.length === 0) continue;

      const location: SourceLocation = {
        file: relFile,
        line: call.getStartLineNumber(),
      };
      guards.push({ check: call.getText().slice(0, 100), roles: found, location });
      for (const role of found) {
        believe(roles, role, `passed to ${name}()`, 0.8, location);
      }
    }

    // 4. Capability flags on the session user.
    for (const access of source.getDescendantsOfKind(
      SyntaxKind.PropertyAccessExpression,
    )) {
      const name = access.getName();
      if (!CAPABILITY_FLAG.test(name)) continue;
      const receiver = access.getExpression().getText();
      if (!/(session|user|auth|account|member|profile)$/i.test(receiver)) continue;
      believe(
        capabilityFlags,
        name,
        `read from ${receiver}`,
        0.7,
        { file: relFile, line: access.getStartLineNumber() },
      );
    }

    // 5. Bare comparisons against a role-ish field. Recorded as questions.
    for (const binary of source.getDescendantsOfKind(
      SyntaxKind.BinaryExpression,
    )) {
      const operator = binary.getOperatorToken().getText();
      if (operator !== "===" && operator !== "==") continue;

      const left = binary.getLeft().getText();
      if (!/(^|\.)roles?$/i.test(left)) continue;

      const literal = binary.getRight().asKind(SyntaxKind.StringLiteral);
      if (!literal) continue;

      const value = literal.getLiteralValue();
      const bucket = bareComparisons.get(value) ?? [];
      bucket.push({ file: relFile, line: binary.getStartLineNumber() });
      bareComparisons.set(value, bucket);
    }
  }

  // A bare comparison only becomes a belief when the declared model already
  // knows the name. Otherwise it is something to ask about.
  const unexplained: string[] = [];
  for (const [value, locations] of bareComparisons) {
    if (roles.has(value)) {
      const belief = roles.get(value)!;
      belief.locations.push(...locations);
      continue;
    }
    unexplained.push(value);
  }

  if (unexplained.length > 0) {
    const likelyForeign = unexplained.filter((value) =>
      FOREIGN_ROLE_WORDS.has(value.toLowerCase()),
    );
    questions.push({
      subject: "role names",
      question:
        likelyForeign.length > 0
          ? `These values are compared against a "role" field but are not in the declared role model. ` +
            `${likelyForeign.join(", ")} look like message roles from a chat or agent API rather than user roles. Which of these are application roles?`
          : `These values are compared against a "role" field but are not in the declared role model. Which are application roles?`,
      candidates: unexplained.sort(),
    });
  }

  if (roles.size > 0) {
    questions.push({
      subject: "route access",
      question:
        "Which roles are meant to reach which routes? Nothing in the repository states this, and it cannot be inferred from the presence of a guard.",
      candidates: [...roles.keys()].sort(),
    });
  }

  if (capabilityFlags.size > 0) {
    questions.push({
      subject: "capability flags",
      question:
        "Are these roles in their own right, or permissions that several roles can hold?",
      candidates: [...capabilityFlags.keys()].sort(),
    });
  }

  const byConfidence = (a: RoleBelief, b: RoleBelief): number =>
    b.confidence - a.confidence || a.id.localeCompare(b.id);

  return {
    roles: [...roles.values()].sort(byConfidence),
    capabilityFlags: [...capabilityFlags.values()].sort(byConfidence),
    groups: groups.sort((a, b) => a.id.localeCompare(b.id)),
    guards: guards.slice(0, 50),
    questions,
  };
}

function stringLiteralsOf(node: Node | undefined): string[] {
  if (!node) return [];
  const values: string[] = [];
  for (const literal of node.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    values.push(literal.getLiteralValue());
  }
  const own = node.asKind(SyntaxKind.StringLiteral);
  if (own) values.push(own.getLiteralValue());
  return [...new Set(values)];
}
