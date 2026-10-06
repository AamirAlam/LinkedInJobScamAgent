export type RepositoryAssessment = {
    executionRequested: boolean;
    inspection: 'pending' | 'unresolved' | 'no_harmful_behaviour_found' | 'harmful_behaviour_found';
    assessmentAuthorisation: 'unresolved' | 'verified';
};

// The reviewed repository-execution rules, not the full cost-based V2 policy.
// Inputs concern one assessment and the inspected artifact; new artifacts need new checks.
export function recommendRepositoryAction(state: RepositoryAssessment) {
    if (typeof state.executionRequested !== 'boolean' ||
        !['pending', 'unresolved', 'no_harmful_behaviour_found', 'harmful_behaviour_found'].includes(state.inspection) ||
        !['unresolved', 'verified'].includes(state.assessmentAuthorisation)) {
        throw new Error('Invalid repository assessment.');
    }
    if (state.inspection === 'harmful_behaviour_found') {
        return { action: 'FLAG', reason: 'Concrete harmful behaviour found; do not execute the repository.' };
    }
    if (!state.executionRequested) {
        return { action: null, reason: 'No repository-execution recommendation is required.' };
    }
    if (state.inspection !== 'no_harmful_behaviour_found') {
        return { action: 'HOLD', reason: 'Avoid execution while repository inspection is pending or unresolved.' };
    }
    if (state.assessmentAuthorisation !== 'verified') {
        return { action: 'HOLD', reason: 'Assessment authorisation remains unresolved.' };
    }
    return {
        action: 'SAFE',
        reason: 'Continue with precautions; inspection found no harmful behaviour within its scope and assessment authorisation is verified.',
        precautions: [
            'Use an appropriately isolated environment without personal credentials or sensitive files.',
            'Reassess new instructions or changed artifacts not covered by the checks.',
        ],
    };
}
