// Cron scheduler — agenda tarefas que disparam um prompt no taskRunner em
// intervalos definidos. Persistido em data/cron.json. Parser de linguagem
// natural simples ("toda 6ª às 10h"), com fallback pra expressão cron crua.

const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');

const CRON_FILE = path.join(__dirname, '..', '..', 'data', 'cron.json');

// Contexto temporal injetado em todo disparo (03/11/2026). Sem ele o modelo deduzia
// data e período do dia a partir dos arquivos e memórias que lia e saudou o Lucas com
// "Boa noite ... Domingo" às 9h de uma terça-feira (um dia atrasado em quase todas as
// 75 execuções da rotina diária).
function contextoTemporal(agora = new Date(), tz = process.env.TZ || 'America/Sao_Paulo') {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(agora).map(p => [p.type, p.value]));
  const hora = parseInt(partes.hour, 10);
  const periodo = hora < 12 ? 'manhã (saudação: bom dia)'
    : hora < 18 ? 'tarde (saudação: boa tarde)'
    : 'noite (saudação: boa noite)';
  return `[Contexto temporal] Agora é ${partes.weekday}, ${partes.day}/${partes.month}/${partes.year}, ${partes.hour}:${partes.minute} no horário de Brasília — período da ${periodo}. Use exatamente esta data, este dia da semana e este período em qualquer saudação ou referência temporal; não deduza a data a partir de arquivos, memórias ou conversas anteriores.`;
}

// Prompt que vai para a tarefa: contexto temporal antes do texto do cron. Se o prompt
// é um comando de skill ("/nome"), o contexto vai depois, para o expandSkill reconhecê-lo.
function montarPrompt(prompt, agora) {
  const ctx = contextoTemporal(agora);
  return String(prompt || '').trim().startsWith('/') ? `${prompt}\n\n${ctx}` : `${ctx}\n\n${prompt}`;
}

let _taskRunner = null;
let _io = null;
const _scheduled = new Map(); // id → { task: cron.ScheduledTask, def: {...} }

function _loadAll() {
  try {
    if (!fs.existsSync(CRON_FILE)) return [];
    return fs.readJsonSync(CRON_FILE);
  } catch (e) {
    console.error('cron load fail:', e.message);
    return [];
  }
}

function _saveAll(list) {
  fs.ensureDirSync(path.dirname(CRON_FILE));
  fs.writeJsonSync(CRON_FILE, list, { spaces: 2 });
}

// Parser bem simples — cobre 80% dos casos comuns. Pra expressões esoter
// passar a expressão cron diretamente.
const DOW = { domingo: 0, 'segunda': 1, 'segunda-feira': 1, terca: 2, terça: 2, 'terca-feira': 2, 'terça-feira': 2,
              quarta: 3, 'quarta-feira': 3, quinta: 4, 'quinta-feira': 4,
              sexta: 5, '6': 5, '6a': 5, '6ª': 5, '6ª-feira': 5,
              sabado: 6, 'sábado': 6 };

function parseNaturalSchedule(nl) {
  const t = String(nl || '').toLowerCase().trim();

  // Caso 1: já é cron crua (5 campos)
  if (/^[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+\s+[\d*\/,-]+$/.test(t)) {
    return { expression: t };
  }

  // "a cada X minutos/horas"
  const mEach = t.match(/a\s*cada\s+(\d+)\s*(minuto|hora|h|min)/);
  if (mEach) {
    const n = parseInt(mEach[1]);
    const unit = mEach[2].startsWith('h') ? 'hour' : 'min';
    return { expression: unit === 'min' ? `*/${n} * * * *` : `0 */${n} * * *` };
  }

  // "todo dia às HH(:MM)"
  const mDaily = t.match(/(?:todo\s*dia|diariamente|toda[s]?\s+(?:as|às))\s*(?:as|às)?\s*(\d{1,2})(?::(\d{2}))?/);
  if (mDaily) {
    const hh = parseInt(mDaily[1]);
    const mm = parseInt(mDaily[2] || '0');
    return { expression: `${mm} ${hh} * * *` };
  }

  // "toda(s) <dia-da-semana> às HH(:MM)"
  for (const [name, dow] of Object.entries(DOW)) {
    const re = new RegExp(`tod[ao]s?\\s+(?:${name})\\s+(?:as|às)?\\s*(\\d{1,2})(?::(\\d{2}))?`);
    const m = t.match(re);
    if (m) {
      const hh = parseInt(m[1]);
      const mm = parseInt(m[2] || '0');
      return { expression: `${mm} ${hh} * * ${dow}` };
    }
  }

  return null;
}

function add({ schedule, prompt, source, tags }) {
  if (!_taskRunner) throw new Error('cron-scheduler não inicializado');
  const parsed = parseNaturalSchedule(schedule);
  if (!parsed) throw new Error(`não entendi a agenda: "${schedule}"`);
  if (!cron.validate(parsed.expression)) {
    throw new Error(`expressão cron inválida: ${parsed.expression}`);
  }
  const def = {
    id: uuidv4(),
    schedule, // string natural original
    expression: parsed.expression,
    prompt,
    source: source || 'cron',
    tags: tags || ['cron'],
    createdAt: Date.now(),
    lastRunAt: null,
    runCount: 0,
  };
  _activate(def);
  const all = _loadAll();
  all.push(def);
  _saveAll(all);
  return def;
}

function _activate(def) {
  const task = cron.schedule(def.expression, () => {
    def.lastRunAt = Date.now();
    def.runCount = (def.runCount || 0) + 1;
    _persistDef(def);
    console.log(`⏰ cron disparou: ${def.id} (${def.expression}) — "${def.prompt.slice(0, 60)}"`);
    _taskRunner.createTask({
      prompt: montarPrompt(def.prompt),
      source: def.source || 'cron',
      tags: [...(def.tags || []), `cron:${def.id}`],
      maxTurns: 10,
    });
  });
  _scheduled.set(def.id, { task, def });
}

function _persistDef(def) {
  const all = _loadAll();
  const idx = all.findIndex(d => d.id === def.id);
  if (idx === -1) all.push(def); else all[idx] = def;
  _saveAll(all);
}

function list() {
  return [..._scheduled.values()].map(s => s.def);
}

function remove(id) {
  const entry = _scheduled.get(id);
  if (!entry) return { ok: false, reason: 'not_found' };
  entry.task.stop();
  _scheduled.delete(id);
  const all = _loadAll().filter(d => d.id !== id);
  _saveAll(all);
  return { ok: true };
}

function start({ taskRunner, io }) {
  _taskRunner = taskRunner;
  _io = io;
  const defs = _loadAll();
  for (const def of defs) {
    try {
      _activate(def);
      console.log(`⏰ cron carregado: ${def.id} (${def.expression}) — "${def.prompt.slice(0, 60)}"`);
    } catch (e) {
      console.error(`❌ falha ao ativar cron ${def.id}:`, e.message);
    }
  }
  console.log(`⏰ Cron scheduler: ${_scheduled.size} jobs ativos`);
}

module.exports = { start, add, list, remove, parseNaturalSchedule, contextoTemporal, montarPrompt };
