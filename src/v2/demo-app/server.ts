import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createChatSession,
  parseReplayConversation,
  runReplayConversation,
} from './agent-adapter.ts';

const MAX_BODY_BYTES = 64 * 1024;
const CHAT_TTL_MS = 30 * 60 * 1000;
const MAX_CHATS = 8;
type ConversationRunner = (input: unknown) => AsyncIterable<unknown>;
const chatRequestSchema = z.object({
  session_id: z.string().uuid().optional(),
  message: z.unknown(),
});

function sendJson(response: Response, status: number, message: string) {
  response.status(status).json({ error: message });
}

/** Create the isolated demo's Express app. V2 is accessed only through the agent adapter. */
export function createDemoApp(
  run: ConversationRunner = runReplayConversation,
  newChat = createChatSession,
) {
  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  let active = false;
  let chats: Readonly<
    Record<string, { session: ReturnType<typeof createChatSession>; touched: number }>
  > = {};
  app.use((request, response, next) => {
    const expectedHost = `127.0.0.1:${request.socket.localPort}`;
    // Reject cross-site browser requests and DNS rebinding before parsing input.
    if (
      request.socket.localAddress !== '127.0.0.1' ||
      request.headers.host !== expectedHost ||
      (request.headers.origin && request.headers.origin !== `http://${expectedHost}`)
    ) {
      sendJson(response, 403, 'Use the local demo origin.');
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    next();
  });
  const assets: Readonly<Record<string, string>> = {
    '/': 'index.html',
    '/demo.js': 'demo.js',
    '/demo.css': 'demo.css',
    '/real-examples.json': 'real-examples.json',
  };
  app.get(Object.keys(assets), (request, response) => {
    response.sendFile(
      join(__dirname, 'public', assets[request.path]),
      { dotfiles: 'deny' },
      (error) => {
        if (error && !response.headersSent) {
          sendJson(response, 500, 'Demo asset unavailable.');
        }
      },
    );
  });
  app.use(['/api/chat', '/api/replay'], express.json({ limit: MAX_BODY_BYTES }));
  app.all(['/api/chat', '/api/replay'], async (request, response) => {
    const body: unknown = request.body;
    if (!(
      (request.method === 'POST' && ['/api/replay', '/api/chat'].includes(request.url ?? '')) ||
      (request.method === 'DELETE' && request.url === '/api/chat')
    )) {
      sendJson(response, 404, 'Route not found.');
      return;
    }
    if (!request.is('application/json')) {
      sendJson(response, 415, 'Send application/json.');
      return;
    }
    if (active) {
      sendJson(response, 409, 'A replay is already running. Wait for it to finish.');
      return;
    }
    active = true;
    try {
      if (request.method === 'DELETE') {
        try {
          const parsed = z.object({ session_id: z.string().uuid() }).parse(body);
          chats = Object.fromEntries(
            Object.entries(chats).filter(([id]) => id !== parsed.session_id),
          );
          response.writeHead(204);
          response.end();
        } catch {
          sendJson(response, 400, 'Provide a valid session_id.');
        }
        return;
      }
      if (request.url === '/api/chat') {
        let submission: ReturnType<ReturnType<typeof createChatSession>['append']>;
        let sessionId: string;
        try {
          const parsed = chatRequestSchema.parse(body);
          chats = Object.fromEntries(
            Object.entries(chats).filter(([, chat]) => Date.now() - chat.touched < CHAT_TTL_MS),
          );
          if (parsed.session_id && !chats[parsed.session_id]) {
            sendJson(response, 410, 'Chat expired. Start a new chat.');
            return;
          }
          if (!parsed.session_id && Object.keys(chats).length >= MAX_CHATS) {
            sendJson(
              response,
              429,
              'Demo chat capacity reached. Restart the local server or wait 30 minutes.',
            );
            return;
          }
          sessionId = parsed.session_id ?? randomUUID();
          const session = chats[sessionId]?.session ?? newChat();
          submission = session.append(parsed.message);
          chats = { ...chats, [sessionId]: { session, touched: Date.now() } };
        } catch {
          sendJson(
            response,
            400,
            'Invalid message or chat limit reached. Use recruiter/candidate and 1–8000 characters; maximum 20 messages per chat.',
          );
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
        response.flushHeaders();
        response.write(
          JSON.stringify({ type: 'started', session_id: sessionId, message: submission.message }) +
            '\n',
        );
        // Finish a submitted message even if the page disconnects, preserving session history.
        for await (const step of submission.steps) {
          if (!response.destroyed) {
            response.write(JSON.stringify({ type: 'decision', step }) + '\n');
          }
        }
        if (!response.destroyed) {
          response.end(JSON.stringify({ type: 'complete' }) + '\n');
        }
        return;
      }
      let conversation: ReturnType<typeof parseReplayConversation>;
      try {
        conversation = parseReplayConversation(body);
      } catch {
        sendJson(response, 400, 'Invalid conversation. Maximum: 20 messages and 64 KiB JSON.');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      response.flushHeaders();
      response.write(JSON.stringify({ type: 'started', messages: conversation.length }) + '\n');
      for await (const step of run({ messages: conversation })) {
        if (response.destroyed) {
          break;
        }
        response.write(JSON.stringify({ type: 'decision', step }) + '\n');
      }
      if (!response.destroyed) {
        response.end(JSON.stringify({ type: 'complete' }) + '\n');
      }
    } catch {
      // External API errors may contain credentials or payloads; keep details server-side too.
      if (!response.destroyed) {
        if (!response.headersSent) {
          sendJson(response, 500, 'Replay failed. Check server configuration.');
        } else {
          response.end(
            JSON.stringify({
              type: 'error',
              message: 'Replay failed; no new action is authorised.',
            }) + '\n',
          );
        }
      }
    } finally {
      active = false;
    }
  });
  app.use((_request, response) => {
    sendJson(response, 404, 'Route not found.');
  });
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (!response.headersSent) {
      sendJson(response, 400, 'Invalid JSON or request exceeds 64 KiB.');
    }
  });
  return app;
}

/** Wrap the Express app in an HTTP server; callers must bind it to loopback. */
export function createDemoServer(
  run: ConversationRunner = runReplayConversation,
  newChat = createChatSession,
) {
  return createServer(createDemoApp(run, newChat));
}

if (require.main === module) {
  const server = createDemoServer();
  server.on('error', () =>
    console.error('Could not start demo. Check whether port 3210 is occupied.'),
  );
  server.listen(3210, '127.0.0.1', () => console.log('V2 demo: http://127.0.0.1:3210'));
}
