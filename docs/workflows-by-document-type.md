# Workflows by document type

In the organizer, the special education evaluation (FIE) workflow existed to
reach a valid **potential determination**: reviewers read the evidence, an
agreement step compared them, and a supervisor checkpoint signed off. Other
document types need a different workflow, and each may need its own.

This file lists the document types Sasha is most likely to serve. For each,
write down what its workflow should produce and how it should get there.
Phase 6 (PLAN §6.7) builds the workflows from these notes.

Each entry has three prompts:

- **Outcome:** the one thing the workflow should produce, like the FIE's
  potential determination.
- **Steps / checks:** what gets read, compared, scored or approved along the way,
  and where a person must sign off.
- **Notes:** anything else, such as inputs, failure cases or examples.

Status: **In catalog** means the type exists in `src/catalog/types/` now.
**Planned** means it is in PLAN §5.2 but not yet authored. **Candidate** means
it is a likely addition that is not in the plan yet.

---

## Generic workflows (all types)

These are already planned for every type (PLAN §6.7). Note any changes.

1. **Source coverage review:** score how well the linked sources and data cover
   the type's needs, flag gaps, and propose public web resources.
2. **Restructure to type:** map existing content onto another type's outline,
   with a checkpoint before applying.
3. **Draft all empty sections:** draft from notes and sources, then score
   against the rubric.

**Notes:**

- **Shared steps.** The type workflows below reuse seven steps. Building each
  once covers all 21 types.
  - **Gate:** confirm the required inputs are linked. If one is missing, stop
    and list it. This is source coverage review run as pass or fail.
  - **Extract:** pull the structured items the checks need, such as scores,
    claims, requirements or budget lines.
  - **Trace:** link each item to its support and flag items with none.
  - **Compute:** recalculate numbers in code: totals, dates, page counts,
    statistics.
  - **Independent review:** two or three reviewers work without seeing each
    other's output.
  - **Agreement:** compare reviewers item by item. Carry agreements forward and
    show each disagreement with both rationales. No averaging.
  - **Checkpoint:** a named person approves, edits or rejects. The workflow
    records who and when.
- **Outcomes.** Every outcome is advisory until its checkpoint, in the same way
  the FIE's result is a *potential* determination. Each outcome takes one of a
  few fixed values, and "blocked: missing input" is always one of them. Every
  finding links to the passage and source it rests on.
- **Checkpoints.** One per workflow, placed where a person owns the decision.
  Workflows with no decision to own have none; the author accepts or dismisses
  each finding.
- **Reviewer independence.** Reviewers that share a model and a prompt tend to
  make the same mistakes, so their agreement is weak evidence. Give each a
  different brief, for example one builds the case and one looks for
  disconfirming evidence.
- **Requirement sets.** Limits, criteria and checklists (state eligibility
  criteria, NIH and NSF rules, reporting guidelines) change on the agencies'
  schedules. Store them as dated data beside the type, apart from the workflow
  logic.
- **Changes to the three generic workflows:**
  1. Source coverage review: proposed web resources stay marked unverified until
     a person accepts them. For clinical types, search queries must carry no
     student details.
  2. Restructure to type: the checkpoint shows a mapping table that includes
     content with no home in the target outline, so nothing drops silently. Text
     moves verbatim; rewording is a separate step.
  3. Draft all empty sections: each drafted sentence carries its note or source,
     and a sentence with no source is marked as such. Off by default for NIH
     (see that entry).

---

## Clinical

### Full and Individual Evaluation (FIE): In catalog (`fie`)

- **Outcome:** A potential determination. For each suspected disability category
  it states criteria met, not met, or insufficient evidence, and whether the
  student needs special education and related services as a result. Each
  criterion links to the evidence for and against. It stays potential until the
  supervisor signs; the ARD committee makes the eligibility decision.
- **Steps / checks:**
  1. Gate: consent date, referral concerns, suspected categories, and the data
     each category requires. In Texas, for example, other health impairment
     needs a physician, physician assistant or advanced practice registered
     nurse to identify or confirm the health problem, and specific learning
     disability needs a classroom observation and data showing appropriate
     instruction.
  2. Extract: an evidence table from the linked sources (source, date,
     instrument, score or observation, area assessed).
  3. Coverage: every area related to the suspected disability is assessed, a
     variety of sources is used, and no single measure decides a category (34
     CFR 300.304).
  4. Independent review: two or more reviewers apply the state criteria to the
     evidence table and rate each criterion with cited evidence.
  5. Exclusions: check whether lack of appropriate instruction in reading or
     math, or limited English proficiency, is the determinant factor (34 CFR
     300.306(b)). For specific learning disability, add the state's further
     exclusions.
  6. Agreement: criterion by criterion. Disagreements go to the supervisor with
     both rationales.
  7. Compute and trace: scores in the narrative match the evidence table, and
     each conclusion and recommendation traces to evidence.
  8. Checkpoint: the supervisor reviews the potential determination and every
     disagreement, edits and signs. The determination section enters the report
     only after this.
