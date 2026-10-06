export const instruction = `
Evaluate only the recruiting conversation provided.

Estimate the probability that the interaction is fraudulent.

Probability scale:

0.0 = extremely strong evidence of legitimacy

0.5 = genuinely uncertain

1.0 = extremely strong evidence of fraud

Use the full range when appropriate.

Do not treat absence of scam evidence as proof of legitimacy.

Recalculate from the full visible conversation.

Do not use previous scores.

Do not assume or infer future messages.

evidenceUsed:

Return only short suspicious signals.

Do not include legitimacy-supporting evidence here.

harmCategory:

harmCategory must represent the highest-risk requested action that has appeared anywhere in the visible conversation so far, not only the latest message.

non_harmful = ordinary recruiting actions such as asking for a CV, availability, salary expectations, email address, phone number, or interview scheduling.

context_dependent = actions that may be legitimate or risky depending on context, such as:
- sharing or reviewing a repository
- being invited to a GitHub or Bitbucket repository
- reviewing source code
- being sent an MVP, file, document, or project link
- being asked to inspect a project without executing it
- being asked for a sensitive document where legitimacy depends on the hiring stage and verification

harmful = actions that could directly expose the candidate to harm, such as:
- running, executing, launching, building, or starting an unknown or unverified project locally
- installing dependencies or software from an unknown source
- executing code from an unfamiliar repository
- sharing login credentials, private keys, seed phrases, or banking details
- sending money or making a payment
- disabling antivirus, security protections, or other safeguards

Important distinction:

"Review this repository" -> context_dependent

"I will invite you to our repository" -> context_dependent

"Review the source code" -> context_dependent

"Run the project and explore it" -> harmful

"Install the dependencies and start the application" -> harmful

"Clone and execute this repository" -> harmful

If a harmful requested action appeared earlier in the visible conversation, harmCategory should remain harmful at later time steps even if the latest message is non-harmful.

reasoningSummary:

Briefly explain the score and may mention both suspicious and legitimacy-supporting evidence.

Do not decide SAFE/HOLD/FLAG.

The policy layer will decide that separately.
`;

export const actions = {
    SAFE: "SAFE",
    HOLD: "HOLD",
    FLAG: "FLAG"
}

export const harmCategories = {
    NON_HARMFUL: "non_harmful",
    CONTEXT_DEPENDENT: "context_dependent",
    HARMFUL: "harmful"
}