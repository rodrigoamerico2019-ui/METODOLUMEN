// =========================================================
//  TRILÚMEN — recibo de pagamento em PDF (PDFKit)
//  Prova de pagamento p/ o paciente (reembolso) e p/ o
//  terapeuta (carnê-leão). Leve, sem Chromium.
// =========================================================
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const LOGO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'logo-instituto.png');
const cpfFmt = c => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d; };
const dtCurto = d => d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';

const OURO = '#B8912F', TINTA = '#1E1B16', FRACO = '#6B6355', LINHA = '#E0D8C6';
const M = 56;
const txt = v => String(v == null ? '' : v).trim();
const dtLongo = d => d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }) : '';

// valor por extenso (reais e centavos) — suficiente p/ recibos
function valorExtenso(valor) {
  const cents = Math.round(Number(valor || 0) * 100);
  const reais = Math.floor(cents / 100), centavos = cents % 100;
  const u = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
  const dez = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
  const cem = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
  const tres = n => {
    if (n === 0) return '';
    if (n === 100) return 'cem';
    const c = Math.floor(n / 100), r = n % 100; let s = '';
    if (c) s += cem[c];
    if (r) {
      if (s) s += ' e ';
      if (r < 20) s += u[r];
      else { const d = Math.floor(r / 10), un = r % 10; s += dez[d] + (un ? ' e ' + u[un] : ''); }
    }
    return s;
  };
  const ext = n => {
    if (n === 0) return 'zero';
    const mi = Math.floor(n / 1000000), mil = Math.floor((n % 1000000) / 1000), c = n % 1000;
    const p = [];
    if (mi) p.push(tres(mi) + (mi === 1 ? ' milhão' : ' milhões'));
    if (mil) p.push(mil === 1 ? 'mil' : tres(mil) + ' mil');
    if (c) p.push(tres(c));
    return p.join(' e ');
  };
  let s = ext(reais) + ' ' + (reais === 1 ? 'real' : 'reais');
  if (centavos) s += ' e ' + ext(centavos) + ' ' + (centavos === 1 ? 'centavo' : 'centavos');
  return s;
}

const moeda = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

export function buildReciboPdf(d) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M, left: M, right: M },
      info: { Title: 'Recibo ' + (d.numero || ''), Author: d.emitente?.nome || 'TriLumen' } });
    const bufs = [];
    doc.on('data', b => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);
    const L = doc.page.width - M * 2;

    // ---- cabeçalho: logo do Instituto Américo + emitente (marca) + nº ----
    const LG = 72; let tx = M;
    try { if (fs.existsSync(LOGO)) { doc.image(LOGO, M, M - 8, { width: LG, height: LG }); tx = M + LG + 14; } } catch (_) {}
    doc.fillColor(OURO).font('Helvetica-Bold').fontSize(18).text(txt(d.emitente?.nome) || 'TriLumen', tx, M + 8, { width: L * 0.7 - (tx - M) });
    if (txt(d.emitente?.subtitulo)) doc.fillColor(FRACO).font('Helvetica').fontSize(9.5).text(txt(d.emitente.subtitulo), { width: L * 0.7 - (tx - M) });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(TINTA).text('RECIBO', M + L * 0.7, M, { width: L * 0.3, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(FRACO).text('Nº ' + (d.numero || ''), { width: L * 0.3, align: 'right' });

    // ---- caixa do valor ----
    const boxY = M + 84;
    doc.roundedRect(M, boxY, L, 46, 8).fillAndStroke('#FBF6E9', LINHA);
    doc.fillColor(FRACO).font('Helvetica').fontSize(8.5).text('VALOR', M + 16, boxY + 9, { characterSpacing: 1.5 });
    doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(22).text(moeda(d.valor), M + 12, boxY + 18, { width: L - 24 });

    // ---- corpo ----
    let y = boxY + 74;
    doc.fillColor(TINTA).font('Helvetica').fontSize(12).lineGap(4);
    doc.text('Recebi de ', M, y, { continued: true }).font('Helvetica-Bold').text(txt(d.pagador?.nome) || '—', { continued: true })
      .font('Helvetica').text(' a importância de ', { continued: true })
      .font('Helvetica-Bold').text(valorExtenso(d.valor), { continued: true })
      .font('Helvetica').text(' (' + moeda(d.valor) + '),');
    doc.moveDown(0.5);
    doc.font('Helvetica').text('referente a ', { continued: true }).font('Helvetica-Bold').text(txt(d.referente) || 'atendimento psicológico', { continued: true })
      .font('Helvetica').text('.');
    doc.moveDown(0.5);
    doc.font('Helvetica').text('Data do pagamento: ', { continued: true }).font('Helvetica-Bold').text(dtCurto(d.data) || '—');
    doc.moveDown(0.5);
    doc.fillColor(FRACO).font('Helvetica-Oblique').fontSize(10)
      .text('Para maior clareza, firmo o presente recibo, dando plena e total quitação do valor acima.');

    // ---- data + assinatura ----
    y = doc.y + 46;
    doc.fillColor(TINTA).font('Helvetica').fontSize(11)
      .text((txt(d.cidade) ? txt(d.cidade) + ', ' : '') + dtLongo(d.data), M, y, { width: L, align: 'right' });
    const sy = y + 60;
    doc.moveTo(M + L * 0.32, sy).lineTo(M + L, sy).strokeColor(LINHA).lineWidth(1).stroke();
    if (txt(d.emitente?.assinante)) {
      doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(11).text(txt(d.emitente.assinante), M + L * 0.32, sy + 6, { width: L * 0.68, align: 'center' });
      if (txt(d.emitente?.cpf)) doc.font('Helvetica').fontSize(10).text('CPF ' + cpfFmt(d.emitente.cpf), { width: L * 0.68, align: 'center' });
      doc.fillColor(FRACO).font('Helvetica').fontSize(9).text(txt(d.emitente?.nome) || 'TriLumen', { width: L * 0.68, align: 'center' });
    } else {
      doc.fillColor(TINTA).font('Helvetica-Bold').fontSize(11).text(txt(d.emitente?.nome) || 'TriLumen', M + L * 0.32, sy + 6, { width: L * 0.68, align: 'center' });
      if (txt(d.emitente?.subtitulo)) doc.fillColor(FRACO).font('Helvetica').fontSize(9).text(txt(d.emitente.subtitulo), { width: L * 0.68, align: 'center' });
    }

    // ---- rodapé (acima da margem inferior, sem estourar p/ 2ª página) ----
    doc.font('Helvetica').fontSize(7.5).fillColor(FRACO)
      .text((txt(d.emitente?.nome) || 'TriLumen') + ' · ' + (d.numero || '') + ' · emitido pela plataforma Instituto Américo',
        M, doc.page.height - M - 16, { width: L, align: 'center', lineBreak: false });

    doc.end();
  });
}