- **Notes:**
  - Inputs: referral, consent, score reports and protocols, rating scales,
    observations, parent and teacher input, school records, health, vision and
    hearing, prior evaluations.
  - Criteria vary by state. The catalog type uses Texas terms (FIE, ARD, LSSP),
    so treat the criteria as a requirement set that can be swapped per state.
    Texas criteria: 19 TAC §89.1040.
  - Deadlines are worth showing beside the outcome. Texas: the report is due by
    the 45th school day after written consent, extended by the days absent when
    the student misses three or more school days; the ARD committee decides
    within 30 calendar days of the report; the parent gets the report at least
    five school days before that meeting. End-of-year exceptions apply (19 TAC
    §89.1011).
  - Failure cases: a score copied wrong from the protocol; one measure carrying
    a category; reviewers agreeing because they share a brief; wording that
    reads as a decision already made.
  - Student records are protected (FERPA). Limit web lookups for this type to
    public material such as regulations and test manuals.

### IEP / individualized plan: Candidate

- **Outcome:** A draft goal set with a needs-to-goals trace. Each need the
  evaluation identified maps to a measurable annual goal or a stated reason for
  none, and each goal has a baseline, a measurement method and a supporting
  service. It is a proposal for the IEP team, which includes the parent.
- **Steps / checks:**
  1. Gate: a current evaluation with identified needs, plus present levels of
     performance.
  2. Extract: needs and present-level data from the evaluation; goals, services
     and accommodations from the draft.
  3. Trace both ways: flag needs with no goal and goals with no documented need.
  4. Goal check: each goal names the condition, an observable behavior, a
     criterion and a date within a year. The baseline uses the same measure and
     unit as the criterion.
  5. Progress check: each goal says how progress is measured and when it is
     reported to the parent (34 CFR 300.320(a)(3)).
  6. Service check: each goal has a service or support behind it, with start
     date, frequency, location and duration (300.320(a)(4) and (7)).
  7. Checkpoint: the case manager approves the draft for the meeting. The team
     adopts or changes the goals there.
- **Notes:**
  - Inputs: evaluation report, prior IEP with progress data, grade-level
    standards, parent concerns.
  - Failure cases: verbs that cannot be observed (understand, improve); a target
    at or below the baseline; baseline and target in different units; goals
    carried over unchanged from last year.
  - Label every output as a draft. A plan that looks finished before the meeting
    undercuts the parent's part in the decision.
  - Requirements to key off student data: benchmarks or short-term objectives
    for students who take alternate assessments (300.320(a)(2)(ii)); transition
    goals no later than the IEP in effect at age 16, earlier in some states
    (300.320(b)).
  - "Individualized plan" also covers 504 plans, IFSPs and treatment plans. The
    trace (need, goal, measure, service) carries over; the requirement set
    changes.

---

## Grants

### NIH Specific Aims + Research Strategy: In catalog (`nih-specific-aims-research-strategy`)

- **Outcome:** A mock summary statement: an Overall Impact score (1 to 9, with
  the reviewers' range), criterion scores for Factor 1 and Factor 2, a
  sufficiency rating for Factor 3, and the three to five weaknesses most likely
  to drive the score, each tied to a passage. This is the fundability summary.
- **Steps / checks:**
  1. Gate: the activity code and funding opportunity (NOFO), which set page
     limits and any extra criteria.
  2. Compute: Specific Aims is 1 page. Research Strategy is 12 pages for R01,
     R15 and U01 and 6 pages for R03 and R21, unless the NOFO says otherwise.
  3. Aims check: each aim has a testable objective and an expected outcome; no
     aim depends on another succeeding; each aim maps to an Approach subsection;
     the scope fits the project period.
  4. Independent review: three reviewers, the NIH minimum, each write strengths
     and weaknesses and score Factor 1, Importance of the Research
     (Significance, Innovation), and Factor 2, Rigor and Feasibility (Approach),
     from 1 to 9.
  5. Rigor checks inside Factor 2: controls, sample size justification, analysis
     plan, biological variables such as sex or age, pitfalls and alternatives,
     timeline.
  6. Factor 3, Expertise and Resources: rate sufficient or gaps identified when
     biosketches and facilities are linked. Otherwise report "not rated".
  7. Agreement: where Overall Impact differs by two or more points, each
     reviewer responds to the others once, then rescores. Report the median, the
     range, and the mean times 10, which is the form NIH reports.
  8. No required checkpoint. The PI decides what to revise.
- **Notes:**
  - Significance, Innovation and Approach now sit inside two scored factors.
    NIH's simplified framework covers most research project grants with due
    dates from January 25, 2025.
  - NIH does not treat applications, or sections, substantially developed by AI
    as the applicant's original ideas (NOT-OD-25-132, effective September 25,
    2025). Keep "Draft all empty sections" off by default for this type, and
    limit Sasha to critique, checks and edits the PI approves passage by
    passage.
  - Since the January 2026 council round, NIH institutes do not rely on
    paylines. The summary should report scores and weaknesses and make no award
    prediction from a cutoff.
  - Calibration: model reviewers may cluster scores in the middle. NIAID
    publishes sample applications with their summary statements, which can serve
    as a test set.
  - Not assessed by this type: human subjects, vertebrate animals, biohazards,
    budget. Say so in the output.
  - The mock review is for the applicant's own draft. NIH bars its peer
    reviewers from putting applications they review into generative AI tools
    (NOT-OD-23-149).

