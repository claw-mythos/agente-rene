/**
 * Roteador Jev (29/10/2026, pedido do Julio): antes de cada resposta do René, o
 * Jev (modelo de decisão estruturada do SistemaLA, rota /api/agentes/decidir/)
 * classifica o peso do pedido e a ponte escolhe o motor e o modelo:
 *
 *   leve   → OpenAI (assinatura do ChatGPT via `hermes chat`, provedor openai-codex),
 *            com reserva automática no Claude Code em modelo leve se a OpenAI falhar;
 *   media  → Claude Code em Sonnet, com as ferramentas do René;
 *   pesada → Claude Code no modelo padrão do settings.json (Opus), tudo como antes.
 *
 * Cada nível também poda o histórico (o Hermes manda a conversa inteira) e
 * limita turnos e tentativas. Jev fora do ar ou sem chave → "pesada", isto é,
 * o comportamento anterior. Níveis e modelos em roteador.json (editável sem
 * mexer no código); chave em SISTEMALA_DECISOES_KEY (.env), só escopo decisoes.
 * Toda decisão fica em logs/roteador.log.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const CONFIG = path.join(RAIZ, 'roteador.json');
const LOG = path.join(RAIZ, 'logs', 'roteador.log');
const NIVEIS = ['leve', 'media', 'pesada'];

const PADRAO = {
  ativo: true,
  finalidade: 'roteamento-rene',
  decisoes_url: 'https://lucroativo.online/api/agentes/decidir/',
  tempo_limite_jev_ms: 15000,
  limiar_ferramentas: 0.5,
  confianca_minima: 0.55,
  niveis: {
    leve: { motor: 'openai', modelo: 'gpt-5.6-sol', historico: 16, tentativas: 1,
            reserva: { motor: 'claude', modelo: 'haiku', max_turns: 4 } },
    media: { motor: 'claude', modelo: 'sonnet', max_turns: 20, historico: 60, tentativas: 2 },
    pesada: { motor: 'claude', modelo: '', max_turns: 30, historico: 300, tentativas: 3 },
  },
};

function _config() {
  try {
    const lido = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    return { ...PADRAO, ...lido, niveis: { ...PADRAO.niveis, ...(lido.niveis || {}) } };
  } catch (_) {
    return PADRAO;
  }
}

function ativo() {
  if (process.env.ROTEADOR_ATIVO === '0') return false;
  return _config().ativo !== false && Boolean(process.env.SISTEMALA_DECISOES_KEY);
}

function _log(linha) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${JSON.stringify(linha)}\n`);
  } catch (_) {}
}

function _texto(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

/** Última mensagem do usuário, a resposta anterior do assistente e o tamanho do histórico. */
function _resumoDaConversa(mensagens) {
  const lista = Array.isArray(mensagens) ? mensagens.filter(m => m && m.role !== 'system') : [];
  let ultima = '';
  let anterior = '';
  for (let i = lista.length - 1; i >= 0; i--) {
    const t = _texto(lista[i]);
    if (!t) continue;
    if (!ultima && lista[i].role === 'user') { ultima = t; continue; }
    if (ultima && lista[i].role === 'assistant') { anterior = t; break; }
  }
  return { ultima: ultima.slice(0, 3000), anterior: anterior.slice(-1500), total: lista.length };
}

const PERGUNTAS = {
  peso: {
    type: 'choice',
    instructions: 'Qual o peso do trabalho necessário para responder bem à ÚLTIMA mensagem do usuário? '
      + 'Uma confirmação curta ("ok", "pode", "sim") que autoriza uma tarefa proposta na mensagem anterior '
      + 'do assistente tem o peso dessa tarefa, não da palavra.',
    criteria: {
      leve: 'cumprimento, agradecimento, resposta curta de memória ou da própria conversa, sem consultar '
        + 'sistema, arquivo ou internet e sem gerar documento',
      media: 'exige uma ou poucas consultas (SistemaLA, Drive, e-mail, agenda, um arquivo) ou um texto curto; '
        + 'poucos passos',
      pesada: 'tarefa longa: gerar ou revisar documento, planilha, apresentação ou código, várias consultas '
        + 'encadeadas, análise extensa, ou continuação de trabalho pesado em andamento',
    },
  },
  precisa_ferramentas: {
    type: 'noul',
    instructions: 'Para responder bem à última mensagem é preciso usar ferramentas (SistemaLA, Google Drive, '
      + 'e-mail, arquivos, código ou internet), e não só a memória da conversa?',
  },
};

