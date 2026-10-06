import 'dotenv/config';
import { Agent, run } from '@openai/agents';
import { z } from 'zod'
import evaluationData from '../../data/evaluation-data-masked.json'
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

const BaselineResult = z.object({
  classification: z.enum(["SAFE", "FLAG"]),
  reasoning: z.string()
});

export const baselineInstruction = `
Read the complete recruiting conversation provided.

Classify the interaction as either:

SAFE
or
FLAG

Base the decision only on the visible conversation.

Do not use external information.
Do not output a probability.
Do not output HOLD or any uncertainty category.

Return a short reason for the classification.
`;

async function evaluateBaseline(messages: Message[]) {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is missing. Add it to .env before running pnpm start.");
    }

    const agent = new Agent({
        name: "Baseline Evaluator",
        instructions: baselineInstruction,
        outputType: BaselineResult,
        model: "gpt-5.6-luna",
    });

    const conversation = messages
        .map((message) => `[${message.time}] ${message.sender}: ${message.message}`)
        .join("\n\n");

    const belief = await run(agent, conversation);

    return belief.finalOutput

}




async function main() {



    const result = []
    for (const data of evaluationData) {
        const messages = data.messages.map((msg) => ({
            time: msg.time,
            sender: msg.sender,
            message: msg.message
        }));

        const baselineResult = await evaluateBaseline(messages);

        console.log(`Case ID: ${data.evaluation_id}`);
        console.log(`Baseline Classification: ${baselineResult?.classification}`);
        console.log(`Baseline Reasoning: ${baselineResult?.reasoning}`);
        console.log('----------------------------------------');
        result.push({
            ...data,
            baselineResult
        });
    }

    const timestamp = new Date().toISOString();
    fs.writeFileSync(
        `./results/baseline-result-${timestamp}.json`,
        JSON.stringify(result, null, 2)
    );
}

main().catch((error) => {
    console.error("Agent evaluation failed:");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
})
