/**
 * claude-query.js — Wrapper para o SDK v2 do Claude Code
 *
 * O SDK v2 (@anthropic-ai/claude-code) não exporta query() programaticamente.
 * Este módulo spawna o CLI e emite os mesmos eventos que a query() do SDK v1.
 *
 * Inclui semáforo de processos e throttle por memória para evitar OOM.
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Desde a 2.1.2xx o pacote npm não traz mais cli.js — o entrypoint é o
// cli-wrapper.cjs, que executa o binário nativo em bin/ (upgrade 15/07/2026,
// necessário porque a 2.1.104 bloqueava escrita em ~/.claude/skills sem
// honrar as regras Edit(path) do settings.json).
const CLI_PATH = path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-code', 'cli-wrapper.cjs');

// Config de servidores MCP para o Claude Code spawnado (o agente René).
// Ex.: busca de voos via Kiwi MCP authless. Ausente = sem MCP extra.
const MCP_CONFIG = path.join(__dirname, 'claude-mcp-servers.json');

// Usa Node 22 se disponível (v1 cli.js crasha no Node 25)
const NODE_BIN = process.env.CLAUDE_NODE_BIN || 'node';

// ── Semáforo de processos ──
// Default 4: throttle de 85% RAM segura caso processos pesem demais.
const MAX_PROCESSES = parseInt(process.env.MAX_CLAUDE_PROCESSES || '4');
const MEMORY_THROTTLE = parseInt(process.env.MEMORY_THROTTLE_PERCENT || '85');
const SLOT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max de espera

let activeProcesses = 0;
const waitQueue = []; // Array de { resolve, timer }

function getMemoryUsagePercent() {
  const total = os.totalmem();
  const free = os.freemem();
  return ((total - free) / total) * 100;
}

function getActiveProcessCount() {
  return activeProcesses;
}

function isThrottled() {
  return activeProcesses >= MAX_PROCESSES || getMemoryUsagePercent() > MEMORY_THROTTLE;
}

async function acquireSlot() {
  if (activeProcesses < MAX_PROCESSES && getMemoryUsagePercent() <= MEMORY_THROTTLE) {
    activeProcesses++;
    return;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waitQueue.findIndex(w => w.resolve === wrappedResolve);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error('Throttle timeout: could not acquire process slot within 5 minutes'));
    }, SLOT_TIMEOUT_MS);

    const wrappedResolve = () => { clearTimeout(timer); resolve(); };
    waitQueue.push({ resolve: wrappedResolve });
  });
}

function releaseSlot() {
  activeProcesses = Math.max(0, activeProcesses - 1);

  if (waitQueue.length > 0 && activeProcesses < MAX_PROCESSES && getMemoryUsagePercent() <= MEMORY_THROTTLE) {
    const next = waitQueue.shift();
    activeProcesses++;
    next.resolve();
  }
}

// Polling: drenar waitQueue quando memória cair sem que um processo termine.
// .unref() pra não segurar o event loop sozinho — em testes isso impede o
// processo do jest de encerrar; em prod o servidor tem outros handlers vivos.
const _drainInterval = setInterval(() => {
  while (waitQueue.length > 0 && activeProcesses < MAX_PROCESSES && getMemoryUsagePercent() <= MEMORY_THROTTLE) {
    const next = waitQueue.shift();
    activeProcesses++;
    next.resolve();
  }
}, 10000);
if (typeof _drainInterval.unref === 'function') _drainInterval.unref();

// ── Query ──

async function* query({ prompt, options = {} }) {
  await acquireSlot();
  try {
    yield* _spawnQuery({ prompt, options });
  } finally {
    releaseSlot();
  }
}

async function* _spawnQuery({ prompt, options }) {
  const args = [
    CLI_PATH,
    '--output-format', 'stream-json',
    '--verbose',
    '--print',
  ];

  // Servidores MCP do agente (busca de voos Kiwi etc.) — só se o arquivo existir.
  // --strict-mcp-config: usa SÓ os servidores deste arquivo, ignorando configs
  // de usuário/projeto — senão os conectores claude.ai disputam o load no boot
  // e o Kiwi às vezes não sobe.
  // options.mcpConfigPath permite trocar o arquivo por chamada (ex: MCP restrito
  // pra DM, sem financeiro) sem afetar quem não passa essa opção.
  const mcpConfigPath = options.mcpConfigPath || MCP_CONFIG;
  if (fs.existsSync(mcpConfigPath)) args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
  if (options.maxTurns) args.push('--max-turns', String(options.maxTurns));
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.model) args.push('--model', options.model);
  if (options.appendSystemPrompt) args.push('--append-system-prompt', options.appendSystemPrompt);
  if (options.allowedTools?.length) {
    for (const tool of options.allowedTools) {
      args.push('--allowedTools', tool);
    }
  }
  if (options.includePartialMessages) args.push('--include-partial-messages');

  // O prompt vai por STDIN, não como argumento. Prompts grandes (contexto de
  // memória + system + retry) estouram o limite de tamanho por-argumento do
  // execve no Linux (MAX_ARG_STRLEN = 128KB) → spawn E2BIG. No macOS o limite
  // é maior, por isso só falhava no Linux. Em --print o CLI lê o prompt do stdin
  // (--input-format text, default).

  // Estado do loop yield: declarados ANTES do spawn porque os handlers de
  // 'error' (spawn) e 'data'/'close' fecham sobre eles. Manter aqui evita TDZ
  // num evento 'error' síncrono (ENOENT, EACCES) onde `lineQueue`/`done`
  // seriam referenciados antes da declaração se vivessem no final da função.
  let buffer = '';
  const lineQueue = [];
  let resolve;
  let done = false;

  const child = spawn(NODE_BIN, args, {
    // options.env: marcas por chamada (ex.: RENE_ACESSO_TOTAL para a trava, 30/09/2026).
    env: { ...process.env, PATH: process.env.PATH, ...(options.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd || process.cwd(),
  });

  // Prompt via stdin (ver comentário acima sobre E2BIG). O listener de 'error'
  // evita crash por EPIPE caso o filho morra antes de drenar o stdin.
  if (child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.write(String(prompt ?? ''));
    child.stdin.end();
  }

  // Sem este handler, falhas de spawn (ENOENT por cwd inválido, EACCES, etc.)
  // emitem 'error' não tratado e derrubam o processo inteiro.
  child.on('error', (err) => {
    lineQueue.push({
      type: 'result',
      subtype: 'error',
      is_error: true,
      error: `spawn failed: ${err.code || ''} ${err.message}`,
      result: `spawn failed: ${err.code || ''} ${err.message}`,
    });
    done = true;
    if (resolve) { resolve(); resolve = null; }
  });

  // Handle abort
  if (options.abortController) {
    options.abortController.signal.addEventListener('abort', () => {
      child.kill('SIGTERM');
    });
  }

  // Stderr — buffer sempre (pra incluir no erro de exit != 0) +
  // forwarding opcional via options.stderr.
  let stderrBuf = '';
  child.stderr.on('data', (data) => {
    const s = data.toString();
    stderrBuf += s;
    if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096); // só guarda os últimos 4KB
    if (options.stderr) options.stderr(s);
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim()) {
        try {
          lineQueue.push(JSON.parse(line));
          if (resolve) { resolve(); resolve = null; }
        } catch (e) {
          // skip malformed JSON
        }
      }
    }
  });

  child.on('close', (code) => {
    // Process remaining buffer
    if (buffer.trim()) {
      try {
        lineQueue.push(JSON.parse(buffer));
      } catch (e) {}
    }
    if (code !== 0) {
      // Inclui stderr no erro pra diagnóstico (rate limit, auth, token limit, etc.)
      const stderrTail = stderrBuf.trim().slice(-1500);
      const errMsg = `Claude Code process exited with code ${code}${stderrTail ? `\nstderr: ${stderrTail}` : ''}`;
      lineQueue.push({
        type: 'result',
        subtype: 'error',
        is_error: true,
        error: errMsg,
        result: errMsg,
      });
    }
    done = true;
    if (resolve) { resolve(); resolve = null; }
  });

  // Yield messages as they arrive
  while (true) {
    while (lineQueue.length > 0) {
      yield lineQueue.shift();
    }
    if (done) break;
    await new Promise(r => { resolve = r; });
  }
}

module.exports = { query, getActiveProcessCount, isThrottled, getMemoryUsagePercent };
