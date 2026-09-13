#  V1 Evaluation Metrics

## Dataset

* Total conversations: 43
* Scam conversations: 22
* Legitimate conversations: 21
* Positive class: `FLAG`
* Negative class: `SAFE` or `HOLD`
* Ground-truth labels were hidden from the agent during inference.

---

## Baseline

### Action distribution

| Actual class | SAFE | HOLD | FLAG |
| ------------ | ---: | ---: | ---: |
| Scam         |    6 |    0 |   16 |
| Legitimate   |   21 |    0 |    0 |
| Total        |   27 |    0 |   16 |

### Confusion matrix

|                   | Predicted FLAG | Predicted not flagged |
| ----------------- | -------------: | --------------------: |
| Actual scam       |             16 |                     6 |
| Actual legitimate |              0 |                    21 |

### Metrics

* True positives: 16
* True negatives: 21
* False positives: 0
* False negatives: 6
* Precision: 100.00%
* Recall: 72.73%
* Accuracy: 86.05%
* F1 score: 84.21%
* False-positive rate: 0.00%
* False-negative rate: 27.27%
* Specificity: 100.00%
* HOLD rate: 0.00%

### Missed scam cases

* E002
* E008
* E024
* E030
* E032
* E040

---

## Policy A

Policy A uses only scam probability:

* `p <= 0.20` → SAFE
* `0.20 < p <= 0.70` → HOLD
* `p > 0.70` → FLAG

### Final action distribution

* SAFE: 20
* HOLD: 7
* FLAG: 16

### Confusion matrix

|                   | Predicted FLAG | Predicted not flagged |
| ----------------- | -------------: | --------------------: |
| Actual scam       |             16 |                     6 |
| Actual legitimate |              0 |                    21 |

### Metrics

* True positives: 16
* True negatives: 21
* False positives: 0
* False negatives: 6
* Precision: 100.00%
* Recall: 72.73%
* Accuracy: 86.05%
* F1 score: 84.21%
* False-positive rate: 0.00%
* False-negative rate: 27.27%
* Specificity: 100.00%
* Overall HOLD rate: 16.28%

### Missed scam cases

* E008
* E024
* E029
* E030
* E032
* E040

---

## Policy B

Policy B uses the same probability thresholds as Policy A, with an additional harmful-action override:

* If `harmCategory === harmful` → FLAG
* Otherwise use Policy A

### Final action distribution

* SAFE: 20
* HOLD: 7
* FLAG: 16

### Confusion matrix

|                   | Predicted FLAG | Predicted not flagged |
| ----------------- | -------------: | --------------------: |
| Actual scam       |             16 |                     6 |
| Actual legitimate |              0 |                    21 |

### Metrics

* True positives: 16
* True negatives: 21
* False positives: 0
* False negatives: 6
* Precision: 100.00%
* Recall: 72.73%
* Accuracy: 86.05%
* F1 score: 84.21%
* False-positive rate: 0.00%
* False-negative rate: 27.27%
* Specificity: 100.00%
* Overall HOLD rate: 16.28%

### Missed scam cases

* E008
* E024
* E029
* E030
* E032
* E040

---

## Comparison

| Metric              | Baseline | Policy A | Policy B |
| ------------------- | -------: | -------: | -------: |
| Precision           |  100.00% |  100.00% |  100.00% |
| Recall              |   72.73% |   72.73% |   72.73% |
| Accuracy            |   86.05% |   86.05% |   86.05% |
| F1 score            |   84.21% |   84.21% |   84.21% |
| False positives     |        0 |        0 |        0 |
| False negatives     |        6 |        6 |        6 |
| False-positive rate |    0.00% |    0.00% |    0.00% |
| False-negative rate |   27.27% |   27.27% |   27.27% |
| Specificity         |  100.00% |  100.00% |  100.00% |
| HOLD rate           |    0.00% |   16.28% |   16.28% |

## Main finding

All three methods achieved identical aggregate binary metrics on the 43-case evaluation set.

However, the failure sets were not identical.

The baseline missed E002, while Policy A and Policy B detected it.

Policy A and Policy B missed E029, while the baseline detected it.

This means the structured belief-and-policy agent changed which conversations were detected even though the final aggregate precision, recall, and accuracy were unchanged.

