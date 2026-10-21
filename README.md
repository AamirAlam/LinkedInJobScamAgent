# Conversational scam detection Agent — v1

## Objective

Build an AI agent that detects recruitment scams under partial observability.

The agent reads a recruiting conversation sequentially and chooses:

* `SAFE`
* `HOLD`
* `FLAG`

The goal is to update scam risk as new evidence appears without using future messages or hidden labels.

---

## Agent Design

### Hidden State

The interaction is either:

* Legitimate recruiting
* Fraudulent recruiting

### Belief

At each timestep, the model outputs:

```ts
{
  scamProbability: number,
  evidenceUsed: string[],
  harmCategory:
    | "non_harmful"
    | "context_dependent"
    | "harmful",
  reasoningSummary: string
}
```

The probability is recalculated from the full visible conversation at every step.

### Policy A

```text
p <= 0.20        → SAFE
0.20 < p <= 0.70 → HOLD
p > 0.70         → FLAG
```

### Policy B

```text
If harmCategory === harmful
→ FLAG

Otherwise
→ use Policy A
```

---

## Baseline

The baseline is a simpler LLM classifier.

It receives the full conversation and returns only:

```text
SAFE
or
FLAG
```

It does not use:

* probabilities
* HOLD
* harm categories
* sequential belief updates
* policy thresholds

---

## Dataset

V1 was evaluated on:

* **43 conversations**
* **22 scams**
* **21 legitimate**

Ground-truth labels were hidden during inference.

---

## Results

| Metric          | Baseline | Policy A | Policy B |
| --------------- | -------: | -------: | -------: |
| Precision       |  100.00% |  100.00% |  100.00% |
| Recall          |   72.73% |   72.73% |   72.73% |
| Accuracy        |   86.05% |   86.05% |   86.05% |
| F1              |   84.21% |   84.21% |   84.21% |
| False positives |        0 |        0 |        0 |
| False negatives |        6 |        6 |        6 |

The aggregate binary metrics were identical, but the failure cases differed.

Baseline missed:

```text
E002, E008, E024, E030, E032, E040
```

Policy A/B missed:

```text
E008, E024, E029, E030, E032, E040
```

---

## HOLD / Human Review

Policy A and B final actions:

```text
SAFE = 20
HOLD = 7
FLAG = 16
```

Human-review rate:

```text
7 / 43 = 16.28%
```

Among scam cases:

* FLAG: 72.73%
* HOLD: 22.73%
* SAFE: 4.55%

So **95.45% of scam cases were either HOLD or FLAG**.

---

## Decision Cost

Relative cost matrix:

| Actual state | SAFE | HOLD | FLAG |
| ------------ | ---: | ---: | ---: |
| Scam         |   10 |    2 |    0 |
| Legitimate   |    0 |    1 |    5 |

Results:

| Method   | Decision cost |
| -------- | ------------: |
| Baseline |            60 |
| Policy A |            22 |
| Policy B |            22 |

The three-action policies achieved lower decision cost because uncertain scam cases were often sent to `HOLD` instead of `SAFE`.

---

## Calibration

| Probability bucket | Cases | Avg predicted | Actual scam rate |
| ------------------ | ----: | ------------: | ---------------: |
| 0.00–0.20          |    20 |        11.25% |            5.00% |
| 0.21–0.40          |     6 |        35.00% |           66.67% |
| 0.41–0.60          |     0 |           N/A |              N/A |
| 0.61–0.80          |     4 |        72.50% |          100.00% |
| 0.81–1.00          |    13 |        93.31% |          100.00% |

V1 performs better at the probability extremes and tends to underestimate risk in moderately suspicious cases.

---

## Failure Conditions

The main V1 failures were:

* **Conventional Recruiting Flow Bias**
  Normal-looking hiring steps can reduce suspicion too much.

* **No-Harm Implies Legitimacy Bias**
  Absence of payment, credential, or code-execution requests can incorrectly lower fraud probability.

* **Threshold-Edge False Negative**
  Example: E029 reached `0.68` but remained `HOLD`.

* **Insufficient Observable Evidence**
  Some scams do not expose enough evidence early in the conversation.

* **Risk Dilution from Plausible Follow-up**
  Later plausible messages can reduce previously elevated risk.

* **Harm-Override Coverage Limitation**
  Policy B does not help when the scam does not contain an explicitly harmful action.

---

## Highest-Cost Error

The highest-cost error is:

```text
Actual scam → SAFE
```

This is most dangerous because the candidate may continue interacting and later face:

* malware
* credential theft
* identity theft
* financial loss
* phishing
* social engineering

`HOLD` is safer because it stops confident continuation and requests more verification.

---

## Repository Structure

