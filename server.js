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
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initDb, dbReady, register, login, requireAuth, saveMessage, recentHistory, createInvite, listUsers,
         getProntuario, setProntuario, messagesSinceProfile, patientDaily, getUserBasic } from './db.js';

// --- Base de conhecimento do Método Lúmen (destilada das obras e do curso do Rodrigo) ---
// Lê TODOS os .md de knowledge/ (base doutrinária + as 60 aulas), concatena e injeta
// no sistema com prompt caching (fica profundo e barato por conversa).
const __dir = dirname(fileURLToPath(import.meta.url));
let KNOWLEDGE = '';
try {
  const dir = join(__dir, 'knowledge');
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  KNOWLEDGE = files.map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n\n').trim();
  console.log(`  Base de conhecimento: ${files.length} arquivo(s) — ${KNOWLEDGE.length} caracteres.`);
} catch {
  console.warn('  Aviso: pasta knowledge/ não encontrada — Lúmen roda sem a base do Método.');
}

const app = express();
// atrás do proxy da hospedagem (Render/Railway) — necessário p/ o rate limit ver o IP real
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));
// aceita relatório enviado via navigator.sendBeacon (Blob application/json)
app.use(express.text({ type: ['text/plain'], limit: '1mb' }));

// --- /api/health PÚBLICO (antes da trava) ---
// Só expõe indicadores true/false (nenhum segredo). Fica fora da senha para
// permitir monitorar o estado da IA/e-mail sem login.
app.get('/api/health', (req, res) => res.json({
  ok: true,
  ia: !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('coloque'),
  whatsapp: (process.env.WHATSAPP_PROVIDER || 'none'),
  email: !!process.env.SMTP_HOST,
  contas: dbReady
}));

// ---------------------------------------------------------
//  CONTAS — cadastro (com código de convite), login e sessão
//  Ficam ANTES da trava BETA para o app conseguir logar.
// ---------------------------------------------------------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try { res.json(await register(req.body || {})); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try { res.json(await login(req.body || {})); }
  catch (e) { res.status(401).json({ error: String(e.message || e) }); }
});
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, name: req.user?.name || '', role: req.user?.role || 'paciente' });
});
// histórico recente do próprio paciente (para retomar a conversa entre sessões)
app.get('/api/auth/history', requireAuth, async (req, res) => {
  try {
    res.json({ history: await recentHistory(req.user?.uid, 30) });
    // início de sessão é o momento certo de consolidar a jornada anterior
    updateProntuario(req.user?.uid).catch(e => console.error('prontuario:', e.message));
  }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  PRONTUÁRIO EVOLUTIVO — a Lúmen consolida a jornada do paciente
//  Roda no início de cada sessão, com modelo econômico (Haiku).
// ---------------------------------------------------------
const emAtualizacao = new Set();
async function updateProntuario(uid) {
  if (!uid || !dbReady || emAtualizacao.has(uid)) return;
  const novas = await messagesSinceProfile(uid);
  if (novas.length < 4) return; // pouca coisa nova; espera acumular
  emAtualizacao.add(uid);
  try {
    const atual = (await getProntuario(uid))?.prontuario || '(prontuário ainda vazio — primeira consolidação)';
    const trechos = novas.map(m => {
      const meta = m.meta ? ` [${m.meta.emocao || ''}/${m.meta.status || ''}]` : '';
      return `${new Date(m.created_at).toLocaleDateString('pt-BR')} ${m.role === 'user' ? 'PACIENTE' : 'LÚMEN'}${meta}: ${String(m.content).replace(/##META\{[\s\S]*?\}##\s*/, '').slice(0, 500)}`;
    }).join('\n');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.PRONTUARIO_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        system: `Você mantém o PRONTUÁRIO EVOLUTIVO de um paciente do Método Lúmen (acompanhamento emocional cristão). Atualize o prontuário incorporando as conversas novas ao que já existia. Formato (máx ~500 palavras, direto, sem floreio):
JORNADA: síntese da caminhada até aqui (temas centrais, feridas em trabalho, contexto de vida relevante).
CORPO: como o corpo tem aparecido (sono, cansaço, cuidado físico).
ALMA: estado emocional predominante, padrões (vitimismo/avanço/crise), gatilhos conhecidos.
ESPÍRITO: a relação com Deus que transparece (fé, distância, práticas).
VITÓRIAS E GRATIDÕES: avanços conquistados e motivos de gratidão que a pessoa relatou (com datas aproximadas) — para a Lúmen celebrar e ancorar ensino.
ATENÇÃO: riscos, sinais de alerta, o que não esquecer na próxima conversa.
Preserve o que segue válido do prontuário anterior, corrija o que evoluiu, descarte o que ficou obsoleto.`,
        messages: [{ role: 'user', content: `PRONTUÁRIO ATUAL:\n${atual}\n\nCONVERSAS NOVAS DESDE A ÚLTIMA CONSOLIDAÇÃO:\n${trechos}\n\nEscreva o prontuário atualizado completo.` }]
      })
    });
    const data = await r.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (texto) { await setProntuario(uid, texto); console.log(`  Prontuário consolidado (paciente ${uid}, ${novas.length} msgs novas).`); }
  } finally { emAtualizacao.delete(uid); }
}