Policy A and Policy B also produced identical final metrics in V1, indicating that the harmful-action override did not change the final binary outcome on this dataset.


# V1 Failure Analysis

The V1 evaluation produced six false negatives:

* E008
* E024
* E029
* E030
* E032
* E040

Although all six were scams according to the evaluation labels, they were not finally classified as `FLAG` by Policy A or Policy B.

## Failure 1 — Conventional recruiting flow suppresses suspicion

**Cases:** E008, E024, E030, E040

In these conversations, the interaction followed a plausible recruiting sequence such as discussing the role, asking about experience, compensation, availability, requesting a CV, or describing an interview process.

The belief model repeatedly treated this conventional structure as evidence against fraud.

For example, E024 remained between approximately `0.08` and `0.30` despite unresolved employer identity and a scheduling-link mismatch. The final result was `HOLD`, not `FLAG`.

**Failure condition name:** `Conventional Recruiting Flow Bias`

**Component affected:** Belief generation

**Finding:** A realistic-looking hiring process can suppress scam probability even when identity or verification concerns remain unresolved.

---

## Failure 2 — Absence of a dangerous request is overweighted

**Cases:** E008, E024, E030, E040

The reasoning frequently justified low scam probability by noting the absence of:

* payment requests
* credential requests
* sensitive-document requests
* code execution
* software installation

However, fraud likelihood and immediate action harm are different concepts.

An interaction may still be fraudulent even when the recruiter has not yet requested a directly harmful action.

**Failure condition name:** `No-Harm Implies Legitimacy Bias`

**Component affected:** Belief generation

**Finding:** V1 sometimes uses the absence of an explicit harmful action as evidence of legitimacy, causing identity-deception and social-engineering scams to receive probabilities that are too low.

---

## Failure 3 — Threshold-edge miss

**Case:** E029

E029 received:

* scam probability: `0.68`
* harm category: `context_dependent`
* Policy A: `HOLD`
* Policy B: `HOLD`

The model recognized several suspicious signals, including an unsolicited PoC repository, external documents, and a hiring decision tied to project feedback.

However, the probability remained slightly below the `> 0.70` FLAG threshold.

**Failure condition name:** `Threshold-Edge False Negative`

**Component affected:** Decision policy

**Finding:** In this case the belief model identified substantial risk, but the conservative FLAG threshold prevented escalation.

This case is different from the low-probability failures because a small threshold change could change the final action.

---

## Failure 4 — Weak evidence under partial observability

**Case:** E032

E032 contained only a single visible recruiting message.

The model identified:

* cryptocurrency compensation
* Web3 rewards and airdrop context
* unsolicited remote recruiting

but assigned only:

`P(scam) = 0.28`

and therefore returned `HOLD`.

No payment demand, credential request, execution request, or other strongly discriminative evidence was visible.

**Failure condition name:** `Insufficient Observable Evidence`

**Component affected:** Evidence availability / partial observability

**Finding:** Some scam cases cannot be confidently identified from the available conversation because the observable evidence is weak even though the hidden ground truth is fraudulent.

This is an inherent limitation of early detection under partial observability.

---

## Failure 5 — Suspicion can decrease after additional plausible context

**Cases:** E008 and E040

V1 does not force scam probability to increase monotonically.

This is intentional, but it creates a failure mode when later messages appear more conventional.

For example, E008 increased to `0.47` when the recruiter introduced a demo-project test and requested GitHub information, but later fell to `0.18` after additional context appeared plausible.

E040 similarly reached `0.38` when an MVP review was introduced, then dropped to `0.18`.

**Failure condition name:** `Risk Dilution from Plausible Follow-up`

**Component affected:** Belief updating

**Finding:** Later legitimacy-looking information can outweigh earlier suspicious evidence even when the underlying interaction is fraudulent.

The ability for probabilities to decrease is desirable, but V1 may reduce risk too aggressively.

---

## Failure 6 — Policy B does not help when harm is not classified as harmful

**Cases:** All six missed scams

None of the six missed scams ended with:

`harmCategory = harmful`

Therefore the Policy B harmful-action override was never activated.

This explains why Policy A and Policy B produced identical aggregate results.

**Failure condition name:** `Harm-Override Coverage Limitation`

**Component affected:** Policy B scope