```text
student-project/
├── README.md
├── research-file.md
├── discussion-record.md
├── review-record.md
├── src/
│   ├── v1/  # Previous agent, baseline, policies, constants and analysis script
│   └── v2/  # Bayesian updates, extraction, repository policy, scripts and tests
├── data/
│   ├── real/
│   └── synthesis/
├── archive/v1-data/  # Original V1 inputs; origins unspecified or mixed
├── notes/
├── experiments/
├── results/
│   ├── policy-results-v1.json
│   ├── baseline-result-v1.json
│   └── metrics-summary.md
├── decisions/
│   └── probability-decision-record.md
└── paper/
```

---

## Run the Experiment

### Install

```bash
npm install
```

### Add API key

Create `.env`:

```env
OPENAI_API_KEY=your_api_key_here
```

### Run V1

```bash
npm run evaluate
```

### Run baseline

```bash
npm run baseline
```

### Evaluation

The evaluator calculates:

* confusion matrix
* precision
* recall
* accuracy
* F1
* false positives
* false negatives
* HOLD rate
* decision cost
* calibration

---

## Reproducibility

Record:

* model version
* prompt version
* policy version
* dataset version
* evaluation timestamp

Because the belief model is LLM-based, repeated runs may produce slightly different probabilities.

---

## Main V1 Finding

V1 achieved **100% precision and 72.73% recall** with no false-positive FLAG decisions.

The baseline achieved identical binary metrics, but the agent’s `HOLD` action reduced decision cost by avoiding confident SAFE decisions on most missed scams.

The main limitation is detecting scams that rely on identity deception or realistic recruiting behavior rather than explicit harmful actions.

## Run V2

The V2 entry point is `src/v2/agent-v2.ts`, whose exported `main()` loads the current four-case repository fixture, configures optional synthetic beliefs, coordinates sequential replay and writes evaluation results. `npm start` continues to run V1.

```bash
npm run start:v2 -- --synthetic-bayes --dry-run
```

Remove `--dry-run` to call the LLM and evaluate the four cases. Inspection and authorisation findings remain scripted. `--synthetic-bayes` explicitly enables the reviewed exercise configuration; without it the original repository rules are used. The existing `evaluate:repository-replay` command delegates to the same entry function.

V2 reports include recommendation `scope` and `guidance`. Early SAFE permits conversation only; repository execution requires the configured checks and precautions. The displayed probability is the **last modelled scam belief**. `lastUpdatedAtEvent` identifies its latest numerical update and `unmodelledEvidenceEventIds` lists observations not incorporated into that probability, even when safety rules act on them. Schema version 2 adds these fields; older reports are preserved.

To evaluate the repository-compatible subset of the 100-case development benchmark:

```bash
npm run start:v2 -- --benchmark --synthetic-bayes --dry-run
```

The current selection is 28 supported cases and 72 explicitly skipped cases, with 93 planned message-level API calls. Remove `--dry-run` for the paid LLM run. Preflight validates selected event schemas, artifact references, event order and checkpoint targets. Reports record coverage, skipped IDs/reasons and proposed-target IDs. The synthetic likelihoods are an explicit exercise snapshot; this is not held-out accuracy or a full 100-case result.

### Scoped repository inspection records

Repository inspection events may now include `agent_input.scope` with
`requested_action`, `artifact_revision`, `inspected_files`, `findings`, and `gaps`.
Each finding records `file`, `start_line`, `end_line`, `behaviour`, and `harmful`.
Citations must reference inspected files. A scoped clean outcome requires at
least one inspected file and no relevant uninspected execution paths. Concrete
harm requires a cited harmful finding; missing dependencies or exhausted review
budgets should be recorded as gaps with an unresolved outcome. Clean inspection
still requires verified assessment authorisation before execution is cleared.

The replay preserves the latest scope in `inspectionScope` for auditing. Existing
scripted fixtures without scope remain supported. Schema validation checks record
consistency, not the truth of findings or completeness of dependency tracing.
A bounded local-file inspector is available as described below. Manual-review
orchestration is not implemented yet. Likelihoods and decision costs are unchanged.


### Live read-only repository inspection

```sh
npm run start:v2 -- --inspect-repo https://github.com/AamirAlam/portfolio-app --action "npm install && npm run dev"
# Existing local snapshots are also supported:
npm run start:v2 -- --inspect-local /path/to/separate-snapshot --action "npm start"
```

Public HTTPS GitHub and Bitbucket Cloud repository root URLs are supported.
The fetcher resolves the default branch to a commit, reads source through the
provider API, and sends bounded source text to the configured LLM. The requested
command is data: it is never executed. No clone, install, archive extraction,
program download, submodule or LFS fetch occurs. Remote source stays in memory;
there is no checkout to clean up. Only timestamped audit reports are retained.

Inspection follows relevant file references for up to 4 model calls, 24 paths,
32 KiB per file and 128 KiB of source text. Fetching is limited to 60 requests,
3 MB of responses and a 120-second fetch window, with 10-second request timeouts.
Redirects, symlinks, non-provider hosts and private/tool paths are refused.
Private repositories, missing source, malformed responses, API failures, missing
required files and budget limits remain unresolved. Local snapshots must be
stable; the local reader is not an OS sandbox against concurrent modification.

