import { Agent, run } from '@openai/agents';
import { z } from 'zod'
import  evaluationData from '../data/labeled-scam-data.json'

type Message = {
    time: string;
    sender: string;
    message: string;
}

const Belief = z.object({
    scamProbability: z.number().min(0).max(1),
    evidenceUsed: z.string(),
    harmCategory: z.string(),
    reasoningSummary: z.string()
})

async function evaluateBelief(messages: Message[]) {

    const agent = new Agent({
        name: "Belief Evaluator",
        instructions: "",
        outputType: Belief,
    });

    const belief = await run(agent, messages.join("\n\n"));

    console.log(belief.finalOutput)

}


// testing belief evalation
evaluateBelief(evaluationData[0].messages)