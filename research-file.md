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

  Answer: It can evolve as we uncover more evidence during conversation, at the very first message it might look like a legitimate job reachout from an HR or a real token allocation to your wallet, but once conversation add more messages or you look for more evidence in the email it will increase or descrease the chances of this being a scam or legitimate message.  
 
- Are you estimating intent, risk, or whether a known scam pattern is occurring?

  Answer: I'm estimating intent, since most of the scam messages look very convincing and we may fall for it.

- Can legitimate people exhibit scam-like behaviour?
  
  Answer: Yes, a good linkedIn profile and a legitimate looking email can send scam messages for job offers, token airdrops, mint nft etc

- Should the model estimate P(scam | evidence)?

  Answer:  Yes ,mode should estimate scam with the given evidence.

- Should there be several latent variables instead of one?
  
  Answer: Yes model can have multiple latent variable 


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






1. Hidden truth — precisely define scam vs legitimate interaction.

Legitimate interaction: The recruiter / job opportunity is genuinely connected to the claimed hiring opportunity and is not attempting to mislead candidate for malicius gains.

Fraud Interaction: The interaction uses a false deceptive job opportunity receuitor identity to manioulate the candidate towards the harmful objective.

Hamful Objetives: stealing credentials, Malware execution,Personal data



2. Observation at time t — exactly what V1 sees.

At time t=0 agent will see with very first message1 
at time t=1 agent sees messages 2 and 3
attime t=2 agent sees messages 3 and 4 and so on

Agent receives messages sequentially. It cannot request future historical messages.

3. Belief — precisely define what your percentage means.

Percentage means what is the current probability of the conversation being a scam.
New evidence can raise or lower belief.

4. SAFE / HOLD or Ask for more information / FLAG — define the real-world meaning of each action.

Safe: Current evidence allowed the coversion to keep moving under the current policy. It does not mean the person is legitimate yet

Hold : Current evidence is insufficient, conflicting or uncertain enough that the agent should avoid a potentially risky next step.
Agent can : 
  - wait for more conversation.
  - ask the user/ receuitor for information.
  - request and allowed verification
  - route to human review.



Flag: Based on current evidence crosses the policy's risk thresold or harm thresold sufficiently to recommend treating the interaction as potential scam.

Aent reccomend scam is not a proven scam or fraud

5. Danger point — define when a scam warning becomes late.

When agent flag a conversarion at the very end after user already interacted with the app or followed the previous potential harmfull guide, that is called late detection.


6. Ground truth — explain how you will know whether each test conversation really was scam/legitimate.
I have prepared a list of potential scam conversations which I alreayd know is a scam . Yes I personally managed to found them scam
and I have another list of safe conversation from my linkedIn dm. I personally verified them as legitimate






Fraud → SAFE.  | Very High | user | Hamful Objetives | No | Following a scam conversation will able harness harmfull objective to user devide and steal keys or potentials information

Legitimate → FLAG | Medium | User | User misses potential job opportunity | Yes | This is not very high seviority because user does not loose anything but he might miss a potential gain from a job opportunity.

Excessive HOLD  | Low | user | Not much harmfull because user won't take any action | Yes | Holding and verifying the evidence is reasonable action in case of uncertainity rather than giving wrong decision

Late FLAG.  | High | user. | User might take an harmfull action in the next message | Might be | This is relative high because a late flag might cause the damage to user in the early messages



When should the agent be allowed to say SAFE?

Agent is allowed to be say safe unless the flag prob is more than 20%


When should the agent choose HOLD?

it can hold until the flag prob is more than 70%

When should the agent choose FLAG?

It can flag if the prob is more than 70%




Q: Should the action depend only on scam probability, or also on whether the current message contains a potentially harmful requested action?

A; Yes the action should depend if the message contains a potentially harmful requested actio

Q: How policy B behave 

Think about these three cases, all with the same 35% scam belief:

Recruiter asks for your availability.
Recruiter asks for more résumé information.
Recruiter asks you to download and execute an unknown project.

If the message contains a potentially harmfull action it should increase the flag probability instantly

Policy B — Risk + Harm-Aware Policy: Use the scam probability, but also check whether the current requested action could directly lead to one of the threat-model harms. If a harmful action is present, use a more conservative decision than the probability-only policy.




asking for availability, Non harmful
asking for CV, Non harmful
asking for phone/email, Non Harmful
asking for government ID, Harmful
asking for login credentials, Harmful
asking for banking details, Harmful
asking for payment, Harmful
sending a file/repository, Harmful
asking to download something, Harmful
asking to execute/install something, Harmful
asking to disable security protections. Harmful


## how Policy B reacts to each harm category,

Q: If scam probability is low but the requested action is Harmful, should the agent choose SAFE, HOLD, or FLAG?
A: It should FLag if a potential harmful action found

Q: If scam probability is medium and the requested action is Non-harmful, what should happen?
A: It should treat this as safe

Q: If the requested action is Context-dependent, what extra evidence would make the agent move toward SAFE versus FLAG?
A: Any action that is potentially harmful


Initial research
→ V1 design
→ V1 implementation
→ evaluation
→ observed failures
→ Reddit/X feedback
→ design changes
→ V2 evaluation