### NSF Project Description + Broader Impacts + Data Management Plan: Planned

- **Outcome:** A mock panel summary: strengths and weaknesses under Intellectual
  Merit and under Broader Impacts with an overall rating, plus a separate
  compliance result. Compliance stands apart because NSF can return a
  non-compliant proposal without review.
- **Steps / checks:**
  1. Gate: the solicitation or program description, and the PAPPG version in
     force. The solicitation governs where the two differ.
  2. Compute (compliance): the Project Description is 15 pages or fewer,
     counting figures and Results from Prior NSF Support (5 pages or fewer);
     "Broader Impacts" is a heading on its own line; the Project Description
     contains no URLs; prior-support results appear when any PI or co-PI has NSF
     funding that is current or ended in the past five years, with Intellectual
     Merit and Broader Impacts under separate headings.
  3. Independent review: three reviewers assess both criteria on NSF's five
     review elements (potential, creativity, a sound plan with a way to assess
     success, qualifications, resources).
  4. Broader Impacts check: named activities, who carries them out, the
     resources, and how success is assessed. Flag activities limited to a group
     defined by a protected characteristic; NSF's current priorities statement
     says outreach and participation activities must be open to all Americans.
  5. Data plan check: data types named in the Project Description appear in the
     plan; data supporting publications is shared at publication or the
     exception is justified; a collaborative proposal carries one plan.
  6. Agreement, then the panel summary.
  7. No required checkpoint. The PI decides; the institution's authorized
     representative submits.
- **Notes:**
  - Rename the type's third part. NSF now calls it the Data Management and
    Sharing Plan (DMSP). Since April 27, 2026 it is built in a Research.gov
    tool, and the earlier two-page limit is gone (PAPPG 24-1 Supplement 2, NSF
    26-202). Confirm the tool's fields before authoring the outline.
  - PAPPG 24-1 is still the current guide, with Supplements 1 and 2 (NSF 26-200,
    NSF 26-202).
  - Rating: reviewers use a five-level scale (Excellent, Very Good, Good, Fair,
    Poor). Confirmed in secondary sources only; check it against the current
    reviewer form.
  - Failure cases: Broader Impacts written as intentions with no plan to assess
    them; a data plan that contradicts the methods; text moved into References
    to get around the page limit.
  - Outside this type but required in a full proposal: the one-page Project
    Summary with Overview, Intellectual Merit and Broader Impacts.

### Foundation letter of inquiry / general proposal: Planned

- **Outcome:** A fit decision: proceed to a full proposal, proceed with changes,
  or do not proceed. It carries an eligibility result (pass or fail) and, for
  each funder priority, the evidence of fit.
- **Steps / checks:**
  1. Gate: the funder's guidelines (priorities, eligibility, geography, grant
     range, deadlines, LOI format).
  2. Eligibility (pass or fail, checked first): tax status or fiscal sponsor,
     geography, population served, excluded uses, and whether the funder accepts
     unsolicited requests.
  3. Fit: set each stated priority beside what the letter says, quote against
     quote. Flag passages that repeat the funder's wording with no matching
     activity or result.
  4. Ask check: the amount sits within the funder's usual range, matches the
     project budget, and appears in the opening paragraph.
  5. Format: length limits and required elements (need, project, outcomes,
     amount, timeline, organization).
  6. Checkpoint: the executive director or development lead confirms the
     decision, since proceeding commits staff time and a funder relationship.
- **Notes:**
  - Inputs: guidelines or call text, the organization's mission and budget, any
    history with the funder. Prior contact with a program officer sits outside
    the documents, so ask for it.
  - Past grants show a funder's real priorities and typical award size. Private
    foundations list grants in Form 990-PF, which the coverage review can
    propose as a source.
  - Where the funder publishes a scoring rubric or out-of-scope screens, score
    against those in place of inferred priorities.
  - Failure cases: strong fit scores hiding an eligibility failure; a letter
    reused across funders; an ask far outside the funder's range.
  - The general proposal variant adds the budget and timeline checks from
    `proposal`.

### Proposal (general): In catalog (`proposal`)

- **Outcome:** A go or no-go readiness decision: ready to send, ready after
  listed fixes, or not ready. It lists each inconsistency among budget, timeline
  and deliverables that blocks sending.
