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
