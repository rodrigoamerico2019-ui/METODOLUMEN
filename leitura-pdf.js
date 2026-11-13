// =========================================================
//  INSTITUTO AMÉRICO — Leitura semanal em PDF (PDFKit)
//  Material do terapeuta para a sessão: sinais da semana,
//  tarefas para o paciente e direcionamento. Confidencial.
// =========================================================
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'logo-instituto.png');
const OURO = '#B8912F', TINTA = '#1E1B16', FRACO = '#6B6355', LINHA = '#E0D8C6', FUNDO = '#FBF6E9', PETROLEO = '#0F3B45';
const COR = { verde: ['#2E7D4F', 'VERDE · estável'], amarelo: ['#C99A06', 'AMARELO · atenção'], vermelho: ['#B3261E', 'VERMELHO · prioridade'] };
const COMP = { tanto_faz: 'Tanto faz (acomodação)', cansei: 'Cansei (sofre, mas ainda não decidiu mudar)', insuportavel: 'Insuportável (quer mudar)' };
const AREA = { corpo: 'Corpo', alma: 'Alma', espirito: 'Espírito' };
const M = 50;
// tira emojis e caracteres fora da fonte padrão do PDF
const t = v => String(v == null ? '' : v).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').trim();
const arr = v => Array.isArray(v) ? v.filter(x => x != null && x !== '') : [];