**Finding:** Policy B is useful only for scams involving explicitly harmful requested actions. It does not improve detection of scams driven primarily by identity deception, vague recruiting claims, social engineering, or context-dependent requests.

---

# Highest-Cost Error

The highest-cost error in V1 is:

`Actual scam → SAFE`

This error is more costly than excessive HOLD or a legitimate interaction being temporarily held because SAFE communicates that the interaction appears sufficiently low-risk to continue.

If a fraudulent conversation is incorrectly classified SAFE, the candidate may continue interacting with the attacker and later become exposed to:

* credential theft
* malware
* identity theft
* financial loss
* malicious repositories or software
* other social-engineering attacks

By contrast, `Scam → HOLD` does not fully detect the scam, but it still prevents the system from confidently recommending continuation.

For this reason, the error-cost ordering used in V1 is:

`Scam → SAFE > Late FLAG > Legitimate → FLAG > Excessive HOLD`

---

# Main V1 Failure Finding

The strongest overall finding from V1 is that the system performs well when scams contain explicit high-risk actions, but it is weaker when fraud depends primarily on identity deception, vague organizational claims, or otherwise plausible recruiting behavior.

The V1 belief model also repeatedly uses the absence of an explicit harmful request as evidence that the conversation is likely legitimate.

This creates an important direction for a future version: fraud likelihood should be modeled more independently from immediate action harmfulness.

No V1 prompt, threshold, or policy was changed after this evaluation. These failures are preserved as the measured limitations of V1.



# Human Review Rate

In V1, the `HOLD` action represents an uncertain case where the system does not have enough confidence to classify the interaction as either sufficiently safe or sufficiently risky.

A `HOLD` case would require additional verification, more evidence, or human review before the candidate continues.

### Overall result

* Total conversations: **43**
* SAFE: **20**
* HOLD: **7**
* FLAG: **16**

Human-review rate:

**7 / 43 = 16.28%**

Therefore, V1 sends **16.28% of evaluated conversations to HOLD/human review**.

### Review rate by actual class

| Actual class | SAFE | HOLD | FLAG | HOLD rate |
| ------------ | ---: | ---: | ---: | --------: |
| Scam         |    1 |    5 |   16 |    22.73% |
| Legitimate   |   19 |    2 |    0 |     9.52% |
| Overall      |   20 |    7 |   16 |    16.28% |

### Interpretation

Five of the 22 scam conversations were routed to `HOLD` instead of being incorrectly marked `SAFE`.

This is important because the binary FLAG recall of V1 is **72.73%**, but the three-action policy still avoided confidently marking most missed scams as safe.

For scam conversations:

* FLAG: **16 / 22 = 72.73%**
* HOLD: **5 / 22 = 22.73%**
* SAFE: **1 / 22 = 4.55%**

Therefore:

**(FLAG + HOLD) / Scam cases = 21 / 22 = 95.45%**

This can be reported as a **protected scam rate** or **non-SAFE scam rate**, not as recall.

Only **4.55% of scam conversations received a final SAFE action**, while the remaining 95.45% were either flagged or held for additional review.

For legitimate conversations:

* 19 / 21 were SAFE
* 2 / 21 were HOLD
* 0 / 21 were FLAG

Therefore, the legitimate human-review burden was:

**2 / 21 = 9.52%**

### Finding

V1 uses abstention selectively. It sends 16.28% of all conversations to human review while producing no false-positive FLAGs.

The HOLD mechanism is particularly useful for uncertain scam cases: five of the six scam conversations that were not FLAGGED were still routed to HOLD, leaving only one scam with a final SAFE decision.

This demonstrates why the three-action evaluation provides information that the binary confusion matrix alone does not capture.



# Decision Cost

Binary precision and recall treat every non-FLAG decision similarly. However, the V1 agent distinguishes between `SAFE` and `HOLD`.

To capture the different consequences of each action, the following experimental cost matrix was defined:

| Actual state | SAFE | HOLD | FLAG |
| ------------ | ---: | ---: | ---: |
| Scam         |   10 |    2 |    0 |
| Legitimate   |    0 |    1 |    5 |

These values are not empirical monetary costs. They are relative evaluation weights chosen to encode the project's risk ordering.

### Cost interpretation

