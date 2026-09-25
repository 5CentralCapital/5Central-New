/**
 * Review case lifecycle. Commands move a case through research, proposal,
 * application and verification; the detector reconciler may reopen a resolved
 * case or auto-verify one whose cause is no longer detected.
 */
export const REVIEW_CASE_STATES = ["open", "researching", "proposed", "applied", "verified", "blocked"] as const;
export type ReviewCaseState = (typeof REVIEW_CASE_STATES)[number];

export const REVIEW_CASE_STATE_LABELS: Readonly<Record<ReviewCaseState, string>> = Object.freeze({
  open: "Open",
  researching: "Researching",
  proposed: "Fix proposed",
  applied: "Applied",
  verified: "Verified",
  blocked: "Blocked",
});

/** Active queue states: everything not yet verified. */
export const REVIEW_CASE_ACTIVE_STATES: readonly ReviewCaseState[] = ["open", "researching", "proposed", "applied", "blocked"];
export const REVIEW_CASE_RESOLVED_STATES: readonly ReviewCaseState[] = ["applied", "verified"];

/** Explicit user transitions (commands). Re-proposing replaces the proposal. */
export const REVIEW_CASE_TRANSITIONS: Readonly<Record<ReviewCaseState, readonly ReviewCaseState[]>> = Object.freeze({
  open: ["researching", "proposed", "blocked"],
  researching: ["proposed", "blocked"],
  proposed: ["researching", "proposed", "applied", "blocked"],
  blocked: ["researching", "proposed"],
  applied: ["verified", "open"],
  verified: ["open"],
});

/** States the reconciler may auto-verify when the cause is no longer detected. */
export const REVIEW_CASE_AUTO_RESOLVABLE_STATES: readonly ReviewCaseState[] = ["open", "researching", "proposed", "blocked", "applied"];

export function canTransitionReviewCase(from: ReviewCaseState, to: ReviewCaseState): boolean {
  return REVIEW_CASE_TRANSITIONS[from].includes(to);
}

export function isResolvedReviewCaseState(state: ReviewCaseState): boolean {
  return REVIEW_CASE_RESOLVED_STATES.includes(state);
}

export const REVIEW_CASE_COMMAND_KINDS = [
  "review_case.detect",
  "review_case.start_research",
  "review_case.add_evidence",
  "review_case.propose",
  "review_case.block",
  "review_case.apply",
  "review_case.verify",
  "review_case.reopen",
  "review_case.note",
] as const;
export type ReviewCaseCommandKind = (typeof REVIEW_CASE_COMMAND_KINDS)[number];

/** The command that produces each target state. */
export const REVIEW_CASE_TRANSITION_COMMANDS: Readonly<Partial<Record<ReviewCaseState, ReviewCaseCommandKind>>> = Object.freeze({
  researching: "review_case.start_research",
  proposed: "review_case.propose",
  blocked: "review_case.block",
  applied: "review_case.apply",
  verified: "review_case.verify",
  open: "review_case.reopen",
});

/** Commands that must name the revision the caller read. */
export const REVIEW_CASE_REVISIONED_COMMANDS: readonly ReviewCaseCommandKind[] = [
  "review_case.start_research", "review_case.propose", "review_case.block", "review_case.apply", "review_case.verify", "review_case.reopen",
];

export const REVIEW_CASE_MCP_TOOL_NAMES: Readonly<Record<ReviewCaseCommandKind, string>> = Object.freeze({
  "review_case.detect": "run_review_detection",
  "review_case.start_research": "start_review_case_research",
  "review_case.add_evidence": "add_review_case_evidence",
  "review_case.propose": "propose_review_case_correction",
  "review_case.block": "block_review_case",
  "review_case.apply": "apply_review_case_correction",
  "review_case.verify": "verify_review_case",
  "review_case.reopen": "reopen_review_case",
  "review_case.note": "add_review_case_note",
});

/** The parts of a proposed fix that decide whether it can be applied here. */
export interface ReviewCaseProposalShape {
  readonly input: { readonly kind: "operational" | "financial" | "connection" };
  readonly routing?: unknown;
}

/**
 * Commands available to a person for a case in this state (UI and detail
 * reads). Apply is offered only when the server can act on the proposal: a
 * connection fix is made outside the case, and a financial fix is routed to
 * Accounting once.
 */
export function allowedReviewCaseCommands(state: ReviewCaseState, proposal?: ReviewCaseProposalShape | null): ReviewCaseCommandKind[] {
  const commands: ReviewCaseCommandKind[] = [];
  for (const target of REVIEW_CASE_TRANSITIONS[state]) {
    const command = REVIEW_CASE_TRANSITION_COMMANDS[target];
    if (command === "review_case.apply" && (!proposal || proposal.input.kind === "connection" || (proposal.input.kind === "financial" && proposal.routing))) continue;
    if (command && !commands.includes(command)) commands.push(command);
  }
  if (!isResolvedReviewCaseState(state)) commands.push("review_case.add_evidence");
  commands.push("review_case.note");
  return commands;
}

export function nextReviewAction(state: ReviewCaseState, resolution: "operational" | "financial" | "connection", blockedOn: string | null, proposal?: ReviewCaseProposalShape | null): string {
  const kind = proposal?.input.kind ?? resolution;
  switch (state) {
    case "open": return "Start research";
    case "researching": return "Propose a fix or record the missing fact";
    case "proposed": return kind === "financial" ? (proposal?.routing ? "Post the correction in Accounting" : "Route the fix to Accounting") : kind === "connection" ? "Fix the connection, then check again" : "Apply the proposed fix";
    case "blocked": return blockedOn ? `Obtain: ${blockedOn}` : "Obtain the missing fact";
    case "applied": return "Verify";
    case "verified": return "None";
  }
}
