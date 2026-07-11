// =========================================================
//  LÚMEN — servidor
//  - /api/chat   : conversa real com o Claude (chave fica segura no servidor)
//  - /api/alert  : dispara WhatsApp de emergência automaticamente
//  - /api/report : envia o relatório do atendimento por e-mail
//  Método Lúmen™ · "A luz só atravessa o que está alinhado."
// =========================================================
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import basicAuth from 'express-basic-auth';

const app = express();
// atrás do proxy da hospedagem (Render/Railway) — necessário p/ o rate limit ver o IP real
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// aceita relatório enviado via navigator.sendBeacon (Blob application/json)
app.use(express.text({ type: ['text/plain'], limit: '1mb' }));

// --- Trava da BETA (senha de acesso) ---
// Se BETA_USER e BETA_PASS estiverem no .env, o navegador pede login antes de abrir o app.
// Compartilhe usuário/senha só com quem vai testar. Sem essas variáveis, o app fica aberto.
if (process.env.BETA_USER && process.env.BETA_PASS) {
  app.use(basicAuth({
    users: { [process.env.BETA_USER]: process.env.BETA_PASS },
    challenge: true,
    realm: 'Lumen BETA'
  }));
  console.log('  Trava da BETA: ATIVA (login exigido)');
}

app.use(express.static('public'));

// --- Limite de mensagens (protege seus créditos do Opus) ---
// Teto por IP numa janela de tempo. Ajuste pelos env CHAT_RATE_MAX / CHAT_RATE_WINDOW_MIN.
const chatLimiter = rateLimit({
  windowMs: Number(process.env.CHAT_RATE_WINDOW_MIN || 10) * 60 * 1000,
  max: Number(process.env.CHAT_RATE_MAX || 40),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas mensagens em pouco tempo. Respire e tente de novo daqui a pouco.' }
});

const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------
//  IA — prompt da Lúmen (vive no servidor, controlado por você)
// ---------------------------------------------------------
const SYSTEM_BASE = `Você é LÚMEN, o companheiro emocional do Método Lúmen™, criado por Rodrigo Américo.
Identidade: inteligência emocional cristocêntrica, estruturada em Corpo, Alma e Espírito. Arquétipo: O Sábio.
Lema: "A luz só atravessa o que está alinhado."

COMO VOCÊ FALA
- Português do Brasil, humano, vivo, direto e pastoral. Papo reto, com afeto. Soe como uma pessoa real conversando, nunca como um assistente.
- Chame a pessoa pelo NOME dela em toda resposta, de forma natural.
- Responda ao que a pessoa realmente disse: reflita as palavras dela, acompanhe o fio da conversa, lembre do que já foi dito. Nada de respostas genéricas ou desconexas.
- Nada de linguagem robótica. PROIBIDO: travessões em prosa, construções "não é X — é Y", meta-comentário ("como IA..."), e fechamentos aforísticos de três batidas.
- Frases simples, calor humano, presença. No máximo uma pergunta por vez, e nem toda resposta precisa terminar em pergunta.
- Pode usar *itálico* para destacar uma palavra ou um verso.

O QUE VOCÊ FAZ
- Escuta de verdade, acolhe a emoção antes de qualquer ensino.
- Traz sabedoria emocional (regulação, nomear sentimentos, reenquadre) e a Palavra, sem forçar. Um versículo por vez, quando fizer sentido.
- Cristo no centro: esperança, graça, identidade em Deus. Sem julgar, sem sermão vazio.
- Sabe que não é terapeuta nem serviço de emergência; quando o caso pede, incentiva ajuda profissional.

PADRÕES
- VITIMISMO / autopiedade instalada, terceirização de responsabilidade: acolha primeiro, depois confronte com amor. Papo reto que devolve responsabilidade e dignidade, sem dureza.
- AVANÇO: celebre discretamente, ancore.
- NEUTRO: presença e continuidade.

PROTOCOLO DE RISCO À PRÓPRIA VIDA (prioridade máxima)
- Qualquer sinal de suicídio, autolesão, desejo de sumir/morrer — inclusive nas ENTRELINHAS:
  NÃO confronte. Só presença, acolhimento, dignidade, esperança. Estimule com carinho a buscar ajuda humana imediata (o app mostra CVV 188). risco = ALTO, alvo = "si".

PROTOCOLO DE RISCO A OUTRA PESSOA / CRIANÇA (prioridade máxima)
- Qualquer sinal de intenção de matar, machucar ou tirar a vida de outra pessoa, criança ou bebê — inclusive nas entrelinhas:
  Leve a sério, sem pânico. Não instrua nem valide o plano. Acolha a dor por trás, mas seja firme: a vida do outro precisa ser protegida. Trate gravidez/aborto/perda com muita compaixão, sem condenar. risco = ALTO, alvo = "outro".

STATUS DO ATENDIMENTO
- "verde" = pessoa acolhida, mais calma, sem risco; "amarelo" = atenção especial, dor ativa; "vermelho" = risco identificado (nunca marque verde havendo qualquer risco).

FORMATO DE RESPOSTA (obrigatório)
Comece SEMPRE com uma linha de metadados e nada antes dela:
##META{"risco":"NENHUM|MODERADO|ALTO","emocao":"uma palavra","intensidade":0-10,"padrao":"crise|vitimismo|neutro|avanco","alvo":"si|outro|nenhum","status":"verde|amarelo|vermelho"}##
Depois, pule uma linha e escreva sua resposta à pessoa (sem repetir os metadados).`;