- **Steps / checks:**
  1. Extract: deliverables, milestones and dates, budget lines, staffing,
     assumptions, terms.
  2. Trace: every deliverable has a date, a cost and an owner; every budget line
     maps to a deliverable or activity.
  3. Compute: line items sum to the totals; rates times quantities match; effort
     times rate matches labor cost; dates run in order and each dependency
     precedes what depends on it.
  4. Scope check: the summary, the scope of work and the pricing describe the
     same work. Flag promises that appear in only one.
  5. Where an RFP or brief is linked: a compliance matrix showing where each
     requirement is answered.
  6. Terms check: assumptions, exclusions, acceptance criteria, validity period
     and payment terms are stated.
  7. Checkpoint: the person who can commit the price and dates signs before
     sending.
- **Notes:**
  - Inputs: RFP or client brief, rate card, and the pricing spreadsheet itself
    so the arithmetic can be rerun.
  - Failure cases: budget revised and narrative left behind; a summary that
    promises more than the scope of work; a timeline with no time for client
    review.
  - The same trace and arithmetic serve a grant budget and its justification, so
    the grant types can call these steps.

---

## Business

### Business plan: In catalog (`business-plan`)

- **Outcome:** A readiness review for a named audience, investor or lender:
  ready, needs work, or not ready. It lists each place the narrative and the
  financials disagree, and the open risks in order of weight.
- **Steps / checks:**
  1. Gate: the audience, and financial projections linked as a spreadsheet.
  2. Extract: assumptions from the narrative (market size, price, customers,
     growth, hiring, timing) and from the model (revenue build, costs, capital
     spending, funding).
  3. Compute (tie-out): customers times price equals revenue; the hiring plan
     matches payroll; use of funds sums to the amount sought; runway equals cash
     over burn; revenue implies a believable market share.
  4. Compute (statements): the balance sheet balances, net income flows to cash
     flow and equity, and cash stays above zero or financing is shown.
  5. Audience check. Lender: repayment source, debt service coverage,
     collateral, owner's equity. Investor: bottom-up market sizing, unit
     economics, traction evidence, use of funds tied to milestones.
  6. Risks: rank assumptions by effect on the result and by how little support
     they have. Flag claims with no source.
  7. Checkpoint: the owner resolves each unsupported assumption by sourcing it,
     changing it or accepting it as a stated risk.
- **Notes:**
  - Failure cases: top-down sizing (a small share of a large market); growth
    with no stated driver; narrative edited after the model.
  - Lenders set their own thresholds for debt service coverage. Take the number
    from the lender.
  - The review reports consistency and readiness. It gives no view on whether to
    invest or lend.

### Product requirements document (PRD): In catalog (`product-requirements`)

- **Outcome:** A build-readiness decision: ready to build, ready with listed
  open items, or not ready. Each requirement is marked testable or not, and each
  open question has an owner.
- **Steps / checks:**
  1. Extract: problem, goals and success metrics, users, numbered requirements,
     non-goals, open questions, dependencies.
  2. Testability: each requirement has an observable acceptance criterion. Flag
     vague terms (fast, easy, intuitive), compound requirements, and
     non-functional requirements with no number.
  3. Trace (scope): each requirement serves a goal; none falls under a non-goal;
     each goal has requirements; each metric has a baseline, a target and a data
     source.
  4. Gaps: conflicts between requirements; empty, error and edge states;
     permissions; migration; analytics; accessibility.
  5. Independent review by role: engineering (can this be estimated?), design
     (are states and flows defined?), QA (can a test be written for each
     requirement?).
  6. Agreement: a "cannot proceed" from any role is a blocker. Open questions
     block unless marked non-blocking, with an owner and a date.
  7. Checkpoint: the product owner and engineering lead accept the decision.
- **Notes:**
  - Have the QA reviewer write a test case for each requirement. A requirement
    with no writable test is untestable, and the test list is a useful
    by-product.
  - Failure cases: a solution specified with no problem; missing non-goals;
    metrics with no baseline; requirements hidden in prose or mockups.
  - Inputs: linked designs and research. Flag requirements the designs
    contradict.

### Strategy memo / review: Planned

- **Outcome:** A recommendation (adopt, revise or reject) with a coherence
  result for the strategy's three parts and the three strongest objections, each
  paired with the memo's answer or marked unanswered.
- **Steps / checks:**
  1. Extract the three parts: diagnosis, guiding policy, actions.
  2. Coherence: the diagnosis names a specific challenge and rests on evidence
     in the sources; the guiding policy answers the diagnosis and says what will
     not be done; the actions follow from the policy, support each other, and
     have owners, resources and timing.
  3. Flag the common failures: goals or metrics standing in for strategy, a
     challenge left unnamed, a list of unrelated initiatives, no alternative
     considered.
  4. Independent review by stance: a competitor's response, a finance view of
     trade-offs, an operator's view of execution, a customer's view. Each gives
     its strongest objection and the evidence that would change its mind.
  5. Agreement: rank objections by how much they would change the
     recommendation. Each must cite a passage and a mechanism.
  6. Checkpoint: the author answers or accepts each top objection before the
     memo goes to its audience.