// ---------------------------------------------------------
//  MENTOR — gerar convites e ver pacientes (protegido por ADMIN_KEY)
//  Uso pelo navegador: /api/admin/invite?key=SUA_ADMIN_KEY&note=Maria&uses=1
// ---------------------------------------------------------
function requireAdmin(req, res, next) {
  // tolerante a espaços/quebras de linha acidentais ao colar a chave no painel
  const esperado = String(process.env.ADMIN_KEY || '').trim();
  const recebido = String(req.query.key || '').trim();
  if (esperado && recebido === esperado) return next();
  res.status(403).json({ error: 'chave de administrador inválida' });
}
app.get('/api/admin/invite', requireAdmin, async (req, res) => {
  try {
    const code = await createInvite(req.query.note || '', Math.max(1, Number(req.query.uses || 1)));
    res.json({ ok: true, code, note: req.query.note || '', usos: Number(req.query.uses || 1) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try { res.json({ pacientes: await listUsers() }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// detalhe de um paciente: dados, prontuário e a série diária para os gráficos
app.get('/api/admin/patient', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.query.id);
    const [basico, pront, diario] = await Promise.all([
      getUserBasic(id), getProntuario(id), patientDaily(id, Number(req.query.days || 60))
    ]);
    if (!basico) return res.status(404).json({ error: 'paciente não encontrado' });
    res.json({ paciente: basico, prontuario: pront?.prontuario || '', prontuario_em: pront?.updated_at || null, diario });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// --- Trava da BETA (senha única) ---
// Só vale enquanto NÃO há banco de contas. Com contas ativas (dbReady), a proteção
// passa a ser o login individual por paciente — e a trava única sai de cena
// (os dois usam o mesmo cabeçalho Authorization e conflitariam).
if (!dbReady && process.env.BETA_USER && process.env.BETA_PASS) {
  app.use(basicAuth({
    users: { [process.env.BETA_USER]: process.env.BETA_PASS },
    challenge: true,
    realm: 'Lumen BETA'
  }));
  console.log('  Trava da BETA: ATIVA (senha única — sem banco de contas)');
} else if (dbReady) {
  console.log('  Proteção: login individual por paciente (trava BETA dispensada)');
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

COMO VOCÊ FALA — SEJA UMA PESSOA REAL
- Converse como um amigo sábio e presente conversaria pessoalmente, olho no olho, tomando um café. NUNCA como assistente, coach ou terapeuta de manual.
- Português do Brasil falado e natural: pode usar "tô", "pra", "né", "cê", contrações. Calor humano de verdade, não simpatia de atendimento.
- ESPELHE a pessoa. Se ela escreve pouco, responda pouco (às vezes uma linha basta). Se ela desabafa longo, acompanhe. Siga a energia e o assunto DELA, não um roteiro seu.
- Reaja de verdade antes de qualquer coisa. Muitas vezes a melhor resposta é só ficar junto ("tô aqui", "que peso, hein") — sem lição, sem pergunta, sem consertar.
- NEM TODA resposta termina em pergunta. Boa parte delas é uma frase que acolhe e para. No máximo UMA pergunta, e só quando for genuína, não pra preencher.
- Uma ideia por vez. Nada de despejar vários conselhos, listas ou sabedoria de uma vez.
- Chame pela pessoa pelo NOME com naturalidade, como a gente chama de vez em quando — não em toda frase.
- Lembre do que já foi dito e puxe o fio. A conversa tem memória e continuidade, é uma relação, não perguntas soltas.
- Pode usar *itálico* pra destacar uma palavra ou um verso, com parcimônia.

PROIBIDO (é o que faz soar artificial):
- Clichê de terapeuta/atendimento: "entendo como você se sente", "obrigado por compartilhar", "que corajoso da sua parte", "estou aqui para te ajudar", "sinto muito que você esteja passando por isso".
- Repetir ou parafrasear o que a pessoa disse antes de responder ("Então você está dizendo que...").
- Travessões em prosa, construções "não é X — é Y", fechamentos de três batidas, frases de para-choque/aforismo.
- Meta-comentário ("como IA...", "meu papel aqui é...").
- Começar toda resposta do mesmo jeito (sempre nomeando a emoção, ou sempre "poxa,", "nossa,", "puxa,").

O QUE VOCÊ FAZ
- Escuta de verdade e acolhe a emoção antes de qualquer ensino. Presença primeiro, sabedoria depois — e só quando for pedida pelo momento.
- Traz sabedoria emocional com naturalidade, como quem viveu, inspirada (sem citar livros nem soar didática): consciência e regulação das emoções (Goleman), cura da raiz da rejeição e identidade em Deus (Joyce Meyer), autorresponsabilidade que tira a pessoa do papel de vítima (Paulo Vieira), e a transformação do ego.
- Cristo no centro: esperança, graça, identidade em Deus. Sem julgar, sem sermão vazio.
- A Palavra sem forçar: no máximo um versículo por vez, quando fizer sentido de verdade. Use SEMPRE a tradução NVI (Nova Versão Internacional).
- Sabe que não é terapeuta nem serviço de emergência; quando o caso pede, incentiva ajuda profissional com carinho.

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
##META{"risco":"NENHUM|MODERADO|ALTO","emocao":"uma palavra","intensidade":0-10,"padrao":"crise|vitimismo|neutro|avanco","alvo":"si|outro|nenhum","status":"verde|amarelo|vermelho","corpo":0-10,"alma":0-10,"espirito":0-10}##
Sobre a tríade (avaliação silenciosa do Método, pelo que a conversa revela até aqui):
- "corpo" = como o corpo dela parece estar (sono, cansaço, tensão, cuidado físico). 0 = muito mal, 10 = bem cuidado/vivo.
- "alma" = o estado emocional/mental (regulação, feridas ativas, ruminação). 0 = alma em colapso, 10 = alma em paz.
- "espirito" = a conexão com Deus que transparece (fé viva, distância, esperança). 0 = desconexão profunda, 10 = comunhão viva.
Se a conversa ainda não revelou nada sobre uma dimensão, estime com prudência pelo tom geral (tende ao meio, 5).
Depois, pule uma linha e escreva sua resposta à pessoa (sem repetir os metadados).`;

// Monta o "system" como blocos. O bloco grande e estável (voz + base do Método) vai
// com cache_control para o prompt caching baratear cada conversa. Nome e prontuário
// mudam por pessoa e ficam fora do cache.
function buildSystem(name, prontuario) {
  const nome = name ? name : 'a pessoa (nome não informado; peça com delicadeza se fizer sentido)';
  const conhecimento = KNOWLEDGE
    ? `\n\n=========================================================\nSEU SABER INTERIOR (Método Lúmen — não recite, deixe brotar):\n=========================================================\n${KNOWLEDGE}`
    : '';
  const blocos = [
    { type: 'text', text: SYSTEM_BASE + conhecimento, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `NOME DA PESSOA: ${nome}. Use este nome ao se dirigir a ela.` }
  ];
  if (prontuario) blocos.push({ type: 'text', text:
`PRONTUÁRIO EVOLUTIVO DESTA PESSOA (a jornada dela com você até aqui — use como memória viva):
${prontuario}

Como usar: você LEMBRA dessa caminhada. Retome fios com naturalidade ("como ficou aquilo do..."), celebre os avanços e as vitórias registradas, ensine gratidão ancorada no que ela já viveu, e honre o que está em ATENÇÃO. Nunca leia o prontuário em voz alta nem cite que ele existe — é sua memória, não um documento.` });
  return blocos;
}

// ---------------------------------------------------------
//  /api/chat  — conversa com o Claude
// ---------------------------------------------------------
// extrai o ##META{...}## da resposta para gravar no histórico do paciente
function parseMeta(text) {
  const m = String(text || '').match(/##META(\{[\s\S]*?\})##/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

app.post('/api/chat', requireAuth, chatLimiter, async (req, res) => {
  try {
    const { messages = [], name = '' } = req.body || {};
    if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('coloque')) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no .env' });
    }
    // com login, o nome oficial vem da conta (não do que o front mandar)
    const nome = (req.user && req.user.name) || name;
    // memória viva: o prontuário evolutivo entra no sistema desta conversa
    let prontuario = null;
    if (req.user && req.user.uid) {
      prontuario = (await getProntuario(req.user.uid).catch(() => null))?.prontuario || null;
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
        system: buildSystem(nome, prontuario),
        messages: messages.map(m => ({ role: m.role, content: String(m.content || '') }))
      })
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message || 'erro da API' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    // grava a troca no histórico do paciente (última msg do usuário + resposta com META)
    const uid = req.user && req.user.uid;
    if (uid) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      if (lastUser) saveMessage(uid, 'user', String(lastUser.content || ''), null).catch(e => console.error('save user:', e.message));
      saveMessage(uid, 'assistant', text, parseMeta(text)).catch(e => console.error('save assistant:', e.message));
    }

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

initDb().catch(e => console.error('  Banco: falha ao iniciar —', e.message));

app.listen(PORT, () => {
  console.log(`\n  LÚMEN no ar em http://localhost:${PORT}`);
  console.log(`  IA: ${process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('coloque') ? 'configurada' : 'FALTA a ANTHROPIC_API_KEY'}`);
  console.log(`  Contas: ${dbReady ? 'banco conectado (login exigido)' : 'SEM banco — modo aberto'}`);
  console.log(`  WhatsApp: ${process.env.WHATSAPP_PROVIDER || 'none'} | E-mail: ${process.env.SMTP_HOST ? 'configurado' : 'não configurado'}\n`);
});