async function _perguntarAoJev(cfg, estado) {
  const controlador = new AbortController();
  const relogio = setTimeout(() => controlador.abort(), cfg.tempo_limite_jev_ms);
  try {
    const r = await fetch(cfg.decisoes_url, {
      method: 'POST',
      headers: { 'Authorization': `Api-Key ${process.env.SISTEMALA_DECISOES_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ finalidade: cfg.finalidade, state: estado, questions: PERGUNTAS }),
      signal: controlador.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const corpo = await r.json();
    return corpo.respostas || corpo.answers || null;
  } finally {
    clearTimeout(relogio);
  }
}

function _sobe(nivel) {
  return NIVEIS[Math.min(NIVEIS.indexOf(nivel) + 1, NIVEIS.length - 1)];
}

/**
 * Decide o nível. Devolve { nivel, cfg, motivo, jev } — nunca lança: qualquer
 * falha vira "pesada" com o motivo registrado.
 */
async function classificar({ mensagens, modelo }) {
  const cfg = _config();
  const resumo = _resumoDaConversa(mensagens);
  const inicio = Date.now();
  let nivel = 'pesada';
  let motivo = '';
  let jev = null;
  try {
    jev = await _perguntarAoJev(cfg, {
      agente: 'René (Hermes, WhatsApp)', perfil: modelo,
      ultima_mensagem_do_usuario: resumo.ultima,
      resposta_anterior_do_assistente: resumo.anterior,
      mensagens_no_historico: resumo.total,
    });
    const peso = jev && jev.peso;
    const ferramentas = jev && jev.precisa_ferramentas ? Number(jev.precisa_ferramentas.noul) : 1;
    if (!peso || !NIVEIS.includes(peso.choice)) throw new Error('resposta do Jev sem peso');
    nivel = peso.choice;
    motivo = `jev peso=${nivel} (${Math.round((peso.probabilities?.[nivel] ?? 0) * 100)}%, confiança ${peso.confidence ?? '?'}), ferramentas ${Math.round(ferramentas * 100)}%`;
    if (nivel === 'leve' && ferramentas >= cfg.limiar_ferramentas) { nivel = 'media'; motivo += '; subiu por precisar de ferramentas'; }
    if (Number(peso.confidence ?? 1) < cfg.confianca_minima && nivel !== 'pesada') { nivel = _sobe(nivel); motivo += '; subiu por confiança baixa'; }
  } catch (e) {
    nivel = 'pesada';
    motivo = `jev indisponível (${e.name === 'AbortError' ? 'tempo esgotado' : e.message}); padrão pesada`;
  }
  const decisao = { nivel, cfg: cfg.niveis[nivel] || cfg.niveis.pesada, motivo, jev, ms_jev: Date.now() - inicio, resumo };
  _log({ etapa: 'decisao', nivel, motivo, ms_jev: decisao.ms_jev, historico: resumo.total,
         ultima: resumo.ultima.slice(0, 120) });
  return decisao;
}

/** Mantém as mensagens de sistema e as últimas `n` da conversa. */
function podarHistorico(mensagens, n) {
  if (!Array.isArray(mensagens) || !n) return mensagens;
  const sistema = mensagens.filter(m => m && m.role === 'system');
  const conversa = mensagens.filter(m => m && m.role !== 'system');
  if (conversa.length <= n) return mensagens;
  return [...sistema, ...conversa.slice(-n)];
}

/**
 * Resposta leve pela OpenAI (assinatura do ChatGPT) com o próprio Hermes em modo
 * avulso: credencial, atualização de token e persona do René ficam com o Hermes.
 * Devolve '' em qualquer falha, para a ponte cair na reserva.
 */
function responderOpenAI({ mensagens, modelo, tempoLimiteMs = 120000 }) {
  return new Promise(resolve => {
    const conversa = mensagens.filter(m => m && m.role !== 'system').map(m => `${m.role === 'assistant' ? 'Assistente' : 'Usuário'}: ${_texto(m)}`).join('\n\n');
    const pedido = 'Continue a conversa abaixo como o assistente, respondendo APENAS à última mensagem do usuário, '
      + 'no mesmo idioma, em poucas linhas, sem usar ferramentas e sem preâmbulos. '
      + 'Não repita o histórico.\n\n' + conversa;
    const arquivo = path.join(os.tmpdir(), `rene-leve-${process.pid}-${Date.now()}.txt`);
    try { fs.writeFileSync(arquivo, pedido, { mode: 0o600 }); } catch (e) { return resolve(''); }
    const casa = process.env.HOME || os.homedir();
    const env = { ...process.env, PATH: `${casa}/.local/bin:${process.env.PATH || ''}`, PYTHONUNBUFFERED: '1' };
    const args = ['chat', '--query-file', arquivo, '--oneshot', '-Q', '--reasoning', 'low',
                  '--provider', 'openai-codex', '-m', modelo];
    const filho = spawn('hermes', args, { env, cwd: casa, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    let erro = '';
    const relogio = setTimeout(() => filho.kill('SIGTERM'), tempoLimiteMs);
    filho.stdout.on('data', d => { saida += d; });
    filho.stderr.on('data', d => { erro += d; });
    filho.on('error', () => { clearTimeout(relogio); try { fs.unlinkSync(arquivo); } catch (_) {} resolve(''); });
    filho.on('close', codigo => {
      clearTimeout(relogio);
      try { fs.unlinkSync(arquivo); } catch (_) {}
      const limpo = saida.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .split('\n').filter(l => l.trim() && !/^session_id:/i.test(l.trim())).join('\n').trim();
      const falhou = codigo !== 0 || !limpo || /^(HTTP \d{3}|API call failed|Error)/i.test(limpo);
      _log({ etapa: 'openai', modelo, codigo, ok: !falhou, chars: limpo.length, erro: falhou ? (limpo || erro).slice(0, 160) : '' });
      resolve(falhou ? '' : limpo);
    });
  });
}

module.exports = { ativo, classificar, podarHistorico, responderOpenAI, NIVEIS };
