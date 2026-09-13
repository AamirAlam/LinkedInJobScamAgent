# Probability Decision Record — E036

## 1. Decision Context

This record examines case **E036** under partial observability.

At each stage, the decision uses only the evidence visible up to that point.

The true state is treated as unresolved while making the decision.

### Observed progression

| Time | Scam probability | Harm category | Policy A | Policy B |
| ---- | ---------------: | ------------- | -------- | -------- |
| t0   |             0.03 | non_harmful   | SAFE     | SAFE     |
| t1   |             0.03 | non_harmful   | SAFE     | SAFE     |
| t2   |             0.62 | harmful       | HOLD     | FLAG     |
| t3   |             0.93 | harmful       | FLAG     | FLAG     |
| t4   |             0.99 | harmful       | FLAG     | FLAG     |

The key decision point is **t2**.

---

## 2. Evidence Available at t2

The recruiting interaction initially appeared ordinary.

At `t2`, the recruiter requires the candidate to run a provided diagnostic client during a coding assessment.

Important evidence:

* recruiting process initially appears plausible
* candidate is asked to run recruiter-provided software
* the executable is not independently verified
* running unknown software introduces direct security risk

The model therefore produced:

```text
scamProbability = 0.62
harmCategory = harmful
```

---

## 3. Hidden States

Two hidden states are considered:

### H1 — Legitimate

The company is legitimate and the diagnostic tool is a genuine part of its technical assessment.

### H2 — Fraudulent

The recruiting process is being used to convince the candidate to execute malicious or unsafe software.

---

## 4. Current Belief

At `t2`:

| Hidden state | Probability |
| ------------ | ----------: |
| Legitimate   |         38% |
| Fraudulent   |         62% |

Total = **100%**

Therefore:

```text
P(Fraudulent) = 0.62
P(Legitimate) = 0.38
```

---

## 5. Important Event

The important event is:

> The recruiter requires the candidate to run an unverified diagnostic client during the coding assessment.

This changes the interaction from ordinary recruiting activity to a potentially dangerous technical action.

Therefore:

```text
harmCategory = harmful
```

---

## 6. Available Actions

The system can choose:

* `SAFE` — continue normally
* `HOLD` — stop and obtain more verification
* `FLAG` — treat the interaction as potentially fraudulent

---

## 7. Decision Costs

The V1 evaluation uses the following relative costs:

| Actual state | SAFE | HOLD | FLAG |
| ------------ | ---: | ---: | ---: |
| Fraudulent   |   10 |    2 |    0 |
| Legitimate   |    0 |    1 |    5 |

The highest-cost error is:

```text
Fraudulent → SAFE
```

because executing malicious software could expose the candidate to malware, credential theft, or system compromise.

---

## 8. Policy Decision at t2

### Policy A

```text
p <= 0.20        → SAFE
0.20 < p <= 0.70 → HOLD
p > 0.70         → FLAG
```

At `t2`:

```text
p = 0.62
```

Therefore:

```text
Policy A → HOLD
```

### Policy B

Policy B adds:

```text
harmCategory === harmful → FLAG
```

Since the candidate is being asked to execute an unverified client:

```text
Policy B → FLAG
```

### Initial decision

This is an important disagreement between the policies:

| Policy   | Decision |
| -------- | -------- |
| Policy A | HOLD     |
| Policy B | FLAG     |

Policy A responds only to fraud probability.

Policy B takes a stronger protective action because the requested behavior is harmful even though fraud probability remains below the 0.70 FLAG threshold.

---

# New Evidence and Probability Update

## 9. New Evidence at t3

New evidence becomes available:

> Windows SmartScreen and antivirus flag the required diagnostic client.

This is significantly stronger evidence than simply being asked to run unfamiliar software.

The recorded V1 probability increases from:

```text
0.62 → 0.93
```

---

## 10. Prior

Before receiving the security warning:

```text
P(Fraudulent) = 0.62
P(Legitimate) = 0.38
```

---

## 11. Likelihoods

Let `E` be:

> The recruiter-required diagnostic client is flagged by Windows SmartScreen and antivirus.

For this probability exercise, assume:

```text
P(E | Fraudulent) = 0.90
P(E | Legitimate) = 0.11
```

These are **explicit modeling assumptions**, not measured real-world frequencies.

The event is much more likely if the interaction is fraudulent, although legitimate internal software can occasionally trigger security warnings.

---

## 12. Bayesian Update

Using Bayes' rule:

```text
P(Fraudulent | E)
=
P(E | Fraudulent) × P(Fraudulent)
------------------------------------------------
[P(E | Fraudulent) × P(Fraudulent)]
+
[P(E | Legitimate) × P(Legitimate)]
```

Substitute the values:

```text
=
0.90 × 0.62
--------------------------------
(0.90 × 0.62) + (0.11 × 0.38)
```

```text
=
0.558
----------------
0.558 + 0.0418
```

```text
≈ 0.93
```

Updated belief:

| Hidden state | Posterior |
| ------------ | --------: |
| Fraudulent   |       93% |
| Legitimate   |        7% |

Total = **100%**

---

## 13. Updated Decision

The posterior is:

```text
P(Fraudulent | E) ≈ 0.93
```

Policy A requires:

```text
p > 0.70 → FLAG
```

Therefore:

```text
Policy A → FLAG
```

Policy B also returns:

```text
Policy B → FLAG
```

The security warning moves the case beyond the probability threshold, so both policies now agree.

---

## 14. Comparable Evidence

A useful legitimate comparison is a conventional technical assessment performed through a hosted CodeSandbox environment. In that case, no unknown local software needed to be installed or executed, and the scam probability remained very low.

A useful high-risk comparison is a recruiting test that requires cloning an unfamiliar repository, running `npm install`, and executing unknown code. That pattern produced a high fraud probability because of malware and supply-chain risk.

These comparisons support the distinction between:

```text
Hosted/review-only technical task
→ lower execution risk

Unknown local executable or dependency installation
→ substantially higher security risk
```

---

## 15. Audit Record

```text
case_id: E036

initial_decision_point: t2

prior_fraud_probability: 0.62
prior_legitimate_probability: 0.38

initial_event:
recruiter requires an unverified diagnostic client

initial_harm_category: harmful

policy_a_before: HOLD
policy_b_before: FLAG

new_evidence:
Windows SmartScreen and antivirus flag the diagnostic client

P(E | Fraudulent): 0.90
P(E | Legitimate): 0.11

posterior_fraud_probability: ~0.93
posterior_legitimate_probability: ~0.07

policy_a_after: FLAG
policy_b_after: FLAG
```

Also preserve:

* model version
* prompt version
* policy version
* dataset version
* timestamp
* visible evidence at each decision point

---

## 16. Main Finding

E036 demonstrates why **fraud probability and action risk should be modeled separately**.

At `t2`, the system estimates only a **62% probability of fraud**. Policy A therefore chooses HOLD.

However, because the recruiter is already asking the candidate to execute unverified software, Policy B immediately chooses FLAG.

After Windows SmartScreen and antivirus flag the executable, the posterior fraud belief rises to approximately **93%**, and both policies agree on FLAG.

This case demonstrates the value of a risk-sensitive override under partial observability: the system does not need certainty that the recruiter is fraudulent before protecting the candidate from a dangerous action.