- **Notes:**
  - The three-part test is Rumelt's kernel from *Good Strategy Bad Strategy*.
  - Failure cases: objections that fit any strategy ("execution risk"); a red
    team that argues weakly. Ask for each objection in its strongest form.
  - The review variant, looking back at a strategy in use, adds a check of
    results against what the strategy predicted.

---

## Technical

### Design doc / RFC: In catalog (`design-doc-rfc`)

- **Outcome:** A recommended review decision: approve, approve with changes, or
  reject. It gives reasons, the required changes, and each finding marked
  blocking or non-blocking.
- **Steps / checks:**
  1. Gate: problem, goals and non-goals, and a proposed design. Link the
     repository or architecture docs where possible.
  2. Alternatives: at least two real alternatives, one of them "do nothing",
     compared on the same criteria. The reviewer adds any obvious missing
     option.
  3. Independent review by lens: correctness and architecture; operations and
     reliability; security and privacy; data and migration where relevant.
  4. Rollout: phases or flags, migration, backward compatibility, a rollback
     path with how long it takes, and the metrics that mean stop.
  5. Trace: claims about the current system are checked against the linked code
     and docs. Without access, mark them unverified.
  6. Agreement: any unresolved blocking finding makes the decision approve with
     changes or reject.
  7. Checkpoint: the named approvers decide. Record the decision, date and
     conditions.
- **Notes:**
  - Mark each decision reversible or hard to reverse, and spend review effort on
    the second kind.
  - Failure cases: a single strawman alternative; no rollback; cost and on-call
    load left out; a doc written after the code.
  - The recorded decision can be saved as an architecture decision record beside
    the doc.

### Standard operating procedure (SOP): In catalog (`standard-operating-procedure`)

- **Outcome:** An approval-ready result: the procedure can be carried out as
  written (yes or no), with every gap listed by step, followed by an approval
  record with approver, date, version, effective date and next review date.
- **Steps / checks:**
  1. Extract: purpose, scope, roles, materials, prerequisites, steps, warnings,
     QC checks, records, references, revision history.
  2. Dry run: a reviewer acts as an operator holding only the listed materials
     and the text. It logs every point where it must guess: a missing quantity,
     setting, unit, duration or tolerance; an undefined term; an unclear actor;
     a judgment call with no criterion ("as needed").
  3. Second dry run with a different brief, a new hire against an experienced
     operator. Agreement: report gaps found by either.
  4. Safety: each hazard has a warning placed before the step it applies to;
     protective equipment, stop conditions and disposal are covered.
  5. QC: each check has a numeric acceptance criterion, a path for failure, a
     record to keep and a verifier.
  6. Document control: owner, version, effective and review dates, current
     references, change log.
  7. Checkpoint (required): the process owner and the quality or safety approver
     sign. Sasha records the approval and never grants it.
- **Notes:**
  - Inputs: referenced forms, equipment manuals, and the regulation or standard
    the procedure implements.
  - A dry run on paper has limits. For high-stakes procedures, have the approver
    confirm at the checkpoint that someone walked through it physically.
  - Failure cases: several actions in one step; warnings placed after the step;
    "see supervisor" as the only decision rule; a step that needs an item
    missing from the materials list.
  - Safety and QC requirements differ by setting (lab, clinical, manufacturing,
    IT runbooks). Keep one requirement set per setting.

### Diátaxis how-to guide: In catalog (`diataxis-how-to`)

- **Outcome:** A goal result: the steps achieve the stated goal for a competent
  reader, or they do not. It names the step where the walkthrough failed and
  lists passages that belong in another Diátaxis type.
