import { actions, harmCategories } from "./constants";

// Policy A ignores the harm category and only uses the scam probability to decide on SAFE/HOLD/FLAG.
export function policyA(scamProbability: number) {

    if (scamProbability < 0 || scamProbability > 1) {
        throw new Error(`Invalid scamProbability: ${scamProbability}`);
    }

    if (scamProbability <= 0.2) {
        return actions.SAFE;
    }

    if (scamProbability > 0.2 && scamProbability <= 0.7) {

        return actions.HOLD;
    }

    if (scamProbability > 0.7) {
        return actions.FLAG;
    }

    throw new Error(`Invalid scamProbability: ${scamProbability}`);

}


// Policy B uses both the scam probability and the harm category to decide on SAFE/HOLD/FLAG.
export function policyB(scamProbability: number, harmCategory: string) {

    if (harmCategory === harmCategories.HARMFUL) {
        return actions.FLAG;
    }

    return policyA(scamProbability);

}