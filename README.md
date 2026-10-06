# Conversational scam detection Agent — Week 1

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
