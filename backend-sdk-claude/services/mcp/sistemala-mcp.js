#!/usr/bin/env node
// services/mcp/sistemala-mcp.js — conector MCP (stdio) do René com o SistemaLA.
//
// Substitui o Twenty (crm.meulucroativo.seg.br, fora do ar desde 09/2026) pela
// API de agentes do SistemaLA (lucroativo.online/api/agentes/). Decisões do
// Julio em 29/09/2026: SÓ CONSULTA (nenhuma ferramenta grava); conversa
// individual vê o CRM sem financeiro; grupo de fechamento vê também faturas.
//
// Ambiente:
//   SISTEMALA_URL         base da API (padrão https://lucroativo.online/api/agentes)
//   SISTEMALA_API_KEY     chave de API (escopos definidos no SistemaLA)
//   SISTEMALA_FINANCEIRO  "1" registra a ferramenta de faturas (só no grupo)
// A permissão real fica no SistemaLA: a chave da conversa individual não tem
// o escopo financeiro, então a API recusa mesmo que a ferramenta exista.
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const BASE = (process.env.SISTEMALA_URL || 'https://lucroativo.online/api/agentes').replace(/\/+$/, '');
const CHAVE = process.env.SISTEMALA_API_KEY || '';
const FINANCEIRO = process.env.SISTEMALA_FINANCEIRO === '1';
const TIMEOUT_MS = 20000;

async function consultar(caminho, parametros = {}) {
  if (!CHAVE) throw new Error('SISTEMALA_API_KEY não configurada.');
  const url = new URL(`${BASE}/${caminho.replace(/^\/+/, '')}`);
  for (const [nome, valor] of Object.entries(parametros)) {
    if (valor !== undefined && valor !== null && valor !== '') url.searchParams.set(nome, String(valor));
  }
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(url, {
      headers: { Authorization: `Api-Key ${CHAVE}`, Accept: 'application/json' },
      signal: controle.signal,
    });
    const texto = await resposta.text();
    let corpo;
    try { corpo = JSON.parse(texto); } catch { corpo = { erro: texto.slice(0, 200) }; }
    if (!resposta.ok) {
      throw new Error(`SistemaLA respondeu ${resposta.status}: ${corpo.erro || 'erro'}`);
    }
    return corpo;
  } finally {
    clearTimeout(relogio);
  }
}

function resultado(dados) {
  return { content: [{ type: 'text', text: JSON.stringify(dados, null, 1) }] };
}

function ferramenta(servidor, nome, descricao, esquema, caminho) {
  servidor.registerTool(nome, { description: descricao, inputSchema: esquema }, async (args) => {
    try {
      const destino = typeof caminho === 'function' ? caminho(args) : caminho;
      const { id, ...parametros } = args || {};
      return resultado(await consultar(destino, parametros));
    } catch (erro) {
      return { content: [{ type: 'text', text: `Erro ao consultar o SistemaLA: ${erro.message}` }], isError: true };
    }
  });
}

const paginacao = {
  pagina: z.number().int().min(1).optional().describe('Página (padrão 1).'),
  limite: z.number().int().min(1).max(200).optional().describe('Itens por página (padrão 50, máximo 200).'),
};

const servidor = new McpServer({ name: 'sistemala', version: '1.0.0' });

ferramenta(servidor, 'resumo_funil',
  'Resumo do Funil Comercial do SistemaLA: por etapa, quantidade de oportunidades, soma do valor estimado e quantas têm ação vencida; totais de abertas, sem próxima ação e com ação vencida. Use para perguntas como "quantas oportunidades estão na fase X e qual o valor total".',
  { produto: z.string().optional().describe('Slug do produto (ex.: icms, dcf).'),
    dono: z.string().optional().describe('Usuário do executivo dono.') },
  'funil/resumo/');

ferramenta(servidor, 'listar_oportunidades',
  'Lista oportunidades do Funil Comercial com filtros. Cada item traz empresa (nome, razão social, CNPJ), etapa, produto, valores, dono, SDR, próxima ação e datas.',
  { estagio: z.string().optional().describe('Slug da etapa (veja resumo_funil).'),
    produto: z.string().optional(), dono: z.string().optional(),
    empresa_id: z.number().int().optional(),
    q: z.string().optional().describe('Busca por nome da oportunidade, empresa ou CNPJ.'),
    abertas: z.enum(['1']).optional().describe('"1" = só em andamento.'),
    sem_proxima_acao: z.enum(['1']).optional().describe('"1" = abertas sem próxima ação (follow-up pendente).'),
    acao_vencida: z.enum(['1']).optional().describe('"1" = abertas com próxima ação vencida.'),
    criadas_desde: z.string().optional().describe('AAAA-MM-DD'),
    atualizadas_desde: z.string().optional().describe('AAAA-MM-DD'),
    ...paginacao },
  'oportunidades/');

ferramenta(servidor, 'ver_oportunidade',
  'Detalhe de uma oportunidade pelo id, com motivo de perda e reuniões comerciais.',
  { id: z.number().int() }, (a) => `oportunidades/${a.id}/`);

ferramenta(servidor, 'buscar_empresas',
  'Busca empresas (clientes e prospectos) por nome, razão social ou CNPJ (com ou sem pontuação). Traz cidade, UF, situação, dono e oportunidades abertas.',
  { q: z.string().optional(), situacao: z.string().optional().describe('prospecto, backlog, cliente...'), ...paginacao },
  'empresas/');

ferramenta(servidor, 'ver_empresa',
  'Ficha da empresa pelo id: dados fiscais, dono, oportunidades e últimas análises de reunião. Use no briefing antes de uma reunião.',
  { id: z.number().int() }, (a) => `empresas/${a.id}/`);

ferramenta(servidor, 'agenda_comercial',
  'Reuniões comerciais a partir de agora (padrão 24 horas, máximo 168), com empresa, executivo, link e confirmação.',
  { horas: z.number().int().min(1).max(168).optional(), executivo: z.string().optional().describe('Usuário do executivo.') },
  'agenda/');

ferramenta(servidor, 'analises_de_reuniao',
  'Análises de reunião (Read.ai): resumo, pontos fortes, pontos a melhorar, próximos passos, score e risco. Filtros por empresa ou título, executivo e período.',
  { q: z.string().optional(), executivo: z.string().optional(),
    desde: z.string().optional().describe('AAAA-MM-DD'), ate: z.string().optional().describe('AAAA-MM-DD'), ...paginacao },
  'reunioes/');

if (FINANCEIRO) {
  ferramenta(servidor, 'listar_faturas',
    'Faturas do Financeiro (só consulta): número, empresa, competência, estado, valores de cobrança e pagos, vencimento. Filtros: empresa_id, estado, vencidas="1", q.',
    { empresa_id: z.number().int().optional(), estado: z.string().optional(),
      vencidas: z.enum(['1']).optional(), q: z.string().optional(), ...paginacao },
    'financeiro/faturas/');
}

servidor.connect(new StdioServerTransport()).catch((erro) => {
  console.error('sistemala-mcp: falha ao iniciar', erro);
  process.exit(1);
});
