# LinkedInJobScamAgent

The agent reads the conversation and it must suggest safe, hold, or flag the person as potential scammer

## Run the Agent

Install dependencies:

```bash
pnpm install
```

Create `.env` and add your OpenAI API key:

```bash
OPENAI_API_KEY=your_api_key_here
```

Run the agent:

```bash
pnpm start
```

This runs `src/agent_v0.ts`, loads `.env`, and prints the agent evaluation result in the terminal.

If you see `No API key provided for OpenAI tracing exporter`, that only means trace export is disabled. The agent can still run as long as `OPENAI_API_KEY` is set.

## Evaluation Data

- `data/evaluation-data.json` contains the conversations with ground truth labels.
- `data/evaluation-data-masked.json` contains the same conversations without ground truth labels.

The current agent file is wired to run one sample conversation. Change the imported data file or selected index in `src/agent_v0.ts` to evaluate a different case.