- **Steps / checks:**
  1. Extract the goal from the title and opening. The title should name it ("How
     to rotate an API key").
  2. Walkthrough: a reviewer with the stated prerequisites follows the steps.
     Run them in a sandbox where the guide is executable; otherwise simulate and
     mark the result unverified. The end state must equal the goal.
  3. Flag missing steps, unstated prerequisites and steps out of order.
  4. Type check: classify each passage as a step, brief context, teaching,
     explanation or reference. Flag the last three and propose a link target.
  5. Fit: the guide handles the variations a working reader meets ("if you use
     X, do Y") and states prerequisites without teaching them.
  6. No checkpoint. The author accepts or dismisses each finding.
- **Notes:**
  - The type check is shared by all four Diátaxis types. Build one classifier on
    the framework's two axes (action or cognition; study or work) and reuse it.
  - Offer flagged passages to "Restructure to type" as the seed of the sibling
    document.
  - Failure case: a simulated walkthrough passes steps that fail in practice.
    Report which steps were executed and which were only read.

### Diátaxis tutorial: In catalog (`diataxis-tutorial`)

- **Outcome:** A completion result: a beginner starting clean can finish it (yes
  or no), with a table showing, for each step, the stated visible result and
  whether the walkthrough saw it.
- **Steps / checks:**
  1. Gate: the starting state (what the learner needs installed and already
     knows) and the end result, both stated at the top.
  2. Beginner walkthrough from a clean environment: the reviewer does exactly
     what is written, uses only the stated prior knowledge, and stops at the
     first ambiguity.
  3. Per step: a visible result is stated and matches what happened; commands
     and code are complete; no step offers a choice.
  4. Type check: flag explanation longer than a sentence or two, reference
     material, and alternatives.
  5. Second run from clean to confirm the same result. Record versions.
  6. No checkpoint.
- **Notes:**
  - Execution matters most here: the framework asks a tutorial to work for every
    learner, every time. Run runnable tutorials in a sandbox.
  - A model is a weak stand-in for a beginner because it fills gaps without
    noticing. The stop-at-first-ambiguity rule reduces this; one person new to
    the topic remains the better test before publishing.
  - Failure cases: steps with no stated result; output shown that differs from
    real output; version drift.

### Diátaxis reference: Planned

- **Outcome:** A sync result against the source of truth: in sync or out of
  sync, with a diff of items missing from the reference, items the source lacks,
  and mismatches.
- **Steps / checks:**
  1. Gate: the source of truth (an OpenAPI file, schema, CLI help output, code
     signatures). Without it the workflow checks internal consistency only and
     says so.
  2. Extract: an inventory from each side (items, parameters, types, defaults,
     required flags, enums, errors, deprecations).
  3. Compute the diff: missing, stale, mismatched.
  4. Consistency: every entry follows one pattern and field order; names are
     uniform; the structure mirrors the product's.
  5. Examples: validate each against the schema or run it.
  6. Type check: flag instructions, explanation and opinion.
  7. No checkpoint. A mismatch does not show which side is wrong, so the owner
     decides whether to fix the doc or the source.
- **Notes:**
  - Mostly deterministic. Do the inventory and diff in code, and use the model
    to map prose to items.
  - Best triggered when the source changes, as well as on demand.
  - Where the reference is generated from the source, the workflow reduces to
    descriptions and examples.

### Diátaxis explanation: Planned

- **Outcome:** A soundness result: sound, sound with gaps, or unsound. It lists
  unsupported or incorrect claims, breaks in the reasoning, and instructional
  passages to move.
- **Steps / checks:**
  1. Extract the question the piece answers (often "why" or "about") and check
     the topic has a boundary.
  2. Claim map: each claim and the reasoning that links claims. Mark each claim
     sourced, common knowledge, stated opinion or unsupported.
  3. Trace: check sourced and factual claims against the linked sources. Flag
     contradictions.
  4. Reasoning: conclusions follow from the claims; alternatives and trade-offs
     are considered; context and history are accurate.
  5. Explain-back: a reader answers three to five "why" questions from the text
     alone. A wrong or missing answer marks a gap.
  6. Type check: flag step-by-step instructions and reference tables.
  7. Checkpoint (optional): a subject expert confirms flagged factual claims
     when no source is linked.
- **Notes:**
  - Opinion and perspective belong in explanation. The check is that opinion is
    marked as opinion.
  - Failure cases: a how-to under an explanation title; history asserted from
    memory; one design defended with no alternative discussed.

---

## Academic

### Research report (IMRaD): In catalog (`research-report-imrad`)

- **Outcome:** A simulated editorial decision (accept, minor revision, major
  revision or reject) with a claims-to-evidence table: each claim marked
  supported, overstated or unsupported by the methods and results.
- **Steps / checks:**
  1. Gate: the study design, which selects the reporting guideline through
     EQUATOR (CONSORT for randomized trials, STROBE for observational studies,
     PRISMA for systematic reviews).
  2. Extract: each claim in the abstract, results and discussion, with the
     result and the method behind it.
  3. Trace: mark each claim supported, overstated or unsupported. Overstated
     covers causal wording from a correlational design, generalizing past the
     sample, and conclusions the analysis did not test.
  4. Methods: the design fits the question; sample size is justified; controls,
     randomization and blinding are described; the analysis matches the design;
     multiple comparisons and missing data are handled; limitations are stated.
  5. Compute: sample counts add up across tables; percentages match counts;
     reported statistics agree with each other; abstract numbers match the body.
  6. Guideline checklist: each item present or absent, with its location.
  7. Independent review: two or three reviewers, then an editor pass that writes
     the decision letter. Agreement: disagreements appear in the letter.
  8. No checkpoint. The corresponding author decides what to revise.
- **Notes:**
  - Inputs: target journal, plus data and analysis code where available.
  - Limits: the simulation cannot detect fabricated data, and its views on
    novelty and journal fit are low confidence. Label them.
  - For someone else's manuscript, as in journal peer review, the journal's
    confidentiality policy governs whether it can be uploaded at all.
  - CONSORT was updated in 2025. Load guideline checklists as dated requirement
    sets.

### Literature review: Candidate

- **Outcome:** A coverage and synthesis result for the stated research question:
  adequate or gaps found. It lists likely missing sources with reasons, claims
  with no citation, and citations that could not be verified.
- **Steps / checks:**
  1. Gate: the research question, the scope (dates, fields, inclusion rules) and
     the kind of review (narrative, scoping, systematic).
  2. Citation integrity: each citation resolves to a real source, and the cited
     claim matches what the source says. Mark "could not verify" where the text
     is out of reach.
  3. Uncited claims: flag every empirical claim with no citation.
  4. Coverage: search on the question and follow citations backward and forward
     from the review's key sources. List candidates that are heavily cited,
     recent, or at odds with the review.
  5. Synthesis: organized by theme or argument; agreements, contradictions and
     gaps named; each theme tied to the question; disconfirming evidence
     included.
  6. Systematic reviews only: search strategy, screening flow and quality
     appraisal are reported (PRISMA 2020).
  7. Checkpoint: the author accepts or dismisses each candidate source. Sasha
     proposes citations and never inserts them.
- **Notes:**
  - Coverage is bounded by what Sasha can search. Report it as "no gaps found in
    the sources searched" and list those sources. Subscription databases are out
    of reach unless connected.
  - Failure cases: source-by-source summary with no synthesis; a real paper
    cited for something it does not say; a review that stops several years back.
  - Step 2 applies to every type that cites. Build it as a shared step.

---

## Policy

### Policy / decision memo: In catalog (`policy-decision-memo`)

- **Outcome:** A recommended option with the options-by-criteria matrix behind
  it and the conditions that would change it. The decision-maker's choice is
  recorded at the checkpoint.
- **Steps / checks:**
  1. Gate: the decision, the decision-maker, the deadline, at least two options
     plus the status quo, and stated criteria.
  2. Criteria check: criteria are defined apart from the options. Flag a
     criterion only one option can meet, and options that lack authority, budget
     or time.
  3. Trace: each cell of the matrix has evidence. Mark it supported, estimated
     or unsupported.
  4. Independent review: reviewers rate each cell with a rationale. Agreement
     builds the matrix and shows disagreements.
  5. Sensitivity: does the recommendation change under a different priority
     order, or if the least certain estimate moves? Report those conditions.
  6. Consistency: the memo's recommendation matches the matrix, or the memo says
     why it departs.
  7. Form: recommendation first, then options, risks, cost and next steps.
  8. Checkpoint (required): the decision-maker approves the recommendation,
     picks another option, defers or asks for more. Record the decision, date
     and reason.
- **Notes:**
  - Use ordinal ratings and the conditions from step 5. A single weighted total
    suggests more precision than the evidence has.
  - Value trade-offs and political feasibility belong to the decision-maker.
    Report stakeholder positions as stated and take no side.
  - Failure cases: options built to make one look good; no status quo; costs for
    one option only; the recommendation buried late in the memo.

---

## General and career

### General report: In catalog (`general-report`)

- **Outcome:** A support result: sound or gaps found. Each finding is marked
  supported, partly supported or unsupported by the sources, and each
  recommendation is traced to the findings behind it.
- **Steps / checks:**
  1. Extract: findings, conclusions, recommendations.
  2. Trace findings to source passages or data. Flag a finding with no source,
     one the source contradicts, and one resting on an outdated source.
  3. Compute: figures, dates, units and quotations match the source exactly.
  4. Trace recommendations to findings. Flag recommendations with no finding
     behind them and major findings that lead nowhere.
  5. Summary check: the executive summary adds no claim, and its numbers match
     the body.
  6. Recommendations name who acts, what they do and by when.
  7. No required checkpoint. The author resolves each flag.
- **Notes:**
  - This is the default for any type with no workflow of its own.
  - Show the result as an annotated view: each claim carries its status and a
    link to the source passage.
  - Failure cases: a finding that paraphrases a source into a stronger claim; a
    recommendation that arrives from outside the evidence.

### Resume / CV: Planned

- **Outcome:** A resume tailored to one target role, with a match score against
  the job description before and after, and a list of requirements the
  candidate's history does not meet. Every line traces to the master resume.
- **Steps / checks:**
  1. Gate: the job description, and a master resume or work history as the
     source of truth for facts.
  2. Extract: the role's requirements, split into required and preferred, with
     responsibilities, skills and seniority signals.
  3. Trace: map each requirement to evidence in the history as direct, adjacent
     or none.
  4. Tailor: lead with matching evidence, use the posting's terms where the
     experience matches, keep the numbers the source has, trim unrelated
     content.
  5. Truth check: no new employer, title, date, degree, skill or number. Titles
     and dates stay as in the master.
  6. Score: coverage of required items (met, partly met, gap) and of preferred
     items.
  7. Format: single column, standard headings, real text, consistent dates, and
     a length that suits the field.
  8. Checkpoint (required): the candidate approves each changed line. The resume
     is their statement.
- **Notes:**
  - Report gaps plainly and suggest handling them in the cover letter.
  - The score is Sasha's estimate of fit. Employers screen differently, so
    present it as a way to compare versions.
  - CV variant: no length limit; sections for publications, grants and teaching
    in the field's usual order.
  - Save the requirement map with the tailored version so the cover letter
    workflow can reuse it.

### Cover letter: Candidate

- **Outcome:** A fit and consistency result: ready or revise. It lists the top
  requirements the letter leaves unaddressed and every mismatch with the resume.
- **Steps / checks:**
  1. Gate: the job description and the tailored resume. Reuse the resume
     workflow's requirement map.
  2. Fit: the letter answers two to four of the top requirements, each with a
     specific example, and gives a reason for this employer that draws on a
     linked source.
  3. Consistency: employers, titles, dates, numbers and skills match the resume.
     Flag any claim absent from the master history.
  4. Overlap: flag sentences that restate resume lines and add no context.
  5. Compute (form): one page; the correct company, role and addressee; no name
     left over from another application.
  6. Voice: where a writing sample is linked, flag passages that depart from it.
  7. Checkpoint: the candidate approves before sending.
- **Notes:**
  - Facts about the employer must come from linked sources (the posting, the
    employer's site). Mark anything else unverified.
  - Resume and cover letter share inputs and a requirement map. Consider one
    application workflow with a single sign-off.
  - Failure cases: a generic letter that fits any employer; a leftover company
    name; a claim the resume cannot back.

---

## Other types to add

Add any type not listed above, with the same three prompts.

Suggested candidates, not yet specified:

- **Reevaluation / review of existing evaluation data (clinical):** a decision
  on what additional data, if any, the team needs (34 CFR 300.305(a)).
- **Functional behavior assessment and behavior intervention plan (clinical):**
  a hypothesized function for the behavior, with each intervention matched to
  it.
- **Response to reviewers (academic, grants):** every reviewer comment answered
  and mapped to a change in the manuscript or application.
- **Funder progress report (grants):** each reported result tied to an objective
  in the award.
- **Incident postmortem (technical):** agreed contributing causes, and action
  items with owners and dates.

---

## Sources

Rules cited above, checked 2026-10-08. Agency rules change often; recheck before
building.

- IDEA evaluation procedures, 34 CFR 300.304:
  https://www.law.cornell.edu/cfr/text/34/300.304
- IDEA eligibility determination, 34 CFR 300.306:
  https://www.law.cornell.edu/cfr/text/34/300.306
- IDEA IEP contents, 34 CFR 300.320:
  https://www.law.cornell.edu/cfr/text/34/300.320
- Texas evaluation timelines, 19 TAC §89.1011:
  https://www.law.cornell.edu/regulations/texas/19-Tex-Admin-Code-SS-89-1011
- Texas eligibility criteria, 19 TAC §89.1040:
  https://www.law.cornell.edu/regulations/texas/19-Tex-Admin-Code-SS-89-1040
- NIH simplified peer review framework:
  https://www.grants.nih.gov/policy-and-compliance/policy-topics/peer-review/simplifying-review/framework
- NIH first-level peer review and scoring:
  https://grants.nih.gov/grants-process/review/first-level
- NIH page limits:
  https://grants.nih.gov/grants-process/write-application/how-to-apply-application-guide/page-limits
- NIH NOT-OD-25-132, AI and application originality:
  https://grants.nih.gov/grants/guide/notice-files/NOT-OD-25-132.html
- NIH NOT-OD-23-149, generative AI in peer review:
  https://grants.nih.gov/grants/guide/notice-files/NOT-OD-23-149.html
- NIH unified funding strategy and paylines:
  https://grants.nih.gov/news-events/nih-extramural-nexus-news/2025/11/implementing-a-unified-nih-funding-strategy-to-guide-consistent-and-clearer-award-decisions
- NIAID sample applications and summary statements:
  https://www.niaid.nih.gov/grants-contracts/sample-applications
- NSF PAPPG 24-1, Chapter II, proposal preparation:
  https://www.nsf.gov/policies/pappg/24-1/ch-2-proposal-preparation
- NSF PAPPG 24-1, Chapter III, merit review:
  https://www.nsf.gov/policies/pappg/24-1/ch-3-proposal-processing-review
- NSF PAPPG 24-1 Supplement 2 (NSF 26-202):
  https://www.nsf.gov/policies/document/pappg24-1-supplement-2
- NSF updates on priorities: https://nsf.gov/updates-on-priorities
- Diátaxis framework: https://diataxis.fr/
- EQUATOR Network reporting guidelines: https://www.equator-network.org/
