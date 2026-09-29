---
name: registrar-fechamento-crm
description: Detecta quando um contrato foi fechado numa conversa de grupo do WhatsApp e, com confirmação explícita, registra documentos/informações no card do cliente no Twenty CRM. Use quando perceber sinais de fechamento de contrato num grupo (linguagem tipo "fechado", "vamos assinar", confirmação de valores) ou quando alguém digitar explicitamente "/fechei-contrato".
---

> **PAUSADA desde 29/09/2026.** O CRM passou a ser o SistemaLA e o René só consulta (decisão do Julio). Não grave nada: se detectar um fechamento, avise no grupo que o registro deve ser feito no SistemaLA (lucroativo.online) e, se ajudar, traga os dados da oportunidade com a ferramenta sistemala.


# Registrar fechamento de contrato no CRM (grupo)

Este skill só roda no perfil de grupo (`crm-grupo`, MCP completo do Twenty). Objetivo:
observar a conversa do grupo e, quando o contrato fechar, registrar isso no card do
cliente certo no Twenty CRM — **sempre com confirmação humana antes de gravar**, nunca
direto, pra evitar falso positivo.

## Quando ativar

- Sinais heurísticos na conversa: linguagem de fechamento ("fechado", "vamos assinar",
  "combinado então", confirmação explícita de valor/proposta aceita).
- Atalho explícito: alguém digita `/fechei-contrato` no grupo — pula direto pro Passo 2
  (confirmação), sem precisar da heurística.

## Passo 1 — Identificar o cliente e o contexto

Antes de perguntar qualquer coisa, releia o histórico recente do grupo e monte um
resumo do que foi negociado: nome do cliente/empresa, o que foi fechado, valores
mencionados (se apareceram na própria conversa — não inventar), documentos anexados
no chat até agora.

## Passo 2 — Confirmar com o grupo antes de gravar

**Nunca grave sem essa confirmação.** Pergunte no grupo algo como:

> "Entendi que o contrato com **<cliente>** foi fechado — confirma que registro isso
> no CRM? Vou anexar/atualizar: <resumo do que pretende gravar>."

Só prossiga pro Passo 3 se a resposta for uma confirmação clara (ex: "sim", "confirma",
"pode", "isso mesmo"). Se a resposta for ambígua ou negativa, não grave nada — pergunte
de novo ou desista, conforme o caso.

## Passo 3 — Localizar o registro certo no Twenty

Use as tools do MCP `twenty` pra achar o card do cliente:
- `find_many_people` / `find_many_companies` pra localizar a pessoa/empresa pelo nome
  mencionado na conversa.
- `find_many_opportunities` (objeto `opportunities`) pra achar a oportunidade em
  andamento ligada a essa pessoa/empresa, se existir.

Se não encontrar nada com esse nome, **pare e pergunte** no grupo em vez de criar um
registro novo às cegas (nome pode estar escrito diferente do CRM).

## Passo 4 — Registrar

Só depois da confirmação do Passo 2 e da localização do Passo 3:

1. Atualizar a oportunidade (`opportunities`) — mudar o estágio pra fechado/ganho,
   conforme o pipeline do workspace.
2. Registrar uma nota (`notes`) resumindo o fechamento — data, o que foi combinado,
   quem confirmou no grupo.
3. Se houve documento/anexo trocado no chat, registrar em `attachments` (ou
   `documentos_clientes`/`contratos`, conforme o tipo de arquivo) ligado ao
   `people`/`companies` certo.
4. Se relevante, registrar as partes envolvidas em `document_parties` e qualquer
   pendência de assinatura/documento em `document_requests`.

Objetos permitidos nesta skill: `opportunities`, `companies`, `people`,
`documentos_clientes`, `attachments`, `notes`, `contratos`, `document_parties`,
`document_requests`. Não mexer em objetos financeiros
(`comissoes`, `movimentacoes_financeiras`, `pagamentos`, `faturas`, etc.) — isso é
fora do escopo desta skill, mesmo que a oportunidade tenha valor associado.

## Passo 5 — Confirmar pro grupo

Depois de gravar, responda confirmando o que foi feito (ex: "Registrado! Oportunidade
atualizada pra Fechado/Ganho, nota adicionada, documento anexado no card da
<empresa>.").

## Cuidado

- Sem confirmação explícita do Passo 2, não grave nada — falso positivo aqui é pior
  que perguntar demais.
- Se o cliente não for encontrado no CRM, não crie um registro novo sozinho — confirme
  com o grupo antes.
- Não misture essa skill com dado financeiro/comissão — isso fica fora do card de
  fechamento, é responsabilidade de outro fluxo.