* **Scam → SAFE = 10:** highest cost because the candidate may continue interacting with a fraudulent recruiter.
* **Scam → HOLD = 2:** fraud was not confidently detected, but the candidate is asked to stop and obtain additional verification.
* **Legitimate → FLAG = 5:** a legitimate interaction is incorrectly treated as potentially fraudulent.
* **Legitimate → HOLD = 1:** creates additional verification or human-review work but is recoverable.
* Correct SAFE or FLAG actions have zero cost.

### Baseline

The baseline produced:

* Scam → SAFE: 6
* Scam → FLAG: 16
* Legitimate → SAFE: 21
* Legitimate → FLAG: 0

Decision cost:

`(6 × 10) = 60`

**Baseline total decision cost: 60**

### Policy A

Policy A produced:

* Scam → SAFE: 1
* Scam → HOLD: 5
* Scam → FLAG: 16
* Legitimate → SAFE: 19
* Legitimate → HOLD: 2
* Legitimate → FLAG: 0

Decision cost:

`(1 × 10) + (5 × 2) + (2 × 1) = 22`

**Policy A total decision cost: 22**

### Policy B

Policy B produced the same final action distribution as Policy A.

**Policy B total decision cost: 22**

### Comparison

| Method   | Decision cost |
| -------- | ------------: |
| Baseline |            60 |
| Policy A |            22 |
| Policy B |            22 |

### Finding

The baseline and both V1 policies achieved identical binary precision, recall, and accuracy, but their decision costs were substantially different.

The baseline marked six scam conversations as SAFE. In contrast, the three-action policies routed five of the six missed scams to HOLD and only one to SAFE.

Under the defined relative cost model, this reduced total decision cost from **60 for the baseline to 22 for Policy A and Policy B**.

This shows an advantage of the abstention/HOLD action that is hidden by binary precision and recall alone.

The cost values are evaluation assumptions rather than empirically measured real-world costs, so sensitivity to alternative cost values should be considered a limitation.



# Calibration

Policy A and Policy B have identical probability calibration because both policies use the same `scamProbability` produced by the belief model. They differ only in how the probability and harm category are converted into actions.

Calibration was evaluated using the final scam probability for each of the 43 conversations.

| Probability bucket | Cases | Avg predicted probability | Actual scam rate | Difference |
| ------------------ | ----: | ------------------------: | ---------------: | ---------: |
| 0.00–0.20          |    20 |                    11.25% |            5.00% |   +6.25 pp |
| 0.21–0.40          |     6 |                    35.00% |           66.67% |  -31.67 pp |
| 0.41–0.60          |     0 |                       N/A |              N/A |        N/A |
| 0.61–0.80          |     4 |                    72.50% |          100.00% |  -27.50 pp |
| 0.81–1.00          |    13 |                    93.31% |          100.00% |   -6.69 pp |

### Findings

The model is relatively well aligned at the extreme ends of the probability range.

In the `0.00–0.20` bucket, the average predicted scam probability was 11.25%, while the observed scam rate was 5%. This indicates mild overestimation of scam risk among low-risk cases.

In the `0.81–1.00` bucket, the model predicted an average probability of 93.31%, while all cases were scams. This suggests that high-confidence predictions were directionally reliable, although still slightly underconfident.

The largest calibration errors occurred in the intermediate ranges.

For cases in the `0.21–0.40` bucket, the average predicted scam probability was only 35%, while 66.67% of the cases were actually scams.

For cases in the `0.61–0.80` bucket, the average predicted probability was 72.5%, while 100% of the cases were scams.

This indicates that V1 tends to **underestimate scam risk in ambiguous or moderately suspicious conversations**.

No cases fell into the `0.41–0.60` range, which also suggests that the model's probability outputs are not evenly distributed across the full probability scale.

### Calibration limitation

The evaluation contains only 43 conversations, and some calibration buckets contain very few cases. Therefore, these calibration results should be treated as exploratory rather than as evidence of stable probability calibration.

A larger evaluation set would be required before using the raw `scamProbability` values as calibrated real-world probabilities.

### Main calibration finding

V1 appears more reliable at distinguishing very low-risk and very high-risk conversations than at estimating probability precisely in the middle ranges.

The largest underconfidence appears in moderately suspicious cases, which is consistent with the observed false negatives and HOLD decisions in V1.