export function buildLeituraPdf({ paciente, terapeuta, clinica, periodo, gerada, motivo, c }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: M, bottom: M + 30, left: M, right: M },
      info: { Title: 'Leitura semanal — ' + t(paciente), Author: t(clinica) || 'Instituto Américo' } });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
    const L = doc.page.width - M * 2;
    const fimUtil = () => doc.page.height - M - 40;
    const garante = h => { if (doc.y + h > fimUtil()) doc.addPage(); };

    // ---- cabeçalho ----
    let tx = M;
    try { if (fs.existsSync(LOGO)) { doc.image(LOGO, M, M - 6, { width: 64, height: 64 }); tx = M + 78; } } catch (_) {}
    doc.fillColor(OURO).font('Helvetica-Bold').fontSize(9).text('LEITURA SEMANAL · MATERIAL PARA A SESSÃO', tx, M, { characterSpacing: 1.2 });
    doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(19).text(t(paciente), tx, M + 14, { width: L - (tx - M) });
    doc.fillColor(FRACO).font('Helvetica').fontSize(9.5)
      .text([t(clinica), terapeuta ? 'Terapeuta: ' + t(terapeuta) : ''].filter(Boolean).join(' · '), tx, doc.y + 2, { width: L - (tx - M) })
      .text('Período: ' + t(periodo) + ' · gerada ' + t(gerada) + (motivo ? ' (' + t(motivo) + ')' : ''), { width: L - (tx - M) });
    doc.y = Math.max(doc.y, M + 64) + 12;

    // ---- faixa de situação ----
    const cor = COR[c.classificacao];
    const at = c.atividade || {};
    const fy = doc.y;
    doc.roundedRect(M, fy, L, 54, 8).fillAndStroke(FUNDO, LINHA);
    if (cor) { doc.circle(M + 20, fy + 18, 7).fill(cor[0]); }
    doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(11).text(cor ? cor[1] : 'Sem classificação', M + 34, fy + 12, { width: L / 2 });
    doc.font('Helvetica').fontSize(9.5).fillColor(FRACO)
      .text('Risco: ' + t(c.risco || 'nenhum') + (c.comprometimento && COMP[c.comprometimento] ? '   ·   Comprometimento: ' + COMP[c.comprometimento] : ''), M + 34, fy + 29, { width: L - 48 });
    doc.text('Na semana: ' + (at.falas || 0) + ' falas · ' + (at.relatorios || 0) + ' relatórios do dia · ' + (at.checkins || 0) + ' check-ins · perguntas do dia ' + (at.perguntas_respondidas || 0) + '/' + (at.perguntas || 0),
      M + 34, fy + 41, { width: L - 48 });
    doc.y = fy + 68;

    const titulo = s => {
      garante(46);
      doc.moveDown(0.6);
      doc.fillColor(PETROLEO).font('Helvetica-Bold').fontSize(12.5).text(s.toUpperCase(), M, doc.y, { characterSpacing: 0.6 });
      const y = doc.y + 3; doc.moveTo(M, y).lineTo(M + 46, y).strokeColor(OURO).lineWidth(1.6).stroke();
      doc.y = y + 7;
    };
    const par = (s, o = {}) => { if (!t(s)) return; garante(o.font === 'Helvetica-Bold' ? 52 : 28); doc.fillColor(o.cor || TINTA).font(o.font || 'Helvetica').fontSize(o.size || 10.5).text(t(s), M + (o.ind || 0), doc.y, { width: L - (o.ind || 0), lineGap: 2.5 }); doc.moveDown(o.gap == null ? 0.35 : o.gap); };
    const bullets = (lista, fmt) => arr(lista).forEach(x => {
      garante(24);
      const y = doc.y; doc.circle(M + 4, y + 6, 2).fill(OURO);
      doc.fillColor(TINTA).font('Helvetica').fontSize(10.5);
      fmt ? fmt(x) : doc.text(t(x), M + 14, y, { width: L - 14, lineGap: 2.5 });
      doc.moveDown(0.3);
    });
    const citacoes = lista => { const q = arr(lista).map(t).filter(Boolean); if (q.length) par(q.map(x => '“' + x + '”').join('   '), { font: 'Helvetica-Oblique', cor: FRACO, size: 9.5, ind: 14 }); };

    // ---- 1. visão geral ----
    titulo('1. Visão geral da semana');
    par(c.resumo);
    if (t(c.como_chega)) { par('Como deve chegar à sessão', { font: 'Helvetica-Bold', gap: 0.1 }); par(c.como_chega); }
    if (t(c.evolucao)) { par('Evolução em relação à semana anterior', { font: 'Helvetica-Bold', gap: 0.1 }); par(c.evolucao); }

    // ---- 2. dores, sentimentos, feridas ----
    if (arr(c.dores).length) {
      titulo('2. Dores que apareceram');
      bullets(c.dores, d => { doc.font('Helvetica-Bold').text(t(d.tema), M + 14, doc.y, { width: L - 14, continued: !!t(d.descricao) });
        if (t(d.descricao)) doc.font('Helvetica').text(': ' + t(d.descricao)); citacoes(d.citacoes); });
    }
    if (arr(c.sentimentos).length) {
      titulo('3. Sentimentos predominantes');
      par(arr(c.sentimentos).map(s => t(s.nome) + (s.vezes ? ' (' + s.vezes + 'x)' : '')).join('  ·  '));
    }
    if (arr(c.feridas_traumas).length) {
      titulo('4. Feridas e traumas em evidência');
      bullets(c.feridas_traumas, f => { doc.font('Helvetica-Bold').text(t(f.tema), M + 14, doc.y, { width: L - 14, continued: !!t(f.evidencia) });
        if (t(f.evidencia)) doc.font('Helvetica').text(': ' + t(f.evidencia)); if (t(f.citacao)) citacoes([f.citacao]); });
    }
    if (arr(c.padroes_crencas).length) { titulo('5. Padrões e crenças'); bullets(c.padroes_crencas); }
    if (arr(c.vitorias).length) { titulo('6. Vitórias da semana'); bullets(c.vitorias); }

    // ---- direcionamento ----
    const dir = c.direcionamento || {};
    titulo('7. Direcionamento para a sessão');
    if (t(dir.foco_sessao)) { par('Foco principal', { font: 'Helvetica-Bold', gap: 0.1 }); par(dir.foco_sessao); }
    if (t(dir.objetivo)) { par('Objetivo terapêutico', { font: 'Helvetica-Bold', gap: 0.1 }); par(dir.objetivo); }
    if (arr(dir.passos).length) {
      par('Roteiro sugerido', { font: 'Helvetica-Bold', gap: 0.2 });
      arr(dir.passos).forEach((p, i) => { garante(24); const y = doc.y;
        doc.fillColor(OURO).font('Helvetica-Bold').fontSize(10.5).text((i + 1) + '.', M + 2, y, { width: 14 });
        doc.fillColor(TINTA).font('Helvetica').text(t(p), M + 18, y, { width: L - 18, lineGap: 2.5 }); doc.moveDown(0.3); });
    }
    if (arr(c.perguntas_sessao).length) { par('Perguntas para fazer', { font: 'Helvetica-Bold', gap: 0.2 }); bullets(c.perguntas_sessao); }
    if (arr(c.intervencoes).length) { par('Caminhos do Método Lúmen', { font: 'Helvetica-Bold', gap: 0.2 }); bullets(c.intervencoes); }
    if (arr(dir.evitar).length) { par('Cuidado: evitar nesta fase', { font: 'Helvetica-Bold', gap: 0.2 }); bullets(dir.evitar); }
    if (t(c.base_biblica)) { par('Base bíblica', { font: 'Helvetica-Bold', gap: 0.1 }); par(c.base_biblica, { font: 'Helvetica-Oblique' }); }
    if (t(dir.proximas_semanas)) { par('Próximas semanas', { font: 'Helvetica-Bold', gap: 0.1 }); par(dir.proximas_semanas); }

    // ---- tarefas ----
    const tarefas = arr(c.tarefas_semana);
    if (tarefas.length) {
      titulo('8. Tarefas indicadas para o paciente nesta semana');
      par('Combine com o paciente na sessão. Cada tarefa é pequena, concreta e ligada ao que ele trouxe.', { cor: FRACO, size: 9.5 });
      tarefas.forEach((x, i) => {
        garante(64);
        const y = doc.y;
        doc.rect(M, y + 1, 10, 10).strokeColor(OURO).lineWidth(1.1).stroke();
        doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(10.5).text((i + 1) + '. ' + t(x.titulo) + (AREA[x.area] ? '  ·  ' + AREA[x.area] : ''), M + 18, y, { width: L - 18 });
        if (t(x.como)) doc.font('Helvetica').fontSize(10).fillColor(TINTA).text('Como: ' + t(x.como), M + 18, doc.y + 1, { width: L - 18, lineGap: 2 });
        if (t(x.frequencia)) doc.font('Helvetica').fontSize(10).fillColor(TINTA).text('Quando: ' + t(x.frequencia), M + 18, doc.y + 1, { width: L - 18, lineGap: 2 });
        if (t(x.por_que)) doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(FRACO).text('Por quê: ' + t(x.por_que), M + 18, doc.y + 1, { width: L - 18, lineGap: 2 });
        doc.moveDown(0.6);
      });
    }

    // ---- atenção e lacunas ----
    if (arr(c.atencao).length) { titulo('9. Pontos de atenção'); bullets(c.atencao); }
    if (arr(c.lacunas).length) { titulo('10. Ainda não explorado'); par('Estes temas viram as perguntas do dia da Lúmen na próxima semana.', { cor: FRACO, size: 9.5 }); bullets(c.lacunas); }


    // ---- rodapé em todas as páginas ----
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;   // escreve o rodapé sem abrir página nova
      const y = doc.page.height - M - 2;
      doc.moveTo(M, y - 6).lineTo(M + L, y - 6).strokeColor(LINHA).lineWidth(0.6).stroke();
      doc.fillColor(FRACO).font('Helvetica').fontSize(7.5)
        .text('CONFIDENCIAL · uso exclusivo do terapeuta · ' + t(clinica || 'Instituto Américo') + ' · ' + t(paciente), M, y, { width: L * 0.8, lineBreak: false });
      doc.text('página ' + (i + 1) + ' de ' + range.count, M + L * 0.8, y, { width: L * 0.2, align: 'right', lineBreak: false });
      doc.font('Helvetica-Oblique').fontSize(7).text('Sinais e hipóteses organizados por IA a partir do que o paciente registrou no app. Não é diagnóstico: a avaliação clínica é do profissional responsável.', M, y + 11, { width: L, lineBreak: false });
    }
    doc.end();
  });
}
