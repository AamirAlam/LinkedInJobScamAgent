## The problem statement

The agent reads the conversation and it must suggest safe, hold, or flag the person as potential scammer


## The project objective

How can an AI system perform early conversational scam-risk detection under partial observability, as the conversation moves forward more evidance will be visible and agent can increase or decrese the scam risk percetnage accordingly.


## Technical terms
1. Scam detection, fraud detection, fraudulent intent detection
2. Conversational classification, dialogue classification, sequence classification
3. Partial observability, epistemic uncertainty, insufficient evidence
4. Sequential inference, Bayesian updating, belief-state tracking
5. Latent state, latent intent, hidden state estimation
6. Class imbalance / rare-event detection
7. Cost-sensitive classification, risk-sensitive decision-making

## Search queries
- real-time scam detection conversation LLM
- fraudulent intent detection dialogue
- uncertainty aware classification abstention
- confidence based rejection classifier
- selective prediction risk coverage
- sequential classification incomplete information
- evidence accumulation classification
- early classification time series uncertainty
- probability calibration high stakes classification
- cost sensitive fraud detection
- fraud detection false positive false negative cost

## Five to ten verified Reddit communities

1. https://www.reddit.com/r/Scams/
2. https://www.reddit.com/r/FraudPrevention/
3. https://www.reddit.com/r/MLQuestions/
4. https://www.reddit.com/r/cybersecurity/
5. https://www.reddit.com/r/SocialEngineering/

## Relevant X accounts
1. https://x.com/yingyuan
2. https://x.com/gilitsaporta
3. https://x.com/ManSoSec
4. https://x.com/hemant_pt
5. https://x.com/andreferraz91

## Useful papers, articles, repositories, or datasets
- https://arxiv.org/html/2502.03964v1
- https://arxiv.org/abs/2503.11709?utm_source=chatgpt.com
- https://albahnsen.github.io/files/Cost%20Sensitive%20Credit%20Card%20Fraud%20Detection%20using%20Bayes%20Minimum%20Risk%20-%20Publish.pdf?utm_source=chatgpt.com


## Questions that you want to answer
- Is scam/not-scam a fixed state, or can it evolve during the conversation?
- Are you estimating intent, risk, or whether a known scam pattern is occurring?
- Can legitimate people exhibit scam-like behaviour?
- Should the model estimate P(scam | evidence)?
- Should there be several latent variables instead of one?


## Evidence
- What exactly counts as evidence?
- Is evidence associated with one message or several messages?
- Can evidence contradict earlier evidence?
- How should old evidence decay?
- What constitutes strong versus weak evidence?
- Does the model need positive evidence of safety, or merely lack evidence of fraud?
- Should different evidence types accumulate?
- Does an explanation need to quote the exact conversational evidence?
- Can metadata be used?

## Actions
- SAFE
- HOLD
- FLAG

## Errors
Situations where Agent can fail
- Legitimate conversation → FLAG (False positive)
user loses trust
legitimate transaction interrupted
sender falsely accused
system eventually gets ignored

- Scam conversation -> Safe (False negative)
Potential consequences can be much worse.
- Late positive
Scam eventually detected, but only after the victim has acted.

- Excessive HOLD
A theoretically safe system could simply answer HOLD constantly.
