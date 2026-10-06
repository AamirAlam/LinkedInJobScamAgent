export function isValidProbability(value: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function calculateScamProbability(
    priorScam: number,
    likelihoodGivenScam: number,
    likelihoodGivenLegitimate: number,
): number | 'unsupported_evidence' {
    if (![priorScam, likelihoodGivenScam, likelihoodGivenLegitimate].every(isValidProbability)) {
        throw new RangeError('All probabilities must be finite numbers between 0 and 1.');
    }
    const scamWeight = priorScam * likelihoodGivenScam;
    const legitimateWeight = (1 - priorScam) * likelihoodGivenLegitimate;
    const total = scamWeight + legitimateWeight;
    return total === 0 ? 'unsupported_evidence' : scamWeight / total;
}

export type BeliefState = {
    scamProbability: number;
    appliedEvidenceIds: readonly string[];
};

export type Likelihoods = {
    likelihoodGivenScam: number;
    likelihoodGivenLegitimate: number;
};

// Use a stable ID for the underlying evidence, not each message repeating it.
// Correlated evidence needs likelihoods conditioned on evidence already used.
export function applyEvidence(state: BeliefState, evidenceId: string, likelihoods: Likelihoods) {
    if (!evidenceId.trim()) throw new Error('Evidence ID must not be empty.');
    if (![state.scamProbability, likelihoods.likelihoodGivenScam,
        likelihoods.likelihoodGivenLegitimate].every(isValidProbability)) {
        throw new RangeError('All probabilities must be finite numbers between 0 and 1.');
    }
    if (state.appliedEvidenceIds.includes(evidenceId)) {
        return { status: 'duplicate_evidence' as const, state };
    }
    const posterior = calculateScamProbability(
        state.scamProbability, likelihoods.likelihoodGivenScam, likelihoods.likelihoodGivenLegitimate,
    );
    if (posterior === 'unsupported_evidence') {
        return { status: posterior, state };
    }
    return {
        status: 'updated' as const,
        state: { scamProbability: posterior, appliedEvidenceIds: [...state.appliedEvidenceIds, evidenceId] },
    };
}

type CheckEvent = {
    kind: string;
    agent_input: { check?: string; outcome?: string; artifact?: string };
};

// Only the arriving check result is supplied, never the case's hidden label.
export function applyCheckResult(
    state: BeliefState,
    event: CheckEvent,
    likelihoodsByOutcome: Readonly<Partial<Record<string, Likelihoods>>>,
) {
    if (event.kind !== 'check_result') return { status: 'no_check_result' as const, state };
    const { check, outcome, artifact } = event.agent_input;
    if (!check || !outcome) throw new Error('Check result requires a check name and outcome.');
    const key = `${check}:${outcome}`;
    const likelihoods = likelihoodsByOutcome[key];
    if (!likelihoods) return { status: 'unmodelled_evidence' as const, state };
    // ponytail: repeated same-outcome checks on one artifact count once;
    // revised artifacts or expanded inspections need explicit evidence versions.
    return applyEvidence(state, `${key}:${artifact ?? 'conversation'}`, likelihoods);
}
