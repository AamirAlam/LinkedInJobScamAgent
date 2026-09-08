import 'dotenv/config';
import { Agent, run } from '@openai/agents';
import { z } from 'zod'
import evaluationData from '../data/evaluation-data-masked.json'
import {instruction, harmCategories} from './constants'
import { policyA, policyB } from './policies'
import fs from 'fs';

declare const process: {
    env: Record<string, string | undefined>;
    exitCode?: number;
};

type Message = {
    time: string;
    sender: string;
    message: string;
}

const Belief = z.object({
  scamProbability: z.number().min(0).max(1),
  evidenceUsed: z.array(z.string()),
  harmCategory: z.enum([
    harmCategories.NON_HARMFUL,
    harmCategories.CONTEXT_DEPENDENT,
    harmCategories.HARMFUL
  ]),
  reasoningSummary: z.string()
});

async function evaluateBelief(messages: Message[]) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is missing. Add it to .env before running pnpm start.");
    }

    const agent = new Agent({
        name: "Belief Evaluator",
        instructions: instruction,
        outputType: Belief,
        model: "gpt-5.6-luna",
    });

    const conversation = messages
        .map((message) => `[${message.time}] ${message.sender}: ${message.message}`)
        .join("\n\n");

    const belief = await run(agent, conversation);

    return belief.finalOutput

}




async function main() {
    // run on fist data only
    const evaluationResult: Array<Object> = []
    for (const data of evaluationData.slice(0, 2)) {


        // store result of each case mapped with case_id
        const result:Record<string, Array<Object>> = {}
        // belief evaluation at each message step
        const observedMessaged: Message[] = []
        for (const message of data.messages) {
            observedMessaged.push(message);
            const belief = await evaluateBelief(observedMessaged);
            console.log(`Case ID: ${data.evaluation_id}`);
            console.log(`Message Time: ${message.time}`);
            console.log(`Message Sender: ${message.sender}`);
            console.log(`Message Content: ${message.message}`);
            console.log(`Scam Probability: ${belief?.scamProbability}`);
            console.log(`Evidence Used: ${belief?.evidenceUsed.join(", ")}`);
            console.log(`Harm Category: ${belief?.harmCategory}`);
            console.log(`Reasoning Summary: ${belief?.reasoningSummary}`);
            console.log("--------------------------------------------------");


            if (!result[data.evaluation_id]) {
                result[data.evaluation_id] = []
            }
            result[data.evaluation_id].push({
                time: message.time,
                scamProbability: belief?.scamProbability,
                evidenceUsed: belief?.evidenceUsed,
                harmCategory: belief?.harmCategory,
                reasoningSummary: belief?.reasoningSummary
            })
            
        }
        evaluationResult.push(result) 
        
    }

    // dump latest evalation result to a json file with timestamp in the filename
    const date = new Date();
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
  
    fs.writeFileSync(
        `./results/evaluation-result-${timestamp}.json`,
        JSON.stringify(evaluationResult, null, 2)
    );
}

main().catch((error) => {
    console.error("Agent evaluation failed:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
})
