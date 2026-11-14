// whatsapp-sender.js — envio de WhatsApp usado pelas automações agendadas
// (briefing pré-reunião, relatório semanal, lembrete de follow-up).
//
// Histórico: antes chamava POST /api/whatsapp/say deste próprio backend
// (hermes-mythos-lucas, porta 8080), que depende do socket Baileys próprio
// em data/whatsapp-auth/. Essa sessão foi deslogada em 2026-11-03 (code=401)
// e não é mais a conexão de produção — o número real hoje é o do
// hermes-gateway (uazapi-bridge). Resultado: todo envio falhava com
// "canal WhatsApp ainda não conectado" (incidente TARS
// 2026-11-09-1030-rene_envios_backend).
//
// Conserto (09/11/2026, TARS): enviar via `hermes send` (hermes-gateway),
// o mesmo caminho já usado por data/hooks/rotina-lucas.js. Sem LLM, sem
// agent loop — só reaproveita as credenciais do gateway já configurado.
//
// Backup do arquivo anterior: whatsapp-sender.js.bak-20261109-tars.
//
// Conserto (13/11/2026, TARS, incidente 2026-11-13-1601): o POST /send da
// ponte uazapi-bridge (/home/hermes/uazapi-bridge/bridge.js) tem timeout de
// 30s contra a API do uazapi; de vez em quando (26/10, 12/11, 13/11) essa
// chamada estoura o timeout ("The operation was aborted due to timeout") e
// o `hermes send` sai com código 1 sem reenviar. A conexão em si estava
// normal (testei na hora: hermes send direto funcionou). Para não perder o
// briefing por um soluço passageiro, _send agora tenta de novo uma vez
// depois de 3s antes de desistir.
//
// Backup do arquivo anterior: whatsapp-sender.js.bak-20261113-tars.

const { spawn } = require('child_process');

const HERMES_BIN = process.env.HERMES_SEND_BIN || '/home/hermes/.local/bin/hermes';

function _sendOnce(jid, text) {
  return new Promise((resolve, reject) => {
    const target = `whatsapp:${jid}`;
    const proc = spawn(HERMES_BIN, ['send', '--to', target, '--file', '-', '--quiet'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(stderr.trim() || `hermes send saiu com código ${code}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

async function send(jid, text) {
  try {
    return await _sendOnce(jid, text);
  } catch (e) {
    // Uma tentativa extra: a maioria das falhas observadas é timeout
    // passageiro do POST /send na ponte uazapi, não desconexão real.
    await new Promise((r) => setTimeout(r, 3000));
    return _sendOnce(jid, text);
  }
}

async function sendChunked(jid, messages, delayMs = 1500) {
  for (let i = 0; i < messages.length; i++) {
    await send(jid, messages[i]);
    if (i < messages.length - 1 && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

module.exports = { send, sendChunked };
