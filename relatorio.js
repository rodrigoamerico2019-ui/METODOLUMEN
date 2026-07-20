// =========================================================
//  TRILÚMEN — geração de relatórios em PDF (PDFKit)
//  Leve de propósito: sem Chromium, roda em servidor pequeno.
//  Dois tipos, e a diferença é de PRIVACIDADE:
//    'cliente' → só o que já foi compartilhado (nunca o prontuário)
//    'clinico' → documento interno da equipe
// =========================================================
import PDFDocument from 'pdfkit';

const OURO = '#B8912F', TINTA = '#1E1B16', FRACO = '#6B6355', LINHA = '#E0D8C6', VERDE = '#6E9455';
const M = 56;                       // margem
const dt = d => d ? new Date(d).toLocaleDateString('pt-BR') : '';
const dtHora = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const txt = v => String(v == null ? '' : v).trim();

export function buildReportPdf(d, docUid) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M + 26, left: M, right: M }, bufferPages: true,
      info: { Title: 'Relatório de acompanhamento', Author: d.clinica || 'TriLumen' } });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    const L = doc.page.width - M * 2;
    const nome = (d.cliente && d.cliente.basico && d.cliente.basico.name) || 'Cliente';
    const det = (d.cliente && d.cliente.detalhes) || {};
    const bas = (d.cliente && d.cliente.basico) || {};
    const clinico = d.tipo === 'clinico';

    // ---------- helpers de layout ----------
    const espaco = (n = 10) => doc.moveDown(n / 12);
    const quebraSePreciso = (alturaNecessaria = 80) => {
      if (doc.y + alturaNecessaria > doc.page.height - M - 26) doc.addPage();
    };
    const titulo = t => {
      quebraSePreciso(64);
      doc.moveDown(0.7);
      doc.fillColor(OURO).font('Helvetica-Bold').fontSize(8.5).text(t.toUpperCase(), { characterSpacing: 1.3 });
      doc.moveTo(M, doc.y + 3).lineTo(M + L, doc.y + 3).strokeColor(LINHA).lineWidth(1).stroke();
      doc.moveDown(0.65);
    };
    const paragrafo = (t, o = {}) => {
      if (!txt(t)) return;
      doc.fillColor(o.cor || TINTA).font(o.negrito ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.tam || 10)
        .text(txt(t), { width: L, align: o.align || 'left', lineGap: o.lineGap != null ? o.lineGap : 2.5 });
    };
    const rotuloValor = (rot, val) => {
      if (!txt(val)) return;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(FRACO).text(rot.toUpperCase() + '  ', { continued: true, characterSpacing: .6 });
      doc.font('Helvetica').fontSize(10).fillColor(TINTA).text(txt(val));
      doc.moveDown(0.25);
    };
    const vazio = t => { doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(FRACO).text(t, { width: L }); doc.moveDown(0.3); };

    // ---------- capa / cabeçalho ----------
    doc.fillColor(OURO).font('Helvetica-Bold').fontSize(19).text(d.clinica || 'TriLumen', { width: L });
    doc.fillColor(FRACO).font('Helvetica').fontSize(8.5)
      .text(clinico ? 'RELATÓRIO CLÍNICO · DOCUMENTO INTERNO' : 'RELATÓRIO DE ACOMPANHAMENTO', { characterSpacing: 1.2 });
    doc.moveTo(M, doc.y + 8).lineTo(M + L, doc.y + 8).strokeColor(OURO).lineWidth(2).stroke();
    doc.moveDown(1.4);

    doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(17).text(nome, { width: L });
    const per = d.periodo && (d.periodo.inicio || d.periodo.fim)
      ? 'Período: ' + (d.periodo.inicio ? dt(d.periodo.inicio) : 'início') + ' a ' + (d.periodo.fim ? dt(d.periodo.fim) : 'hoje')
      : 'Período: todo o acompanhamento';
    doc.fillColor(FRACO).font('Helvetica').fontSize(9.5).text(per);
    doc.moveDown(1.1);

    // identificação
    titulo('Identificação');
    rotuloValor('Código', det.codigo);
    rotuloValor('Nascimento', bas.birth_date ? dt(bas.birth_date) + (bas.idade != null ? `  (${bas.idade} anos)` : '') : '');
    rotuloValor('Acompanhamento', det.tipo_acompanhamento);
    rotuloValor('Situação', det.status);
    const profs = (d.cliente && d.cliente.profissionais || []).map(p => p.name + (p.principal ? ' (principal)' : '')).join(', ');
    rotuloValor('Profissional', profs);

    // ---------- evolução / escalas ----------
    if ((d.escalas || []).length) {
      titulo('Escalas de acompanhamento');
      d.escalas.forEach(e => {
        const pct = e.max ? Math.round((Number(e.score) / Number(e.max)) * 100) : Number(e.score);
        const y = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(TINTA).text(String(e.scale_key || '').replace(/_/g, ' '), M, y, { width: L - 150 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(OURO).text(String(e.score) + (e.max ? ' / ' + e.max : ''), M + L - 150, y, { width: 70, align: 'right' });
        doc.font('Helvetica').fontSize(8.5).fillColor(FRACO).text(dt(e.created_at), M + L - 72, y + 1, { width: 72, align: 'right' });
        // barrinha
        const by = doc.y + 2, larg = L, prog = Math.max(0, Math.min(100, pct || 0));
        doc.roundedRect(M, by, larg, 3, 1.5).fillColor(LINHA).fill();
        doc.roundedRect(M, by, larg * prog / 100, 3, 1.5).fillColor(OURO).fill();
        doc.y = by + 11;
      });
    }

    if ((d.emocional || []).length) {
      titulo('Perfil emocional (autoavaliacoes de 0 a 10)');
      const ult = d.emocional[0], prim = d.emocional[d.emocional.length - 1];
      const esc = ult.escalas || {};
      const chaves = Object.keys(esc);
      if (!chaves.length) vazio('Sem escalas registradas.');
      chaves.forEach(k => {
        const atual = esc[k], antes = (prim.escalas || {})[k];
        const delta = (antes != null && d.emocional.length > 1) ? (Number(atual) - Number(antes)) : null;
        const y = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(TINTA).text(k.replace(/_/g, ' '), M, y, { width: L - 120 });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(TINTA).text(String(atual), M + L - 120, y, { width: 40, align: 'right' });
        if (delta !== null && delta !== 0) {
          // sem setas unicode: a fonte padrão do PDF não as tem (viram lixo)
          doc.font('Helvetica-Bold').fontSize(9).fillColor(delta > 0 ? VERDE : '#C86B6B')
            .text((delta > 0 ? '+' : '') + delta, M + L - 76, y + 1, { width: 76, align: 'right' });
        }
        doc.y = y + 15;
      });
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(FRACO)
        .text('Variação comparada à primeira avaliação (' + dt(prim.created_at) + ').', { width: L });
    }

    // ---------- objetivos ----------
    titulo('Objetivos');
    const objs = d.objetivos || [];
    if (!objs.length) vazio('Nenhum objetivo registrado no período.');
    objs.forEach(g => {
      quebraSePreciso(60);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(TINTA).text(txt(g.titulo), { width: L });
      const meta = [g.categoria, g.prioridade ? 'prioridade ' + g.prioridade : '', g.prazo ? 'prazo ' + dt(g.prazo) : ''].filter(Boolean).join(' · ');
      if (meta) doc.font('Helvetica').fontSize(8.5).fillColor(FRACO).text(meta, { width: L });
      if (txt(g.descricao)) doc.font('Helvetica').fontSize(9.5).fillColor(TINTA).text(txt(g.descricao), { width: L, lineGap: 2 });
      const prog = Math.max(0, Math.min(100, Number(g.progresso) || 0));
      const by = doc.y + 4;
      doc.roundedRect(M, by, L - 46, 4, 2).fillColor(LINHA).fill();
      doc.roundedRect(M, by, (L - 46) * prog / 100, 4, 2).fillColor(prog >= 100 ? VERDE : OURO).fill();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(FRACO).text(prog + '%', M + L - 40, by - 3, { width: 40, align: 'right' });
      doc.y = by + 14;
    });

    // ---------- sessões ----------
    titulo(clinico ? 'Sessões e prontuário' : 'Resumos das sessões');
    const ss = d.sessoes || [];
    if (!ss.length) vazio(clinico ? 'Nenhuma sessão no período.' : 'Nenhum resumo foi compartilhado no período.');
    ss.forEach(s => {
      quebraSePreciso(90);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(OURO).text(dtHora(s.quando), { width: L });
      const meta = [s.tipo, s.modalidade, s.profissional, s.duracao_min ? s.duracao_min + ' min' : ''].filter(Boolean).join(' · ');
      if (meta) doc.font('Helvetica').fontSize(8.5).fillColor(FRACO).text(meta, { width: L });
      doc.moveDown(0.25);
      if (clinico) {
        const campos = [['Demanda', s.demanda], ['Temas', s.temas], ['Intervenções', s.intervencoes],
          ['Evolução', s.evolucao], ['Condutas', s.condutas], ['Encaminhamentos', s.encaminhamentos], ['Próximos passos', s.proximos_passos]];
        let algum = false;
        campos.forEach(([r, v]) => { if (txt(v)) { algum = true; rotuloValor(r, v); } });
        if (txt(s.resumo)) { doc.moveDown(0.1); rotuloValor(s.compartilhado ? 'Resumo (compartilhado)' : 'Resumo (não compartilhado)', s.resumo); }
        if (!algum && !txt(s.resumo)) vazio('Sessão sem prontuário preenchido.');
      } else {
        paragrafo(s.resumo, { tam: 10 });
      }
      doc.moveDown(0.55);
    });

    // ---------- tarefas ----------
    titulo('Tarefas combinadas');
    const tks = d.tarefas || [];
    if (!tks.length) vazio('Nenhuma tarefa registrada.');
    tks.forEach(t => {
      quebraSePreciso(40);
      const feito = t.status === 'concluida';
      const y = doc.y;
      doc.roundedRect(M, y + 1.5, 9, 9, 2).lineWidth(1).strokeColor(feito ? VERDE : LINHA).stroke();
      // o "check" é desenhado em vetor (a fonte padrão do PDF não tem o glifo ✓)
      if (feito) {
        doc.save().lineWidth(1.4).strokeColor(VERDE)
          .moveTo(M + 2.2, y + 6).lineTo(M + 4, y + 8).lineTo(M + 7, y + 3.4).stroke().restore();
      }
      doc.font('Helvetica').fontSize(10).fillColor(feito ? FRACO : TINTA).text(txt(t.titulo), M + 16, y, { width: L - 90 });
      const dir = [t.prazo ? dt(t.prazo) : '', clinico && !t.compartilhada ? 'privada' : ''].filter(Boolean).join(' · ');
      if (dir) doc.font('Helvetica').fontSize(8.5).fillColor(FRACO).text(dir, M + L - 74, y + 1, { width: 74, align: 'right' });
      if (txt(t.descricao)) doc.font('Helvetica').fontSize(9).fillColor(FRACO).text(txt(t.descricao), M + 16, doc.y, { width: L - 30, lineGap: 1.5 });
      doc.moveDown(0.45);
    });

    // ---------- só no clínico: saúde e medicamentos ----------
    if (clinico) {
      const meds = d.medicamentos || [];
      if (meds.length) {
        titulo('Medicamentos em uso (informado pelo cliente)');
        meds.forEach(m => {
          quebraSePreciso(34);
          const y = doc.y;
          doc.font('Helvetica-Bold').fontSize(10).fillColor(TINTA)
            .text(txt(m.nome) + (txt(m.dosagem) ? ' ' + txt(m.dosagem) + ' ' + txt(m.unidade) : ''), M, y, { width: L - 80 });
          doc.font('Helvetica').fontSize(8.5).fillColor(m.status === 'suspenso' ? '#C86B6B' : VERDE)
            .text(m.status === 'suspenso' ? 'suspenso' : 'em uso', M + L - 80, y + 1, { width: 80, align: 'right' });
          const sub = [m.frequencia, m.prescrito_por, m.motivo].filter(Boolean).join(' · ');
          if (sub) doc.font('Helvetica').fontSize(8.5).fillColor(FRACO).text(sub, M, doc.y, { width: L });
          doc.moveDown(0.4);
        });
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(FRACO)
          .text('Registro informativo. O sistema não prescreve, não recomenda e não altera doses.', { width: L });
      }
      const saude = (d.saude && d.saude.dados) || null;
      if (saude && Object.keys(saude).length) {
        titulo('Saúde (resumo)');
        const mapa = { condicoes: 'Condições', alergias: 'Alergias', sono_qualidade: 'Sono (0 a 10)', sono_horas: 'Horas de sono',
          atividade_fisica: 'Atividade física', alimentacao: 'Alimentação', acomp_medico: 'Acompanhamento médico', medico_nome: 'Médico' };
        let algum = false;
        Object.keys(mapa).forEach(k => {
          let v = saude[k]; if (v === true) v = 'sim'; if (v === false) v = 'não';
          if (txt(v)) { algum = true; rotuloValor(mapa[k], v); }
        });
        if (!algum) vazio('Sem dados de saúde preenchidos.');
      }
    }

    // ---------- rodapé em todas as páginas ----------
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const yR = doc.page.height - M - 6;
      doc.moveTo(M, yR - 12).lineTo(M + L, yR - 12).strokeColor(LINHA).lineWidth(0.8).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(FRACO);
      doc.text(`${d.clinica || 'TriLumen'} · ${docUid || ''} · emitido em ${dtHora(d.gerado_em)}`, M, yR - 6, { width: L - 60, lineBreak: false });
      doc.text(`${i + 1}/${range.count}`, M + L - 60, yR - 6, { width: 60, align: 'right', lineBreak: false });
      if (clinico) {
        doc.fillColor('#C86B6B').font('Helvetica-Bold').fontSize(7)
          .text('DOCUMENTO CLÍNICO · USO INTERNO · NÃO ENTREGAR AO CLIENTE', M, yR + 3, { width: L, align: 'center', lineBreak: false });
      } else {
        doc.fillColor(FRACO).font('Helvetica-Oblique').fontSize(7)
          .text('Este relatório não substitui avaliação ou laudo profissional.', M, yR + 3, { width: L, align: 'center', lineBreak: false });
      }
    }

    doc.end();
  });
}
