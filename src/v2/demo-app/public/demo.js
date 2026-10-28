const byId = (id) => document.getElementById(id);
const composer = byId('composer');
const messageInput = byId('message');
const senderInput = byId('sender');
const sendButton = byId('send');
const resetButton = byId('new-chat');
let sessionId;
let messages = [];
let events = [];
let responses = {};
let busy = false;
let needsReset = false;
let flowInspected = false;
let flowInspectionReturned = false;

function updateAgentFlow(stage, detail) {
  byId('agent-flow').hidden = stage === 'idle';
  const nodes = ['message', 'assess', 'inspect', 'guide'];
  const labels = {
    pending: 'Waiting',
    active: 'In progress',
    done: 'Done',
    skipped: 'Skipped',
    error: 'Stopped',
  };
  const states = {
    idle: ['pending', 'pending', 'pending', 'pending'],
    sending: ['active', 'pending', 'pending', 'pending'],
    assessing: ['done', 'active', 'pending', 'pending'],
    inspecting: ['done', 'done', 'active', 'pending'],
    complete: [
      'done',
      'done',
      flowInspected ? (flowInspectionReturned ? 'done' : 'error') : 'skipped',
      'done',
    ],
    context: ['done', 'skipped', 'skipped', 'skipped'],
  };
  const modes = {
    idle: 'Ready',
    sending: 'Sending',
    assessing: 'Assessing',
    inspecting: 'Inspecting',
    complete: 'Complete',
    context: 'Context saved',
    error: 'Interrupted',
  };
  if (stage === 'error') {
    const activeNode =
      nodes.find((node) => byId(`flow-${node}`).dataset.state === 'active') || 'guide';
    byId(`flow-${activeNode}`).dataset.state = 'error';
    byId(`flow-${activeNode}`).querySelector('small').textContent = labels.error;
  } else {
    nodes.forEach((node, index) => {
      byId(`flow-${node}`).dataset.state = states[stage][index];
      byId(`flow-${node}`).querySelector('small').textContent = labels[states[stage][index]];
    });
  }
  byId('flow-mode').textContent = modes[stage];
  byId('flow-mode').dataset.stage = stage;
  byId('flow-status').textContent = detail;
  byId('flow-assess-note').textContent =
    stage === 'context' ? 'Candidate reply: no model call' : 'Use the conversation so far';
  byId('flow-inspect-note').textContent =
    stage === 'inspecting'
      ? 'Reading source without running code'
      : flowInspected
        ? flowInspectionReturned
          ? 'Result returned; review its limitations'
          : 'Inspection did not return a result'
        : stage === 'complete' || stage === 'context'
          ? 'No new inspection was triggered'
          : 'Only when a repository is identified';
  byId('flow-guide-note').textContent =
    stage === 'context' ? 'Previous assessment retained' : 'Explain the action and its scope';
}

function updateSuggestions() {
  byId('recruiter-suggestions').hidden = senderInput.value !== 'recruiter';
}

senderInput.addEventListener('change', updateSuggestions);
updateSuggestions();

async function loadRealExamples() {
  try {
    const response = await fetch('/real-examples.json');
    if (!response.ok) throw new Error('Examples unavailable');
    const examples = await response.json();
    if (
      !Array.isArray(examples) ||
      examples.length !== 2 ||
      !examples.every(
        (example) =>
          typeof example.title === 'string' &&
          typeof example.message === 'string' &&
          typeof example.source?.evaluation_id === 'number',
      )
    ) {
      throw new Error('Invalid examples');
    }
    const buttons = examples.map((example) => {
      const button = element('button', '', 'real-example');
      button.type = 'button';
      button.append(
        element('strong', example.title),
        element(
          'span',
          example.message.replace(/\s+/g, ' ').slice(0, 115) +
            (example.message.length > 115 ? '…' : ''),
        ),
        element(
          'small',
          `Case ${example.source.evaluation_id}${example.adaptation ? ' · Adapted for simulation' : ''}`,
        ),
      );
      button.addEventListener('click', () => {
        if (busy || needsReset || messages.length >= 20) return;
        messageInput.value = example.message;
        byId('status').textContent =
          `Loaded case ${example.source.evaluation_id}. Review or edit it, then choose Send message. No analysis has run.`;
        messageInput.focus();
      });
      return button;
    });
    byId('real-examples').replaceChildren(...buttons);
    byId('example-note').textContent =
      'These are dataset labels, not expected agent verdicts. The suspected scam example includes a repository URL added for simulation; it was not in the original message. Use a new conversation to compare examples independently.';
  } catch {
    byId('example-note').textContent =
      'Examples could not be loaded. Refresh the page, or type your own recruiter message.';
  }
}

