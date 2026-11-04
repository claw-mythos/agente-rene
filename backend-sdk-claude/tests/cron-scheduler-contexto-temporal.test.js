// Contexto temporal injetado nas tarefas do cron (03/11/2026): a rotina diária das 9h
// saudava o Lucas com "Boa noite ... Domingo" numa terça de manhã porque o prompt não
// dizia que dia nem que horas eram.
const { contextoTemporal, montarPrompt } = require('../services/tasks/cron-scheduler');

describe('contextoTemporal', () => {
  test('9h de terça-feira em Brasília: manhã, bom dia', () => {
    const txt = contextoTemporal(new Date('2026-11-03T12:00:00Z'), 'America/Sao_Paulo');
    expect(txt).toContain('terça-feira, 03/11/2026, 09:00');
    expect(txt).toContain('período da manhã (saudação: bom dia)');
    expect(txt).toContain('não deduza a data');
  });

  test('19h30 vira noite e meia-noite não sai como 24h', () => {
    expect(contextoTemporal(new Date('2026-11-03T22:30:00Z'), 'America/Sao_Paulo')).toContain('19:30 no horário de Brasília — período da noite');
    expect(contextoTemporal(new Date('2026-11-04T03:00:00Z'), 'America/Sao_Paulo')).toContain('quarta-feira, 04/11/2026, 00:00');
  });

  test('14h é tarde', () => {
    expect(contextoTemporal(new Date('2026-11-03T17:00:00Z'), 'America/Sao_Paulo')).toContain('período da tarde (saudação: boa tarde)');
  });
});

describe('montarPrompt', () => {
  const agora = new Date('2026-11-03T12:00:00Z');

  test('prompt comum recebe o contexto antes', () => {
    const p = montarPrompt('Componha a mensagem.', agora);
    expect(p.startsWith('[Contexto temporal] Agora é terça-feira')).toBe(true);
    expect(p.endsWith('Componha a mensagem.')).toBe(true);
  });

  test('comando de skill mantém a barra no início', () => {
    const p = montarPrompt('/acerto-socios', agora);
    expect(p.startsWith('/acerto-socios')).toBe(true);
    expect(p).toContain('[Contexto temporal]');
  });
});