function buildSystem(name) {
  const nome = name ? name : 'a pessoa (nome não informado; peça com delicadeza se fizer sentido)';
  return SYSTEM_BASE + `\n\nNOME DA PESSOA: ${nome}. Use este nome ao se dirigir a ela.`;
}

// ---------------------------------------------------------
//  /api/chat  — conversa com o Claude
// ---------------------------------------------------------
app.post('/api/chat', chatLimiter, async (req, res) => {
  try {
    const { messages = [], name = '' } = req.body || {};
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('coloque')) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no .env' });
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: buildSystem(name),
        messages: messages.map(m => ({ role: m.role, content: String(m.content || '') }))
      })
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message || 'erro da API' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    res.json({ text });
  } catch (e) {
    console.error('chat:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------
//  WhatsApp — envia por Twilio ou Z-API (ou só registra)
// ---------------------------------------------------------
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length <= 11 && !d.startsWith('55')) d = '55' + d;
  return d;
}

async function sendWhatsApp(to, body) {
  const provider = (process.env.WHATSAPP_PROVIDER || 'none').toLowerCase();
  const phone = normPhone(to || process.env.GUARDIAN_PHONE);

  if (provider === 'twilio') {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const form = new URLSearchParams({ From: from, To: `whatsapp:+${phone}`, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const d = await r.json();
    return { sent: r.ok, provider, id: d.sid, detail: d.message || null };
  }

  if (provider === 'zapi') {
    const inst = process.env.ZAPI_INSTANCE;
    const token = process.env.ZAPI_TOKEN;
    const r = await fetch(`https://api.z-api.io/instances/${inst}/token/${token}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN || '' },
      body: JSON.stringify({ phone, message: body })
    });
    const d = await r.json().catch(() => ({}));
    return { sent: r.ok, provider, id: d.messageId || d.id || null, detail: d.error || null };
  }

  // provider = none -> só registra no console (útil para testar sem provedor)
  console.log(`[WhatsApp:none] Para ${phone}:\n${body}\n`);
  return { sent: false, provider: 'none', note: 'Configure WHATSAPP_PROVIDER para enviar de verdade.' };
}

// ---------------------------------------------------------
//  /api/alert  — alerta de emergência
// ---------------------------------------------------------
app.post('/api/alert', async (req, res) => {
  try {
    const { type = 'si', name = 'a pessoa em atendimento', phone, time } = req.body || {};
    const when = time || new Date().toLocaleString('pt-BR');
    let msg;
    if (type === 'outros') {
      msg = `[LÚMEN · ALERTA GRAVE — RISCO A TERCEIROS]\n${when}\n\n` +
        `Durante um atendimento surgiram sinais de risco de dano a outra pessoa ou a uma criança, envolvendo ${name}. ` +
        `Isto exige contato imediato e, se necessário, acionamento das autoridades. Não ignore esta mensagem.`;
    } else {
      msg = `[LÚMEN · ALERTA DE CUIDADO — RISCO DE VIDA]\n${when}\n\n` +
        `Foram identificados sinais de risco emocional grave com ${name}. Por favor, entre em contato o quanto antes. ` +
        `Essa pessoa pode precisar de você agora.`;
    }
    const result = await sendWhatsApp(phone, msg);
    res.json(result);
  } catch (e) {
    console.error('alert:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------
//  E-mail — relatórios
// ---------------------------------------------------------
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function formatReport(b) {
  const linhas = (b.alerts && b.alerts.length)
    ? b.alerts.map(a => `   • ${a.time} — ${a.type === 'outros' ? 'RISCO A TERCEIROS' : 'risco à própria vida'} (${a.phone || '-'})`).join('\n')
    : '   • nenhum';
  const statusMap = { verde: 'VERDE · Solucionado', amarelo: 'AMARELO · Atenção especial', vermelho: 'VERMELHO · Não solucionado', andamento: 'Em andamento' };
  return (
`RELATÓRIO DE ATENDIMENTO — LÚMEN
"A luz só atravessa o que está alinhado."
──────────────────────────────

Pessoa: ${b.name || 'não informado'}
Data: ${b.date || new Date().toLocaleString('pt-BR')}
Duração: ~${b.duration || '?'} min
${b.encerradoNoMeio ? 'Obs.: atendimento ENCERRADO NO MEIO pela pessoa.\n' : ''}
STATUS: ${statusMap[b.status] || b.status || '-'}

Estado emocional predominante: ${b.emotion || '-'}
Nível de risco: ${b.risk || '-'}
Padrão observado: ${b.pattern || '-'}
Interações: ${b.msgCount != null ? b.msgCount : '-'}

Alertas de emergência disparados:
${linhas}

Leitura:
${b.reading || '-'}

──────────────────────────────
Método Lúmen™ · relatório gerado automaticamente`);
}

async function handleReport(body, res) {
  const t = mailer();
  const to = body.email || process.env.REPORT_EMAIL_TO;
  const status = (body.status || '').toUpperCase();
  const subject = `Relatório Lúmen — ${body.name || 'atendimento'} — ${status || 'atendimento'}`;
  const text = body.text || formatReport(body);
  if (!t) { console.log('[E-mail não configurado] Relatório para', to, '\n', text); if (res) res.json({ sent: false, note: 'SMTP não configurado' }); return; }
  await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
  if (res) res.json({ sent: true, to });
}

app.post('/api/report', async (req, res) => {
  try {
    // sendBeacon chega como texto puro; fetch normal chega como JSON
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    await handleReport(body, res);
  } catch (e) {
    console.error('report:', e);
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/health', (req, res) => res.json({
  ok: true,
  ia: !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('coloque'),
  whatsapp: (process.env.WHATSAPP_PROVIDER || 'none'),
  email: !!process.env.SMTP_HOST
}));

app.listen(PORT, () => {
  console.log(`\n  LÚMEN no ar em http://localhost:${PORT}`);
  console.log(`  IA: ${process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('coloque') ? 'configurada' : 'FALTA a ANTHROPIC_API_KEY'}`);
  console.log(`  WhatsApp: ${process.env.WHATSAPP_PROVIDER || 'none'} | E-mail: ${process.env.SMTP_HOST ? 'configurado' : 'não configurado'}\n`);
});