loadRealExamples();

const starters = {
  intro:
    "Hi Aamir, we're hiring a full-stack developer. Would you be open to a quick conversation about the role?",
  repo: 'Please run npm install and npm run dev in https://github.com/AamirAlam/portfolio-app and share your feedback for our interview.',
  wallet:
    'Before the interview, connect your funded wallet and approve token spending at https://assessment.invalid/verify.',
};

document.querySelectorAll('[data-starter]').forEach((button) => {
  button.addEventListener('click', () => {
    messageInput.value = starters[button.dataset.starter];
    senderInput.value = 'recruiter';
    updateSuggestions();
    messageInput.focus();
  });
});

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function scrollThread() {
  byId('thread').scrollTop = byId('thread').scrollHeight;
}

function appendMessage(message) {
  byId('welcome').hidden = true;
  const row = element(
    'div',
    '',
    `message-row ${message.sender === 'candidate' ? 'candidate' : ''}`,
  );
  const bubble = element('article', '', 'chat-message');
  bubble.append(
    element('span', message.sender === 'candidate' ? 'Candidate' : 'Recruiter', 'message-author'),
    element('p', message.message),
  );
  row.append(bubble);
  byId('thread').append(row);
  byId('count').textContent = `${messages.length} of 20 messages`;
  scrollThread();
}

function decisionTitle(step) {
  if (step.action === 'FLAG') return 'Stop this request.';
  if (step.action === 'SAFE') return 'Continue the conversation.';
  if (step.inspection_triggered) return 'Checking the repository.';
  if (step.scope === 'wallet_approval') return 'Keep your wallet disconnected.';
  return 'Pause and verify.';
}