The automated result is one of:

- `harmful_behaviour_found`: a model-identified harmful behaviour has exact
  file/line/quote evidence. The policy recommends FLAG. This is an automated
  assessment, not independently confirmed ground truth.
- `no_harmful_behaviour_found`: the model reports complete coverage of the
  requested scope, with files inspected and no unresolved gaps. This is scoped
  static analysis, not proof that the entire repository or recruiter is safe.
- `unresolved`: incomplete coverage or review failure. The policy keeps HOLD and
  records manual review as a candidate, with the user's assumed 30-minute effort.

Harmful findings persist across review rounds. External package dependencies
remain a coverage gap for package-manager execution; familiar package names
and a lockfile do not establish dependency safety. Direct `node file.js`
inspection follows its own execution paths rather than automatically requiring
unrelated development packages.

The URL CLI does not establish assessment authorisation, so even a scoped-clean
repository remains HOLD under the existing policy until separate authorisation
is verified. It does not invent a scam probability or a review-value estimate.
Conversation-driven URL extraction and automatic scheduling of checks are not
part of this CLI. No dataset labels are edited from inspection output.

Provider API references: [GitHub Git trees](https://docs.github.com/en/rest/git/trees),
[GitHub commits](https://docs.github.com/en/rest/commits/commits), and
[Bitbucket source](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/).

The 2026-10-14 live portfolio-app run inspected 19 files at commit
`ac1280fab0288b88f692d6dc2a64badaa476abbd`, with 4 model calls. It reported no harmful
findings but unresolved dependency, file-size, path-budget and HTTP 403 gaps;
therefore HOLD. See
`results/repository-inspection-2026-10-14T11-32-44-924Z.json`.
GitHub live access was exercised; Bitbucket protocol behaviour is tested with
stubbed responses, not a live Bitbucket repository. These are development checks,
not evidence of calibrated malware-detection accuracy.

Inspection reports also retain `review_errors`: the review round, failure category
and rejected findings. Source text is accompanied by numbered lines for citation
accuracy. Schema/citation failures can be corrected within the same four-call
budget; rejected findings never enter policy evidence. Schema-valid file requests
can advance inspection during correction. API failures or an exhausted correction
budget keep the assessment unresolved unless valid harmful evidence was already
established. The reviewer prioritises automatic workspace tasks and the Git hooks
they activate; this is generic traversal guidance, not a repository-name rule.

Citations are anchored to a unique exact source substring (outer quote whitespace
is ignored). The inspector derives authoritative line numbers and stores complete
source lines, recording changes in `citation_adjustments`. It does not fuzzy-match
code or accept an invented or ambiguous quote. A wrong model line number alone no
longer discards an otherwise verifiable finding.

### Conversation-triggered inspection

```sh
npm run start:v2 -- --conversation conversation.json --dry-run
npm run start:v2 -- --conversation conversation.json
```

Input format (illustrative messages, not collected evidence):

```json
{
  "messages": [
    {"time":"t0","sender":"candidate","message":"Please share the assessment."},
    {"time":"t1","sender":"recruiter","message":"Run npm install and npm run dev in https://github.com/OWNER/REPO"}
  ]
}
```

Messages are processed in file order, exposing only each arrived prefix to the
extractor. Reviewer metadata and ground truth are removed. Candidate statements,
links alone, and ambiguous requests cannot trigger a repository fetch. An explicit
execution request must contain exactly one supported repository root URL in that
same message. Earlier-message URL binding, multiple repositories and document-link
resolution are not implemented; those targets remain HOLD for clarification.

HOLD is emitted and saved before inspection begins. The source inspection and
policy result are then saved in the same timestamped conversation report. There
is at most one inspection per conversation run. Later instructions do not reuse
an earlier clearance; HOLD/FLAG persists and a new assessment is required. Early
SAFE is conversation-only. Assessment authorisation remains unresolved, so a clean
inspection cannot by itself allow execution. No synthetic prior or likelihood is
used in this real-data path. This is a sequential CLI, not a persistent chat server.
Tests use stubbed extraction and inspection. A live synthetic conversation run on
2026-10-14 correctly triggered at the execution request, then retained HOLD when
GitHub returned HTTP 403. Successful source inspection through this conversation
path remains unvalidated; see `results/conversation-v2-2026-10-14T13-15-17-994Z.review.md`.

Source errors now distinguish HTTP 429 and HTTP 403 with an exhausted allowance
as `provider_rate_limited`. `source_errors` records the affected path and
`retry_at` when the provider supplies a valid reset or retry header. Further
network fetches in that source instance are suppressed after the limit response.
Other HTTP 403 responses remain generic access failures. No automatic waiting or
cross-run retry is performed; unresolved inspection stays HOLD.
