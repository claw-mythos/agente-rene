/**
 * openai-compat.js — Endpoint OpenAI-compatível que embrulha o Claude Code CLI.
 *
 * Expõe o modelo "claudecode" via /v1/chat/completions (+ /v1/models), rodando
 * cada requisição pelo claude-query.js (que spawna o CLI e bilha na ASSINATURA
 * Claude, não em API key). Serve pra plugar o Claude Code como "modelo" em
 * clientes OpenAI-compatíveis — ex.: o provider custom do hermes-webui.
 *
 * Montagem: require('./services/openai-compat').mount(app) no server.js.
 *
 * Auth: se OPENAI_COMPAT_KEY estiver setado no .env, exige Bearer igual. Sem a
 * var, aceita qualquer Authorization (o endpoint é local; o túnel expõe só o webui).
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../claude-query');

const MODEL_ID = 'claudecode';

// cwd NEUTRO: rodar no diretório do backend faria o CLI carregar o CLAUDE.md de
// swarm (que o instrui a agir como agente de código e usar ferramentas). Um dir
// vazio dedicado evita esse auto-discovery e mantém comportamento de "chat".
const NEUTRAL_CWD = process.env.CLAUDECODE_CWD || path.join(os.tmpdir(), 'claudecode-shim-cwd');
try { fs.mkdirSync(NEUTRAL_CWD, { recursive: true }); } catch (_) {}

// Modelo AGÊNTICO "rene": roda o CLI dentro do workspace bridge-rene, que
// auto-descobre o CLAUDE.md e as skills. Sem diretiva de chat — pode usar
// ferramentas, então requests podem levar minutos.
const RENE_MODEL_ID = 'rene';
const RENE_CWD = process.env.RENE_CWD
  || path.join(__dirname, '..', 'bridge-rene');

// Modelo AGÊNTICO "rene-dm": igual ao "rene" (mesmo cwd/skills), mas com um
// MCP config restrito — usado nas conversas individuais (DM), sem acesso aos
// objetos financeiros do Twenty CRM nem a kiwi/abacatepay. A credencial do
// Twenty usada aqui (TWENTY_API_KEY_DM) precisa ter permissão reduzida no
// próprio CRM — o arquivo de MCP sozinho não é barreira de segurança real,
// só decide quais tools ficam visíveis.
const RENE_DM_MODEL_ID = 'rene-dm';
// Modelo "rene-admin" (30/09/2026): o do perfil admin-full do Hermes, que só
// recebe conversas roteadas pelo identificador real do WhatsApp (Dr. Lucas e
// Lucrecia). Mesmo MCP do rene-dm. Dentro dele, a conversa do Dr. Lucas leva
// RENE_ACESSO_TOTAL=1 e a trava (rene-trava) libera e só registra. Fora deste
// modelo o nome no prompt nunca dá acesso total (nome de WhatsApp se troca).
const RENE_ADMIN_MODEL_ID = 'rene-admin';
const DONO_ACESSO_TOTAL = /^\*\*User:\*\*\s+"Lucas dos Santos"\s*$/m;
const RENE_DM_MCP_CONFIG = path.join(__dirname, '..', 'claude-mcp-servers-dm.json');

// Diretiva que transforma o Claude Code (agêntico) num assistente de chat direto.
const CHAT_DIRECTIVE =
  'Você é um assistente de chat. Responda direta e concisamente à conversa usando ' +
  'apenas seu próprio conhecimento. NÃO use ferramentas, NÃO explore arquivos, NÃO ' +
  'rode comandos e NÃO faça preâmbulos como "deixa eu verificar" — apenas responda.';

// Junta as mensagens do formato OpenAI num único prompt + system prompt.
// - mensagens 'system' → concatenadas em appendSystemPrompt
// - demais turnos → "Role: conteúdo" em ordem, pra dar contexto ao CLI
function _flattenMessages(messages) {
  const systemParts = [];
  const convoParts = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m && m.role;
    // content pode ser string ou array de blocos {type:'text', text}
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
    }
    if (!text) continue;
    if (role === 'system') {
      systemParts.push(text);
    } else if (role === 'assistant') {
      convoParts.push(`Assistant: ${text}`);
    } else {
      convoParts.push(`User: ${text}`);
    }
  }
  return {
    appendSystemPrompt: systemParts.join('\n\n'),
    prompt: convoParts.join('\n\n'),
  };
}

function _authOk(req) {
  const expected = process.env.OPENAI_COMPAT_KEY;
  if (!expected) return true; // sem chave configurada → libera (uso local)
  const hdr = req.headers['authorization'] || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  return token === expected;
}

function _chunk(id, created, model, delta, finish_reason = null) {
  return {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason }],
  };
}

function mount(app) {
  const jsonBig = express.json({ limit: '25mb' });

  // Lista de modelos — alguns clientes chamam isto antes de usar.
  app.get('/v1/models', (req, res) => {
    if (!_authOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });
    res.json({
      object: 'list',
      data: [
        { id: MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: RENE_MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: RENE_DM_MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
        { id: RENE_ADMIN_MODEL_ID, object: 'model', created: 0, owned_by: 'anthropic-claude-code' },
      ],
    });
  });

  app.post('/v1/chat/completions', jsonBig, async (req, res) => {
    if (!_authOk(req)) return res.status(401).json({ error: { message: 'invalid api key', type: 'invalid_request_error' } });

    const body = req.body || {};
    const stream = body.stream === true;
    const { appendSystemPrompt, prompt } = _flattenMessages(body.messages);
    if (!prompt) {
      return res.status(400).json({ error: { message: 'messages: pelo menos uma mensagem user/assistant com conteúdo', type: 'invalid_request_error' } });
    }

    const id = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    // model=rene → agêntico, MCP completo. model=rene-dm → agêntico, MCP
    // restrito (sem financeiro). Qualquer outro valor → chat puro.
    const reqModel = String(body.model || '').toLowerCase();
    const agenticFull = reqModel === RENE_MODEL_ID;
    const agenticAdmin = reqModel === RENE_ADMIN_MODEL_ID;
    const agenticDm = reqModel === RENE_DM_MODEL_ID || agenticAdmin;
    const acessoTotal = agenticAdmin && DONO_ACESSO_TOTAL.test(appendSystemPrompt || '');
    const agentic = agenticFull || agenticDm;
    const respModel = agenticFull ? RENE_MODEL_ID : agenticAdmin ? RENE_ADMIN_MODEL_ID : agenticDm ? RENE_DM_MODEL_ID : MODEL_ID;

    // Chat: cwd neutro + diretiva → responde direto sem virar agente de código
    // (maxTurns com folga é só rede de segurança; a diretiva deve manter 1 turno).
    // Agêntico (rene/rene-dm): cwd no bridge-rene, sem diretiva, maxTurns maior
    // pra dar conta de skills. rene-dm troca só o mcpConfigPath.
    const options = {
      maxTurns: agentic
        ? parseInt(process.env.RENE_MAX_TURNS || '30')
        : parseInt(process.env.CLAUDECODE_MAX_TURNS || '8'),
      permissionMode: 'bypassPermissions',
      includePartialMessages: false,
      cwd: agentic ? RENE_CWD : NEUTRAL_CWD,
      appendSystemPrompt: agentic
        ? appendSystemPrompt
        : [CHAT_DIRECTIVE, appendSystemPrompt].filter(Boolean).join('\n\n'),
      ...(agenticDm ? { mcpConfigPath: RENE_DM_MCP_CONFIG } : {}),
      ...(acessoTotal ? { env: { RENE_ACESSO_TOTAL: '1', RENE_SOLICITANTE: 'Lucas dos Santos (perfil admin-full, 109693481525364@lid)' } } : {}),
    };

    // DEBUG (CLAUDECODE_DEBUG=1): dump do prompt/options pra diagnosticar exit 1.
    if (process.env.CLAUDECODE_DEBUG === '1') {
      try {
        require('fs').writeFileSync('/tmp/cc-lastreq.json', JSON.stringify({
          promptLen: prompt.length, sysLen: options.appendSystemPrompt.length,
          prompt, appendSystemPrompt: options.appendSystemPrompt, stream,
        }));
      } catch (_) {}
    }

    // Coleta a resposta com RETRY. O Claude Code (assinatura) às vezes sai com
    // exit 1 SEM texto por rate-limit transitório — repetir resolve (é o que o
    // "regenerate" manual faz). Só falha de vez se todas as tentativas vierem vazias.
    // Se veio texto, um exit != 0 posterior (rate_limit_event/cleanup) é ignorado.
    const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.CLAUDECODE_RETRIES || '3'));
    let text = '';
    let usage = null;
    let errored = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      text = ''; usage = null; errored = null;
      try {
        for await (const m of query({ prompt, options })) {
          if (m.type === 'result') {
            if (m.is_error) errored = String(m.error || m.result || 'claude code error');
            else {
              if (typeof m.result === 'string') text = m.result;
              usage = m.usage || null;
            }
          } else if (m.type === 'assistant' && m.message?.content && !text) {
            text = m.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
          }
        }
      } catch (e) {
        errored = e.message || String(e);
      }
      if (text) break;                                       // sucesso → para
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[openai-compat] tentativa ${attempt}/${MAX_ATTEMPTS} falhou (${errored}); retry…`);
        await new Promise(r => setTimeout(r, 700 * attempt)); // backoff curto
      }
    }

    // ── Streaming (SSE): entrega o texto coletado (robusto; não token-a-token) ──
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send(_chunk(id, created, respModel, { role: 'assistant' }));
      if (text) {
        send(_chunk(id, created, respModel, { content: text }));
        send(_chunk(id, created, respModel, {}, 'stop'));
      } else {
        send(_chunk(id, created, respModel, { content: `\n[erro claudecode: ${errored || 'sem resposta'}]` }, 'stop'));
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // ── Não-streaming ──
    if (!text && errored) {
      return res.status(500).json({ error: { message: errored, type: 'api_error' } });
    }

    res.json({
      id, object: 'chat.completion', created, model: respModel,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage?.input_tokens ?? 0,
        completion_tokens: usage?.output_tokens ?? 0,
        total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      },
    });
  });
}

module.exports = { mount, MODEL_ID };