function showDecision(step) {
  if (step.candidate_recorded) {
    updateAgentFlow(
      'context',
      'Reply saved for the next recruiter turn. Analysis and inspection were skipped.',
    );
    const note = element('article', '', 'agent-response');
    note.append(
      element('strong', 'Reply recorded'),
      element(
        'p',
        'Saved as context for the next recruiter message. No AI analysis or inspection was run; the previous assessment still applies.',
      ),
    );
    byId('thread').append(note);
    scrollThread();
    return;
  }
  if (!['SAFE', 'HOLD', 'FLAG'].includes(step.action) || typeof step.reason !== 'string') {
    throw new Error('Unexpected assessment. Start a new conversation.');
  }
  if (step.inspection_triggered) {
    flowInspected = true;
    updateAgentFlow(
      'inspecting',
      'Repository inspection started. Execution remains on hold while the result is pending.',
    );
  } else {
    flowInspectionReturned = Boolean(step.inspection);
    updateAgentFlow(
      'complete',
      `${step.action} guidance returned. Read its scope and evidence below.`,
    );
  }
  const labels = {
    SAFE: 'Continue chatting',
    HOLD: 'Verification needed',
    FLAG: 'Harmful request flagged',
  };
  const body = step.inspection_triggered
    ? 'Do not run the project yet. The agent is reading repository source without executing code. This may take a few minutes.'
    : step.reason;
  let response = responses[step.time];
  if (!response) {
    response = element('article', '', 'agent-response');
    responses = { ...responses, [step.time]: response };
    byId('thread').append(response);
  }
  response.className = `agent-response ${step.action}`;
  const heading = element('div', '', 'response-label');
  heading.append(element('strong', 'Guardian'), element('small', labels[step.action]));
  response.replaceChildren(heading, element('p', body));
  byId('verdict').className = `verdict ${step.action}`;
  byId('action-label').textContent =
    `${step.action} · ${step.scope === 'wallet_approval' ? 'Wallet permission' : step.scope === 'repository_execution' ? 'Repository execution' : 'Conversation only'}`;
  byId('verdict-title').textContent = decisionTitle(step);
  byId('verdict-body').textContent = body;
  const wallet = step.wallet_annotation;
  const execution = step.annotation;
  const quote =
    wallet && wallet.status !== 'absent_so_far'
      ? wallet.quote
      : execution && execution.status !== 'absent_so_far'
        ? execution.quote
        : null;
  byId('evidence-section').hidden = !quote;
  byId('evidence').textContent = quote || '';
  byId('details').textContent = JSON.stringify(step, null, 2);
  byId('status').textContent = step.inspection_triggered
    ? 'Reading repository source. Keep execution on hold…'
    : 'Assessment received.';
  scrollThread();
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value || needsReset || messages.length >= 20;
  resetButton.disabled = value;
  messageInput.disabled = value || needsReset || messages.length >= 20;
  senderInput.disabled = value;
  sendButton.textContent = value
    ? senderInput.value === 'candidate'
      ? 'Saving reply…'
      : 'Analysing…'
    : 'Send message ↗';
  composer.setAttribute('aria-busy', String(value));
}

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!busy && !needsReset) composer.requestSubmit();
  }
});

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || busy || needsReset || messages.length >= 20) return;
  setBusy(true);
  flowInspected = false;
  flowInspectionReturned = false;
  updateAgentFlow(
    'sending',
    senderInput.value === 'candidate'
      ? 'Saving a candidate reply as context; no model analysis will run.'
      : 'Sending the recruiter message to the local agent.',
  );
  byId('status').textContent =
    senderInput.value === 'candidate'
      ? 'Saving the candidate reply as context…'
      : 'Reading the new message in context…';
  let accepted = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        message: { sender: senderInput.value, message: text },
      }),
    });
    if (!response.ok) {
      if (response.status === 410) needsReset = true;
      throw new Error((await response.json()).error);
    }
    // Once accepted, a broken stream needs a fresh chat; silently retrying could duplicate a request.
    accepted = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let complete = false;
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const item = JSON.parse(line);
        events = [...events, item];
        if (item.type === 'started') {
          updateAgentFlow(
            item.message.sender === 'candidate' ? 'sending' : 'assessing',
            item.message.sender === 'candidate'
              ? 'Recording context without running model analysis.'
              : 'Assessing the visible request and conversation context.',
          );
          sessionId = item.session_id;
          messages = [...messages, item.message];
          appendMessage(item.message);
          messageInput.value = '';
        }
        if (item.type === 'decision') showDecision(item.step);
        if (item.type === 'error') throw new Error(item.message);
        if (item.type === 'complete') complete = true;
      }
      if (done) break;
    }
    if (!complete)
      throw new Error('Connection interrupted. Start a new conversation before continuing.');
    byId('status').textContent =
      messages.length >= 20
        ? 'Conversation limit reached. Start a new conversation to test more messages.'
        : 'Ready for the next message. Previous context is retained.';
  } catch (error) {
    updateAgentFlow(
      'error',
      'Analysis could not finish. No additional action is authorised. Check the chat status for the next step.',
    );
    if (accepted) needsReset = true;
    byId('status').textContent =
      `${error.message || 'Unable to analyse this message.'}${needsReset ? ' Choose New conversation to continue.' : ''}`;
  } finally {
    setBusy(false);
    byId('download').disabled = events.length === 0;
    if (!needsReset) messageInput.focus();
  }
});

resetButton.addEventListener('click', async () => {
  if (busy) return;
  if (sessionId) {
    try {
      const response = await fetch('/api/chat', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (!response.ok) {
        byId('status').textContent =
          'Could not reset the conversation. Wait for analysis to finish and try again.';
        return;
      }
    } catch {
      byId('status').textContent = 'Demo server unavailable. Restart it and refresh this page.';
      return;
    }
  }
  sessionId = undefined;
  messages = [];
  events = [];
  responses = {};
  needsReset = false;
  flowInspected = false;
  flowInspectionReturned = false;
  updateAgentFlow('idle', 'Activity will appear here when you send a message.');
  byId('thread')
    .querySelectorAll('.message-row, .agent-response')
    .forEach((node) => node.remove());
  byId('welcome').hidden = false;
  byId('count').textContent = '0 of 20 messages';
  byId('verdict').className = 'verdict neutral';
  byId('action-label').textContent = 'Awaiting a message';
  byId('verdict-title').textContent = 'Context comes first.';
  byId('verdict-body').textContent = 'Type a recruiter message to begin a fresh conversation.';
  byId('evidence-section').hidden = true;
  byId('details').textContent = 'Send a message to see the source-backed decision.';
  byId('technical-details').open = false;
  byId('download').disabled = true;
  byId('status').textContent = 'New conversation. Previous context has been cleared.';
  messageInput.value = '';
  setBusy(false);
  messageInput.focus();
});

byId('download').addEventListener('click', () => {
  const report = {
    purpose: 'local_demo_chat',
    created_at: new Date().toISOString(),
    belief_update: 'none_no_real_likelihoods_configured',
    messages,
    events,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'guardian-conversation.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
