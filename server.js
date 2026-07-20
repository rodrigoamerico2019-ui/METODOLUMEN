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
         getProntuario, setProntuario, messagesSinceProfile, patientDaily, getUserBasic,
         todayCheckin, saveCheckin, checkinSeries, sessionDays, transcriptOfDay, triadAverages,
         emergencyContact, checkinStreak, getExtras, mergeVitorias, setNotasMentor,
         overviewStats, globalDaily, emotionsPredominant,
         savePushSub, pushSubsOf, deletePushSub, saveMentorMessage, unreadMentorMessages, markMentorRead, mentorMessagesAll,
         usersForReminders, reminderSent, markReminderSent,
         getCollectiveWisdom, setCollectiveWisdom, anonVictories, healingAggregate,
         userHasPhoto, setUserPhoto, saveAudio, setAudioSummary, getAudioBytes, listAudios, myAudios,
         palavraToday, setPalavra, usersForPalavra,
         PLANOS, provisionarAssinatura, mentorLogin, changeMentorLogin, orgById, patientOrg, listOrganizations,
         provisionarManual, setOrgStatus, setOrgLimite, markOrgPagamento,
         saveCheckout, getCheckoutBySub, markCheckoutProvisioned,
         saveScaleResponse, latestScales, scaleHistory, scalesForPatient,
         getActionPlan, saveActionPlan, setPlanDelivered, deliveredPlan,
         mapaNeeded, getMapa, getMapaBussola, saveMapaInicial,
         getPatientPlan, setPatientPlan, patientReceivables, listReceivables, addReceivable, setReceivablePaid,
         listPayables, addPayable, setPayablePaid, deletePayable, financeSummary,
         generateMonthlyReceivables, receivablesForReminder, markReceivableReminded,
         listAppointments, patientAppointments, addAppointment, setAppointmentStatus, deleteAppointment,
         appointmentsForReminder, markAppointmentReminded,
         getMemberRole, listOrgMembers, registrarAuditoria, listAudit,
         criarClienteRapido, listClients, getClientFull, updateClientDetails,
         getHealthProfile, saveHealthProfile, getSpiritualProfile, saveSpiritualProfile,
         addEmotionalAssessment, listEmotionalAssessments,
         listMedications, addMedication, suspendMedication,
         listGoals, addGoal, updateGoal, deleteGoal,
         listSessions, createSession, getSessionFull, updateSession, deleteSession,
         saveSessionRecord, saveSharedSummary, listSessionTasks, addSessionTask, updateSessionTask,
         statusAcessoCliente, criarAcessoCliente, checarAcessoToken, ativarAcessoCliente, revogarAcessoCliente,
         sharedForClient, concluirTarefaCliente,
         reportData, salvarRelatorio, gravarPdfRelatorio, listReports, getReportPdf } from './db.js';
import { buildReportPdf } from './relatorio.js';
import { ESCALAS, catalogoEscalas, escalaByKey, pontuar, faixaPorChave } from './escalas.js';
import { catalogoMapa, processarMapa } from './mapa.js';
import webpush from 'web-push';
import jwtLib from 'jsonwebtoken';

// --- Notificações push (PWA) ---
// Sanitiza as chaves (espaços/aspas/quebras colados por engano) e NUNCA derruba
// o servidor por chave inválida: só desliga o push e avisa no log.
const limpaChave = v => String(v || '').replace(/["'\s]/g, '').replace(/=+$/, '');
const VAPID_PUB = limpaChave(process.env.VAPID_PUBLIC_KEY);
const VAPID_PRIV = limpaChave(process.env.VAPID_PRIVATE_KEY);
let PUSH_ON = false;
if (VAPID_PUB && VAPID_PRIV) {
  try {
    webpush.setVapidDetails(
      (process.env.VAPID_SUBJECT || 'mailto:contato@metodolumen.com.br').trim(),
      VAPID_PUB, VAPID_PRIV
    );
    PUSH_ON = true;
  } catch (e) {
    console.warn(`  Push DESLIGADO — chave VAPID inválida (pública com ${VAPID_PUB.length} chars, esperado 87; privada com ${VAPID_PRIV.length}, esperado 43): ${e.message}`);
  }
}

// envia uma notificação a todos os aparelhos do paciente (limpa inscrições mortas)
async function sendPushToUser(uid, payload) {
  if (!PUSH_ON || !uid) return 0;
  const subs = await pushSubsOf(uid);
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload)); ok++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await deletePushSub(s.endpoint).catch(() => {});
    }
  }
  return ok;
}

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
  contas: dbReady,
  push: PUSH_ON,
  lembretes: PUSH_ON && String(process.env.REMINDERS || 'on') === 'on',
  coletivo: COLETIVO_ON && !!COLETIVO,
  audio: AUDIO_ON,
  transcricao: !!process.env.OPENAI_API_KEY,
  palavra: PALAVRA_ON,
  escalas: dbReady,
  pagamento: ASAAS_ON
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
    // escalas de acompanhamento mais recentes (0–100) para a IA ler no contexto
    let blocoEscalas = '';
    try {
      const ult = await latestScales(uid);
      if (ult.length) {
        blocoEscalas = '\n\nESCALAS MAIS RECENTES (0–100 · o próprio paciente respondeu):\n' +
          ult.map(u => {
            const e = escalaByKey(u.scale_key); if (!e) return null;
            const f = faixaPorChave(u.scale_key, Number(u.score));
            const dir = e.direcao === 'menor_melhor' ? 'menor=melhor' : 'maior=melhor';
            return `- ${e.titulo}: ${u.score}/100 (${f ? f.rotulo : ''}; ${dir})`;
          }).filter(Boolean).join('\n');
      }
    } catch (_) {}
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
Preserve o que segue válido do prontuário anterior, corrija o que evoluiu, descarte o que ficou obsoleto.
AO FINAL, depois do prontuário, acrescente UMA linha exatamente neste formato com as vitórias/gratidões NOVAS destas conversas (array vazio se não houver):
##VITORIAS[{"data":"dd/mm","texto":"vitória em poucas palavras"}]##`,
        messages: [{ role: 'user', content: `PRONTUÁRIO ATUAL:\n${atual}\n\nCONVERSAS NOVAS DESDE A ÚLTIMA CONSOLIDAÇÃO:\n${trechos}${blocoEscalas}\n\nEscreva o prontuário atualizado completo (considere as escalas ao descrever CORPO/ALMA/ESPÍRITO e ATENÇÃO).` }]
      })
    });
    const data = await r.json();
    let texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (texto) {
      // separa as vitórias estruturadas do texto do prontuário
      const mv = texto.match(/##VITORIAS(\[[\s\S]*?\])##/);
      if (mv) {
        texto = texto.replace(mv[0], '').trim();
        try { await mergeVitorias(uid, JSON.parse(mv[1])); } catch (_) {}
      }
      await setProntuario(uid, texto);
      console.log(`  Prontuário consolidado (paciente ${uid}, ${novas.length} msgs novas).`);
    }
  } finally { emAtualizacao.delete(uid); }
}

// ---------------------------------------------------------
//  PLANO DE AÇÃO — a IA propõe um plano semanal ancorado na jornada
//  (Corpo/Alma/Espírito + prática). O mentor revisa e entrega ao paciente.
// ---------------------------------------------------------
async function gerarPlanoAcao(uid) {
  if (!uid || !dbReady) throw new Error('sem banco');
  const [pront, ult, triade, extras] = await Promise.all([
    getProntuario(uid), latestScales(uid), triadAverages(uid, 14), getExtras(uid)
  ]);
  const escalasTxt = (ult || []).map(u => {
    const e = escalaByKey(u.scale_key); if (!e) return null;
    const f = faixaPorChave(u.scale_key, Number(u.score));
    return `- ${e.titulo}: ${u.score}/100 (${f ? f.rotulo : ''})`;
  }).filter(Boolean).join('\n') || '(sem escalas respondidas ainda)';
  const triTxt = triade && triade.amostras > 0
    ? `Corpo ${triade.corpo ?? '—'} · Alma ${triade.alma ?? '—'} · Espírito ${triade.espirito ?? '—'} (média /10, 14 dias)`
    : '(sem leitura da tríade ainda)';
  const vits = (extras?.vitorias || []).slice(-5).map(v => `- ${v.texto}`).join('\n') || '(ainda não registradas)';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.PRONTUARIO_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      system: `Você é a Lúmen, apoio emocional cristão do Método Lúmen. Crie um PLANO DE AÇÃO SEMANAL para esta pessoa, prático, gentil e possível de cumprir (nada de metas pesadas). Ancorado na tríade Corpo, Alma e Espírito, com passos concretos do dia a dia e, quando fizer sentido, uma prática relacional. Fale com a pessoa em segunda pessoa (você), com carinho e esperança, sem clichês de terapia. NÃO é prescrição médica.
Responda SOMENTE com um JSON válido, sem texto fora dele, neste formato exato:
{"foco":"uma frase-âncora curta da semana (máx 90 caracteres)","passos":[{"dimensao":"Corpo|Alma|Espírito|Relações","titulo":"ação curta (máx 60 caracteres)","descricao":"como fazer, em 1 frase acolhedora (máx 160 caracteres)"}]}
Gere de 3 a 5 passos, variando as dimensões conforme a necessidade da pessoa (priorize onde ela está mais frágil).`,
      messages: [{ role: 'user', content:
`PRONTUÁRIO DA PESSOA:\n${pront?.prontuario || '(ainda em formação)'}\n\nESCALAS RECENTES:\n${escalasTxt}\n\nTRÍADE:\n${triTxt}\n\nVITÓRIAS RECENTES:\n${vits}\n\nGere o plano de ação em JSON.` }]
    })
  });
  const data = await r.json();
  let txt = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('a IA não retornou um plano válido');
  const plano = JSON.parse(m[0]);
  const passos = Array.isArray(plano.passos) ? plano.passos.map(p => ({
    dimensao: String(p.dimensao || '').slice(0, 20),
    titulo: String(p.titulo || '').slice(0, 80),
    descricao: String(p.descricao || '').slice(0, 220)
  })).filter(p => p.titulo) : [];
  if (!passos.length) throw new Error('plano sem passos');
  return saveActionPlan(uid, { foco: String(plano.foco || '').slice(0, 200), passos });
}

// ---------------------------------------------------------
//  MENTOR — gerar convites e ver pacientes (protegido por ADMIN_KEY)
//  Uso pelo navegador: /api/admin/invite?key=SUA_ADMIN_KEY&note=Maria&uses=1
// ---------------------------------------------------------
// Acesso ao painel: ADMIN_KEY = super-admin (Rodrigo, vê TODAS as orgs, req.orgId=null)
// OU token de mentor (Bearer) = vê apenas a própria organização (req.orgId setado).
function requireAdmin(req, res, next) {
  const esperado = String(process.env.ADMIN_KEY || '').trim();
  const recebido = String(req.query.key || '').trim();
  if (esperado && recebido === esperado) { req.orgId = null; req.superAdmin = true; return next(); }
  try {
    // token de mentor: no header Authorization OU na query ?token= (para <audio src>)
    const h = req.headers.authorization || '';
    const raw = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token ? String(req.query.token) : null);
    const tok = raw ? jwtVerify(raw) : null;
    if (tok && tok.mentor) { req.orgId = tok.org_id; req.mentorUid = tok.uid; return next(); }
  } catch (_) {}
  res.status(403).json({ error: 'acesso não autorizado' });
}
function jwtVerify(token) {
  const jwt = jwtLib; return jwt.verify(token, process.env.JWT_SECRET || 'defina-JWT_SECRET-no-env');
}
// O painel ADM (super-admin) NÃO acessa pacientes — só negócio/licenças.
// Estas rotas exigem uma conta de mentor (com organização).
function soMentor(req, res, next) {
  if (req.superAdmin) return res.status(403).json({ error: 'O painel administrativo não acessa pacientes dos clientes.' });
  next();
}
// RBAC: carrega o papel do mentor (org_members). Sem registro explícito, um mentor é 'admin' da própria org.
async function carregaPapel(req, res, next) {
  let role = null;
  try { if (req.mentorUid) role = await getMemberRole(req.orgId, req.mentorUid); } catch (_) {}
  req.memberRole = role || (req.mentorUid ? 'admin' : null);
  next();
}
function permite(...roles) {
  return (req, res, next) => roles.includes(req.memberRole) ? next()
    : res.status(403).json({ error: 'Seu perfil não tem permissão para esta ação.' });
}

app.get('/api/admin/invite', requireAdmin, async (req, res) => {
  try {
    const org = req.orgId || 1; // super-admin gera para a org Método Lúmen por padrão
    const code = await createInvite(req.query.note || '', Math.max(1, Number(req.query.uses || 1)), org);
    res.json({ ok: true, code, note: req.query.note || '', usos: Number(req.query.uses || 1) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/admin/users', requireAdmin, soMentor, async (req, res) => {
  try { res.json({ pacientes: await listUsers(req.orgId) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// agrupa as respostas de escalas por escala, com metadados, evolução e tendência
function montarEscalasPaciente(rows) {
  const porChave = {};
  for (const r of rows || []) {
    (porChave[r.scale_key] ||= []).push({ dia: r.dia, score: Number(r.score), em: r.created_at });
  }
  return ESCALAS.map(e => {
    const serie = porChave[e.key] || [];
    if (!serie.length) return { key: e.key, titulo: e.titulo, cor: e.cor, direcao: e.direcao, respostas: 0 };
    const ultimo = serie[serie.length - 1];
    const anterior = serie.length > 1 ? serie[serie.length - 2] : null;
    // "melhora" respeita a direção da escala (na ansiedade, cair é melhorar)
    let tendencia = 0;
    if (anterior) {
      const delta = ultimo.score - anterior.score;
      tendencia = e.direcao === 'menor_melhor' ? -delta : delta;
    }
    return {
      key: e.key, titulo: e.titulo, cor: e.cor, direcao: e.direcao,
      respostas: serie.length, serie,
      atual: ultimo.score, atual_em: ultimo.em,
      faixa: faixaPorChave(e.key, ultimo.score),
      tendencia   // >0 melhorou, <0 piorou, 0 estável/primeira
    };
  }).filter(x => x.respostas > 0);
}

// LINHA DO TEMPO: junta os eventos da jornada num fluxo cronológico único
function montarTimeline({ sessoes, escalasRows, audios, checkins, mentorMsgs, plano }) {
  const ev = [];
  const push = (ts, tipo, titulo, detalhe) => { if (ts) ev.push({ ts: new Date(ts).toISOString(), tipo, titulo, detalhe }); };
  for (const s of sessoes || []) push(s.fim || s.inicio || (s.dia + 'T12:00:00'), 'sessao', 'Conversa com a Lúmen', `${s.perguntas || 0} pergunta(s)`);
  for (const r of escalasRows || []) {
    const e = escalaByKey(r.scale_key); const f = faixaPorChave(r.scale_key, Number(r.score));
    push(r.created_at, 'escala', `Escala · ${e ? e.titulo : r.scale_key}`, `${r.score}/100${f ? ' · ' + f.rotulo : ''}`);
  }
  for (const a of audios || []) push(a.created_at, 'audio', 'Áudio — “Fala como está”', a.duration_sec ? `${a.duration_sec}s` : '');
  for (const c of checkins || []) push((c.dia || '') + 'T12:00:00', 'checkin', 'Check-in do dia',
    `${c.emocao || '—'} · corpo ${c.corpo}/alma ${c.alma}/espírito ${c.espirito}`);
  for (const m of mentorMsgs || []) push(m.created_at, 'mensagem', 'Mensagem sua ao paciente', String(m.texto || '').slice(0, 120));
  if (plano) {
    if (plano.gerado_em) push(plano.gerado_em, 'plano', 'Plano de ação gerado', plano.foco || '');
    if (plano.entregue && plano.entregue_em) push(plano.entregue_em, 'plano', 'Plano entregue ao paciente', plano.foco || '');
  }
  return ev.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 80);
}

// detalhe de um paciente: cadastro, prontuário, séries, esferas, vitórias e notas
app.get('/api/admin/patient', requireAdmin, soMentor, async (req, res) => {
  try {
    const id = Number(req.query.id);
    // mentor só acessa paciente da própria organização
    if (req.orgId && (await patientOrg(id)) !== req.orgId) return res.status(403).json({ error: 'sem acesso a este paciente' });
    const [basico, pront, diario, esferas, checkins, sessoes, extras, streak, audios, escalasRows, plano, mentorMsgs, mapa, planoFin, receberFin, consultasPac] = await Promise.all([
      getUserBasic(id), getProntuario(id), patientDaily(id, Number(req.query.days || 60)),
      triadAverages(id, 7), checkinSeries(id, 60), sessionDays(id), getExtras(id), checkinStreak(id), listAudios(id),
      scalesForPatient(id), getActionPlan(id), mentorMessagesAll(id), getMapa(id), getPatientPlan(id), patientReceivables(id),
      patientAppointments(id)
    ]);
    if (!basico) return res.status(404).json({ error: 'paciente não encontrado' });
    res.json({ paciente: basico, prontuario: pront?.prontuario || '', prontuario_em: pront?.updated_at || null,
               diario, esferas, checkins, sessoes, vitorias: extras.vitorias || [],
               notas_mentor: extras.notas_mentor || '', streak, audios,
               escalas: montarEscalasPaciente(escalasRows), plano: plano || null,
               timeline: montarTimeline({ sessoes, escalasRows, audios, checkins, mentorMsgs, plano }),
               mapa: mapa && mapa.mapa_em ? { respostas: mapa.mapa || [], risco: !!mapa.mapa_risco, em: mapa.mapa_em } : null,
               financeiro: { plano: planoFin || null, receber: receberFin || [] },
               consultas: consultasPac || [] });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// anotações privadas do mentor
app.post('/api/admin/notes', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    await setNotasMentor(Number(req.query.id), (req.body || {}).texto || ''); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// PLANO DE AÇÃO — gerar com IA, editar e entregar ao paciente
app.post('/api/admin/plan/generate', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'IA não configurada' });
    const plano = await gerarPlanoAcao(Number(req.query.id));
    res.json({ ok: true, plano });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/plan/save', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    const b = req.body || {};
    const plano = await saveActionPlan(Number(req.query.id), { foco: b.foco, passos: b.passos });
    res.json({ ok: true, plano });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/plan/deliver', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    const plano = await setPlanDelivered(Number(req.query.id), !!(req.body || {}).entregue);
    res.json({ ok: true, plano });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== CENTRAL FINANCEIRA DO CONSULTÓRIO (mentor) =====
app.get('/api/admin/finance', requireAdmin, soMentor, async (req, res) => {
  try {
    const [resumo, receber, pagar] = await Promise.all([
      financeSummary(req.orgId), listReceivables(req.orgId), listPayables(req.orgId)
    ]);
    res.json({ resumo, receber, pagar });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/finance/receivable', requireAdmin, soMentor, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.userId && req.orgId && (await patientOrg(Number(b.userId))) !== req.orgId) return res.status(403).json({ error: 'paciente de outra organização' });
    const r = await addReceivable({ orgId: req.orgId, userId: b.userId ? Number(b.userId) : null, descricao: b.descricao, valor: b.valor, vencimento: b.vencimento });
    res.json({ ok: true, id: r.id });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/finance/receivable/pay', requireAdmin, soMentor, async (req, res) => {
  try { res.json(await setReceivablePaid(Number(req.query.id), req.orgId, !!(req.body || {}).pago)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/finance/payable', requireAdmin, soMentor, async (req, res) => {
  try { const r = await addPayable(req.orgId, req.body || {}); res.json({ ok: true, id: r.id }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/finance/payable/pay', requireAdmin, soMentor, async (req, res) => {
  try { res.json(await setPayablePaid(Number(req.query.id), req.orgId, !!(req.body || {}).pago)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/finance/payable/delete', requireAdmin, soMentor, async (req, res) => {
  try { res.json(await deletePayable(Number(req.query.id), req.orgId)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// plano/mensalidade do paciente (definido na ficha)
app.post('/api/admin/finance/plan', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    const plano = await setPatientPlan(Number(req.query.id), req.body || {});
    res.json({ ok: true, plano });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== AGENDA DE CONSULTAS (mentor) =====
app.get('/api/admin/agenda', requireAdmin, soMentor, async (req, res) => {
  try { res.json({ consultas: await listAppointments(req.orgId) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/agenda', requireAdmin, soMentor, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.userId && req.orgId && (await patientOrg(Number(b.userId))) !== req.orgId) return res.status(403).json({ error: 'paciente de outra organização' });
    const r = await addAppointment({ orgId: req.orgId, userId: Number(b.userId), quando: b.quando, duracao_min: b.duracao_min, modalidade: b.modalidade, local: b.local, obs: b.obs });
    res.json({ ok: true, id: r.id });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/agenda/status', requireAdmin, soMentor, async (req, res) => {
  try { res.json(await setAppointmentStatus(Number(req.query.id), req.orgId, (req.body || {}).status)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/agenda/delete', requireAdmin, soMentor, async (req, res) => {
  try { res.json(await deleteAppointment(Number(req.query.id), req.orgId)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== MÓDULO DE CLIENTES (Etapa 3) =====
const STAFF = ['owner', 'admin', 'professional', 'professional_secondary', 'reception'];
const CADASTRA = ['owner', 'admin', 'professional', 'reception'];
app.get('/api/admin/clients', requireAdmin, soMentor, carregaPapel, permite(...STAFF, 'financeiro'), async (req, res) => {
  try { res.json({ clientes: await listClients(req.orgId, { q: req.query.q, status: req.query.status }) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/admin/clients/members', requireAdmin, soMentor, carregaPapel, async (req, res) => {
  try { res.json({ membros: await listOrgMembers(req.orgId) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients', requireAdmin, soMentor, carregaPapel, permite(...CADASTRA), async (req, res) => {
  try { res.json({ ok: true, cliente: await criarClienteRapido(req.orgId, req.mentorUid, { ...(req.body || {}), ip: req.ip }) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/admin/clients/full', requireAdmin, soMentor, carregaPapel, permite(...STAFF, 'financeiro'), async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (req.orgId && (await patientOrg(id)) !== req.orgId) return res.status(403).json({ error: 'cliente de outra organização' });
    const c = await getClientFull(id);
    if (!c) return res.status(404).json({ error: 'cliente não encontrado' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/update', requireAdmin, soMentor, carregaPapel, permite(...CADASTRA), async (req, res) => {
  try {
    const id = Number(req.query.id);
    if (req.orgId && (await patientOrg(id)) !== req.orgId) return res.status(403).json({ error: 'cliente de outra organização' });
    res.json(await updateClientDetails(id, req.orgId, req.mentorUid, { ...(req.body || {}), ip: req.ip }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.get('/api/admin/clients/audit', requireAdmin, soMentor, carregaPapel, permite('owner', 'admin', 'professional'), async (req, res) => {
  try {
    const id = Number(req.query.id) || null;
    if (id && req.orgId && (await patientOrg(id)) !== req.orgId) return res.status(403).json({ error: 'cliente de outra organização' });
    res.json({ eventos: await listAudit(req.orgId, id) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ===== ETAPA 4: dados clínicos sensíveis (perfis clínicos) =====
const CLINICO = ['owner', 'admin', 'professional', 'professional_secondary'];
async function clienteDaOrg(req, res) {
  const id = Number(req.query.id);
  if (req.orgId && (await patientOrg(id)) !== req.orgId) { res.status(403).json({ error: 'cliente de outra organização' }); return null; }
  return id;
}
const clin = [requireAdmin, soMentor, carregaPapel, permite(...CLINICO)];
// Saúde
app.get('/api/admin/clients/health', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ perfil: await getHealthProfile(id) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/health', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json(await saveHealthProfile(id, req.orgId, (req.body || {}).dados || req.body, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// Espiritual
app.get('/api/admin/clients/spiritual', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ perfil: await getSpiritualProfile(id) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/spiritual', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; const b = req.body || {}; res.json(await saveSpiritualProfile(id, req.orgId, b.ativo, b.dados || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// Emocional
app.get('/api/admin/clients/emotional', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ avaliacoes: await listEmotionalAssessments(id) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/emotional', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; const b = req.body || {}; res.json(await addEmotionalAssessment(id, req.orgId, b.escalas || {}, b.campos || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// Medicamentos
app.get('/api/admin/clients/meds', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ meds: await listMedications(id) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/meds', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ ok: true, ...(await addMedication(id, req.orgId, req.body || {}, req.mentorUid)) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/meds/suspend', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; const b = req.body || {}; res.json(await suspendMedication(Number(req.query.medId), req.orgId, id, b.motivo, b.data_suspensao, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// Objetivos
app.get('/api/admin/clients/goals', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ goals: await listGoals(id) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/goals', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ ok: true, ...(await addGoal(id, req.orgId, req.body || {}, req.mentorUid)) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/goals/update', ...clin, async (req, res) => {
  try { res.json(await updateGoal(Number(req.query.goalId), req.orgId, req.body || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/goals/delete', ...clin, async (req, res) => {
  try { res.json(await deleteGoal(Number(req.query.goalId), req.orgId)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== ETAPA 5: sessões + prontuário (privado) + resumo (compartilhável) + tarefas =====
// confere que a sessão é da organização do mentor; guarda a sessão em req._sessao
async function sessaoDaOrg(req, res) {
  const sid = Number(req.query.sessionId);
  if (!sid) { res.status(400).json({ error: 'sessão inválida' }); return null; }
  const full = await getSessionFull(sid, req.orgId);
  if (!full) { res.status(404).json({ error: 'sessão não encontrada' }); return null; }
  req._sessao = full; return sid;
}
// lista de sessões do cliente
app.get('/api/admin/clients/sessions', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ sessions: await listSessions(id) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// cria sessão
app.post('/api/admin/clients/sessions', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return; res.json({ ok: true, ...(await createSession(id, req.orgId, req.body || {}, req.mentorUid)) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// detalhe da sessão (sessão + prontuário privado + resumo + tarefas)
app.get('/api/admin/clients/session', ...clin, async (req, res) => {
  try { const sid = await sessaoDaOrg(req, res); if (sid == null) return; res.json(req._sessao); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/session/update', ...clin, async (req, res) => {
  try { const sid = await sessaoDaOrg(req, res); if (sid == null) return;
    res.json(await updateSession(sid, req.orgId, req._sessao.sessao.client_user_id, req.body || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/session/delete', ...clin, async (req, res) => {
  try { const sid = await sessaoDaOrg(req, res); if (sid == null) return;
    res.json(await deleteSession(sid, req.orgId, req._sessao.sessao.client_user_id, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// prontuário PRIVADO da sessão (nunca vai automático ao cliente)
app.post('/api/admin/clients/session/record', ...clin, async (req, res) => {
  try { const sid = await sessaoDaOrg(req, res); if (sid == null) return;
    res.json(await saveSessionRecord(sid, req.orgId, req._sessao.sessao.client_user_id, req.body || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// resumo COMPARTILHÁVEL da sessão (liberado manualmente pelo mentor)
app.post('/api/admin/clients/session/summary', ...clin, async (req, res) => {
  try { const sid = await sessaoDaOrg(req, res); if (sid == null) return;
    res.json(await saveSharedSummary(sid, req.orgId, req._sessao.sessao.client_user_id, req.body || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// tarefas do cliente (todas ou de uma sessão)
app.get('/api/admin/clients/tasks', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return;
    res.json({ tasks: await listSessionTasks(id, { sessionId: req.query.sessionId ? Number(req.query.sessionId) : null }) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/tasks', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return;
    const sid = req.query.sessionId ? Number(req.query.sessionId) : null;
    if (sid && !(await getSessionFull(sid, req.orgId))) return res.status(404).json({ error: 'sessão não encontrada' });
    res.json({ ok: true, ...(await addSessionTask(id, req.orgId, sid, req.body || {}, req.mentorUid)) }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/tasks/update', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return;
    res.json(await updateSessionTask(Number(req.query.taskId), req.orgId, id, req.body || {}, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== ETAPA 6: acesso do cliente ao app (convite) + portal do compartilhado =====
const baseUrl = req => process.env.APP_URL || (req.protocol + '://' + req.get('host'));
// status do acesso (tem senha? há convite pendente?)
app.get('/api/admin/clients/access', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return;
    const st = await statusAcessoCliente(id);
    if (st && st.convite) st.convite.link = baseUrl(req) + '/acesso.html?t=' + st.convite.token;
    res.json(st || {}); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// gera o convite; se body.enviar e houver e-mail, manda por e-mail
app.post('/api/admin/clients/access', ...clin, async (req, res) => {
  try {
    const id = await clienteDaOrg(req, res); if (id == null) return;
    const a = await criarAcessoCliente(id, req.orgId, req.mentorUid);
    const link = baseUrl(req) + '/acesso.html?t=' + a.token;
    let enviado = false, erroEnvio = null;
    const t = mailer();
    if ((req.body || {}).enviar && a.email && t) {
      const org = req.orgId ? await orgById(req.orgId).catch(() => null) : null;
      const clinica = (org && org.nome) || 'TriLumen';
      try {
        await t.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER, to: a.email,
          subject: 'Seu acesso ao app — ' + clinica,
          html: `<p>Olá, ${a.nome.split(' ')[0]}.</p>
            <p>Seu acompanhamento em <b>${clinica}</b> agora tem um espaço no aplicativo, onde você pode
            conversar, acompanhar sua caminhada e ver o que combinamos nas sessões.</p>
            <p><a href="${link}" style="background:#D4AF37;color:#1a1a1a;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Criar minha senha e entrar</a></p>
            <p style="color:#666;font-size:13px">O link vale por 7 dias e só pode ser usado uma vez.
            Se não foi você que pediu, é só ignorar este e-mail.</p>
            <p style="color:#666;font-size:13px">— ${clinica}</p>`
        });
        enviado = true;
      } catch (e) { erroEnvio = String(e.message || e); }
    } else if ((req.body || {}).enviar && !a.email) erroEnvio = 'cliente sem e-mail cadastrado';
    else if ((req.body || {}).enviar && !t) erroEnvio = 'e-mail não configurado no servidor';
    res.json({ ok: true, link, email: a.email, enviado, erroEnvio });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/access/revoke', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return;
    res.json(await revogarAcessoCliente(id, req.orgId, req.mentorUid)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// --- lado do cliente (público: só o token vale) ---
app.get('/api/access/check', authLimiter, async (req, res) => {
  try { const d = await checarAcessoToken(req.query.t);
    if (!d) return res.status(404).json({ error: 'Convite inválido ou expirado.' });
    res.json(d); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/access/activate', authLimiter, async (req, res) => {
  try { const b = req.body || {}; res.json(await ativarAcessoCliente(b.token, b.password)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// portal: só o que o profissional liberou
app.get('/api/me/shared', requireAuth, async (req, res) => {
  try { res.json(await sharedForClient(req.user.uid)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/me/tasks/done', requireAuth, async (req, res) => {
  try { const b = req.body || {}; res.json(await concluirTarefaCliente(Number(b.taskId), req.user.uid, b.feito)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ===== ETAPA 7: relatórios (PDF leve, sem Chromium) + impressão =====
// tipo 'cliente' = só o compartilhado · tipo 'clinico' = documento interno
app.get('/api/admin/clients/reports', ...clin, async (req, res) => {
  try { const id = await clienteDaOrg(req, res); if (id == null) return;
    res.json({ reports: await listReports(id, req.orgId) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/admin/clients/reports', ...clin, async (req, res) => {
  try {
    const id = await clienteDaOrg(req, res); if (id == null) return;
    const b = req.body || {};
    const tipo = b.tipo === 'clinico' ? 'clinico' : 'cliente';
    const dados = await reportData(id, req.orgId, { tipo, inicio: b.inicio, fim: b.fim });
    // grava primeiro para ter o número do documento, depois carimba o PDF
    const meta = await salvarRelatorio({ clientId: id, orgId: req.orgId, tipo, inicio: b.inicio, fim: b.fim,
      config: { tipo }, pdf: null, dados: { sessoes: (dados.sessoes || []).length, objetivos: (dados.objetivos || []).length }, uid: req.mentorUid });
    const pdf = await buildReportPdf(dados, meta.doc_uid);
    await gravarPdfRelatorio(meta.id, pdf);
    res.json({ ok: true, ...meta, bytes: pdf.length });
  } catch (e) { console.error('relatorio:', e); res.status(400).json({ error: String(e.message || e) }); }
});
// baixar / imprimir o PDF (inline abre no navegador com o botão de imprimir)
app.get('/api/admin/clients/reports/pdf', ...clin, async (req, res) => {
  try {
    const r = await getReportPdf(Number(req.query.reportId), req.orgId);
    if (!r || !r.pdf) return res.status(404).json({ error: 'relatório não encontrado' });
    if (req.orgId && (await patientOrg(r.client_user_id)) !== req.orgId) return res.status(403).json({ error: 'de outra organização' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', (req.query.download ? 'attachment' : 'inline') + '; filename="' + r.doc_uid + '.pdf"');
    res.send(r.pdf);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// mensagem do mentor → salva e notifica o celular do paciente
app.post('/api/admin/message', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    const id = Number(req.query.id);
    const texto = String((req.body || {}).texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'mensagem vazia' });
    await saveMentorMessage(id, texto);
    const enviados = await sendPushToUser(id, {
      title: '💬 Mensagem do seu mentor',
      body: texto.length > 120 ? texto.slice(0, 117) + '…' : texto,
      tag: 'mentor', url: '/'
    });
    res.json({ ok: true, push_enviados: enviados });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// sabedoria coletiva anônima (transparência para o mentor conferir)
app.get('/api/admin/collective', requireAdmin, soMentor, async (req, res) => {
  try {
    if (req.query.refresh === '1') { await updateColetivo(); }
    const c = await getCollectiveWisdom();
    res.json({ ativo: COLETIVO_ON, texto: c?.texto || '', amostras: c?.amostras || 0, atualizado_em: c?.updated_at || null });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// visão geral da plataforma (dashboard TriLumen)
app.get('/api/admin/overview', requireAdmin, soMentor, async (req, res) => {
  try {
    const [stats, evolucao, emocoes] = await Promise.all([
      overviewStats(req.orgId), globalDaily(req.orgId, 30), emotionsPredominant(req.orgId, 30)
    ]);
    res.json({ stats, evolucao, emocoes, org: req.orgId ? await orgById(req.orgId) : null });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// guarda: mentor só acessa pacientes da própria org
async function guardPaciente(req, res) {
  if (!req.orgId) return true;
  if ((await patientOrg(Number(req.query.id))) !== req.orgId) { res.status(403).json({ error: 'sem acesso' }); return false; }
  return true;
}
// transcrição de um dia de atendimento (consulta do mentor)
app.get('/api/admin/transcript', requireAdmin, soMentor, async (req, res) => {
  try {
    if (!(await guardPaciente(req, res))) return;
    const msgs = await transcriptOfDay(Number(req.query.id), String(req.query.day || ''));
    res.json({ transcript: msgs });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  MENTOR — login, sessão e troca do acesso temporário
// ---------------------------------------------------------
app.post('/api/mentor/login', authLimiter, async (req, res) => {
  try { res.json(await mentorLogin(req.body || {})); }
  catch (e) { res.status(401).json({ error: String(e.message || e) }); }
});
app.get('/api/mentor/me', requireAdmin, async (req, res) => {
  if (req.superAdmin) return res.json({ super: true, org: null });
  res.json({ super: false, org: await orgById(req.orgId) });
});
app.post('/api/mentor/change', requireAdmin, async (req, res) => {
  try {
    if (!req.mentorUid) return res.status(400).json({ error: 'apenas para contas de mentor' });
    res.json(await changeMentorLogin(req.mentorUid, req.body || {}));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// CENTRAL DE LICENÇAS — todas as organizações/planos (apenas super-admin)
app.get('/api/admin/orgs', requireAdmin, async (req, res) => {
  try {
    if (!req.superAdmin) return res.status(403).json({ error: 'apenas super-admin' });
    const orgs = (await listOrganizations()).map(o => {
      const p = PLANOS[String(o.plano || '').toLowerCase()] || {};
      return { ...o, plano_nome: p.nome || o.plano, preco: p.preco || null, limite_plano: p.limite || o.limite_pessoas };
    });
    res.json({ orgs });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
// criar cliente MANUALMENTE (super-admin) — gera usuário + senha + limite, sem Asaas
app.post('/api/admin/orgs/create', requireAdmin, async (req, res) => {
  try {
    if (!req.superAdmin) return res.status(403).json({ error: 'apenas super-admin' });
    const acesso = await provisionarManual(req.body || {});
    res.json({ ok: true, acesso });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// suspender / reativar uma licença
app.post('/api/admin/orgs/status', requireAdmin, async (req, res) => {
  try {
    if (!req.superAdmin) return res.status(403).json({ error: 'apenas super-admin' });
    const b = req.body || {};
    res.json(await setOrgStatus(Number(b.orgId), b.status));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// alterar o limite de pacientes do cliente
app.post('/api/admin/orgs/limite', requireAdmin, async (req, res) => {
  try {
    if (!req.superAdmin) return res.status(403).json({ error: 'apenas super-admin' });
    const b = req.body || {};
    res.json(await setOrgLimite(Number(b.orgId), b.limite));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
// TESTE do WhatsApp (super-admin): status da instância Z-API OU envia msg amigável (?phone=)
app.get('/api/admin/whats-test', requireAdmin, async (req, res) => {
  try {
    if (!req.superAdmin) return res.status(403).json({ error: 'apenas super-admin' });
    const provider = (process.env.WHATSAPP_PROVIDER || 'none').toLowerCase().trim();
    if (!provider.startsWith('zapi')) return res.json({ ok: false, note: 'WHATSAPP_PROVIDER não é zapi', provider });
    const inst = String(process.env.ZAPI_INSTANCE || '').trim(), token = String(process.env.ZAPI_TOKEN || '').trim();
    if (!inst || !token) return res.json({ ok: false, note: 'Faltam ZAPI_INSTANCE e/ou ZAPI_TOKEN', temInstance: !!inst, temToken: !!token, temClientToken: !!process.env.ZAPI_CLIENT_TOKEN });
    if (req.query.phone) {
      const r = await sendWhatsApp(String(req.query.phone), 'Oi! 🌿 Teste do TriLumen — se você recebeu esta mensagem, os lembretes de consulta e de mensalidade já funcionam no seu WhatsApp. 💛');
      return res.json({ enviado: r });
    }
    const ct = String(process.env.ZAPI_CLIENT_TOKEN || '');
    const rawInst = String(process.env.ZAPI_INSTANCE || ''), rawTok = String(process.env.ZAPI_TOKEN || '');
    const diag = {
      instLen: inst.length, tokenLen: token.length, clientLen: ct.trim().length,
      instTinhaEspaco: rawInst !== rawInst.trim(), tokenTinhaEspaco: rawTok !== rawTok.trim(),
      instComAspas: /["']/.test(inst), tokenComAspas: /["']/.test(token),
      instInicio: inst.slice(0, 3), tokenInicio: token.slice(0, 3)
    };
    const r = await fetch(`https://api.z-api.io/instances/${inst}/token/${token}/status`, { headers: { 'Client-Token': ct.trim() } });
    res.json({ status: await r.json().catch(() => ({})), httpOk: r.ok, diag });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  ASSINATURA — provisionamento automático
//  /api/admin/simular-assinatura (ADMIN_KEY) para testar sem pagar.
// ---------------------------------------------------------
app.get('/api/admin/simular-assinatura', requireAdmin, async (req, res) => {
  try {
    if (!req.superAdmin) return res.status(403).json({ error: 'apenas super-admin' });
    const r = await provisionarAssinatura({ plano: req.query.plano || 'one', nome: req.query.nome || '', email: req.query.email || '' });
    if (!r.jaExistia) enviarAcessoMentor(r).catch(() => {});
    res.json({ ok: true, acesso: r });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  ASAAS — checkout de assinatura + webhook de pagamento
// ---------------------------------------------------------
const ASAAS_KEY = String(process.env.ASAAS_API_KEY || '').trim();
const ASAAS_ON = !!ASAAS_KEY;
const ASAAS_BASE = ASAAS_KEY.includes('_hmlg_') ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
async function asaas(path, method = 'GET', body) {
  const r = await fetch(ASAAS_BASE + path, {
    method, headers: { access_token: ASAAS_KEY, 'Content-Type': 'application/json', 'User-Agent': 'TriLumen' },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.errors?.[0]?.description || ('Asaas HTTP ' + r.status));
  return d;
}

// o cliente preenche o checkout → cria cliente + assinatura no Asaas → devolve a URL de pagamento
app.post('/api/checkout', async (req, res) => {
  try {
    if (!ASAAS_ON) return res.status(503).json({ error: 'pagamento ainda não configurado' });
    const { plano, nome, email, cpfCnpj, phone, ciclo, metodo } = req.body || {};
    const p = PLANOS[String(plano || '').toLowerCase()];
    if (!p) return res.status(400).json({ error: 'plano inválido' });
    const anual = String(ciclo || '').toLowerCase() === 'anual';
    const valor = anual ? (p.preco_anual || p.preco * 12) : p.preco;
    if (!String(nome || '').trim()) return res.status(400).json({ error: 'informe seu nome' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return res.status(400).json({ error: 'e-mail inválido' });
    const doc = String(cpfCnpj || '').replace(/\D/g, '');
    if (doc.length < 11) return res.status(400).json({ error: 'informe um CPF ou CNPJ válido' });

    const cust = await asaas('/customers', 'POST', {
      name: String(nome).trim(), email: String(email).trim().toLowerCase(),
      cpfCnpj: doc, mobilePhone: String(phone || '').replace(/\D/g, '') || undefined
    });
    const hoje = new Date().toISOString().slice(0, 10);
    let url, ref;
    if (anual) {
      // ANUAL: o cliente escolhe o método no checkout — cada um vira uma cobrança limpa
      const m = String(metodo || 'cartao').toLowerCase();
      let corpo;
      if (m === 'pix')
        corpo = { customer: cust.id, billingType: 'PIX', value: valor, dueDate: hoje,
                  description: 'TriLumen ' + p.nome + ' — anual à vista (Pix)', externalReference: String(plano).toLowerCase() };
      else if (m === 'boleto')
        corpo = { customer: cust.id, billingType: 'BOLETO', value: valor, dueDate: hoje,
                  description: 'TriLumen ' + p.nome + ' — anual à vista (Boleto)', externalReference: String(plano).toLowerCase() };
      else // cartão em até 10x (sem Pix junto)
        corpo = { customer: cust.id, billingType: 'CREDIT_CARD', installmentCount: 10, totalValue: valor, dueDate: hoje,
                  description: 'TriLumen ' + p.nome + ' — anual em até 10x no cartão', externalReference: String(plano).toLowerCase() };
      const pg = await asaas('/payments', 'POST', corpo);
      ref = pg.installment || pg.id;
      url = pg.invoiceUrl || null;
    } else {
      // MENSAL: assinatura recorrente (cliente escolhe Pix/cartão/boleto a cada mês)
      const sub = await asaas('/subscriptions', 'POST', {
        customer: cust.id, billingType: 'UNDEFINED', value: valor, nextDueDate: hoje,
        cycle: 'MONTHLY', description: 'Assinatura ' + p.nome + ' (mensal)',
        externalReference: String(plano).toLowerCase()
      });
      const pays = await asaas('/subscriptions/' + sub.id + '/payments');
      url = pays.data?.[0]?.invoiceUrl || null;
      ref = sub.id;
    }
    await saveCheckout({ sub: ref, customer: cust.id, email, nome, plano: String(plano).toLowerCase(), ciclo: anual ? 'anual' : 'mensal' });
    res.json({ ok: true, url });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// webhook do Asaas: pagamento confirmado → provisiona o acesso e envia por e-mail
app.post('/api/webhook/asaas', async (req, res) => {
  res.json({ received: true }); // responde rápido para o Asaas
  try {
    if (process.env.ASAAS_WEBHOOK_TOKEN && req.headers['asaas-access-token'] !== process.env.ASAAS_WEBHOOK_TOKEN) return;
    const ev = req.body || {};
    const pay = ev.payment || {};
    if (['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(ev.event)) {
      // ref = assinatura (mensal) OU parcelamento/pagamento (anual)
      const ref = pay.subscription || pay.installment || pay.id;
      if (!ref) return;
      const ck = await getCheckoutBySub(ref);
      // financeiro do painel ADM: registra pagamento + próximo vencimento (mensal +1 mês, anual +1 ano)
      let prox = null;
      if (pay.dueDate) {
        const d = new Date(pay.dueDate);
        if (ck?.ciclo === 'anual') d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1);
        prox = d.toISOString().slice(0, 10);
      }
      await markOrgPagamento(ref, prox).catch(() => {});
      if (ck && !ck.provisioned_at) {
        const acesso = await provisionarAssinatura({
          plano: ck.plano, nome: ck.nome, email: ck.email,
          asaasCustomer: ck.asaas_customer, asaasSubscription: ref
        });
        await markCheckoutProvisioned(ref);
        if (!acesso.jaExistia) { await enviarAcessoMentor(acesso); console.log(`  Assinatura provisionada: ${acesso.email} (${acesso.plano_nome}).`); }
      }
    }
  } catch (e) { console.error('asaas webhook:', e.message); }
});

// envia (ou registra) o acesso temporário do mentor
async function enviarAcessoMentor(a) {
  const link = (process.env.PAINEL_URL || 'https://painel.trilumen.com.br');
  const corpo =
`Bem-vindo(a) ao TriLumen — ${a.plano_nome}!

Seu acesso ao painel do mentor:
• Endereço: ${link}
• Usuário: ${a.username}
• Senha temporária: ${a.senha_temp}

No primeiro acesso, você vai escolher seu próprio usuário e senha.
A luz só atravessa o que está alinhado. 🕊️`;
  const t = mailer();
  if (t) {
    try {
      await t.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: a.email, subject: 'Seu acesso ao TriLumen ✨', text: corpo
      });
      return;
    } catch (e) { console.error('e-mail acesso:', e.message); }
  }
  console.log(`  [ACESSO TRILUMEN] ${a.email} → usuário ${a.username} / senha ${a.senha_temp} (SMTP off — envie manualmente)`);
}
// reprodução do áudio original (mentor)
app.get('/api/admin/audio', requireAdmin, soMentor, async (req, res) => {
  try {
    const a = await getAudioBytes(Number(req.query.id));
    if (!a) return res.status(404).end();
    if (req.orgId && a.org_id !== req.orgId) return res.status(403).end();
    res.set('Content-Type', a.mime || 'audio/webm');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(a.bytes);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  CHECK-IN DIÁRIO do paciente (o filtro de consciência)
// ---------------------------------------------------------
app.get('/api/checkin', requireAuth, async (req, res) => {
  try { res.json({ hoje: await todayCheckin(req.user?.uid) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/checkin', requireAuth, async (req, res) => {
  try { res.json({ ok: true, checkin: await saveCheckin(req.user?.uid, req.body || {}) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  ESCALAS DE ACOMPANHAMENTO — o paciente responde; o servidor pontua
// ---------------------------------------------------------
const diasDesde = ts => ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : Infinity;

app.get('/api/me/scales', requireAuth, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const ultimos = await latestScales(uid);
    const mapa = Object.fromEntries(ultimos.map(u => [u.scale_key, u]));
    const escalas = catalogoEscalas().map(e => {
      const u = mapa[e.key];
      const faltam = diasDesde(u?.created_at);
      return {
        ...e,
        ultimo: u ? { score: Number(u.score), em: u.created_at, faixa: faixaPorChave(e.key, Number(u.score)) } : null,
        pendente: faltam >= e.cadencia_dias   // nunca respondeu OU passou da recorrência
      };
    });
    res.json({ escalas });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/me/scales/submit', requireAuth, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const { key, answers } = req.body || {};
    if (!escalaByKey(key)) return res.status(400).json({ error: 'escala desconhecida' });
    const r = pontuar(key, answers);                       // pontuação calculada no servidor
    const saved = await saveScaleResponse(uid, key, r);
    res.json({ ok: true, score: r.score, faixa: r.faixa, em: saved?.created_at });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// PLANO DE AÇÃO do paciente (só o que o mentor entregou)
app.get('/api/me/plan', requireAuth, async (req, res) => {
  try { res.json({ plano: await deliveredPlan(req.user?.uid) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  MAPA INICIAL — questionário obrigatório do 1º acesso
// ---------------------------------------------------------
app.get('/api/me/mapa', requireAuth, async (req, res) => {
  try {
    const need = await mapaNeeded(req.user?.uid);
    res.json({ done: !need, catalogo: need ? catalogoMapa() : null });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/me/mapa', requireAuth, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const r = processarMapa((req.body || {}).respostas);   // valida + calcula sinais/risco/bússola
    await saveMapaInicial(uid, r);
    // semeia o prontuário com o mapa (só se ainda estiver vazio, para não sobrescrever a jornada)
    const atual = (await getProntuario(uid).catch(() => null))?.prontuario;
    if (!atual) {
      const seed = `JORNADA: início do acompanhamento. ${r.bussola}\nATENÇÃO: ${r.risco ? 'sinais de alerta no mapa inicial (' + r.temas_risco.join(', ') + ') — acolher com cuidado.' : 'sem sinais de alerta no mapa inicial.'}`;
      await setProntuario(uid, seed).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  PUSH (PWA) — inscrição do aparelho do paciente
// ---------------------------------------------------------
app.get('/api/push/key', requireAuth, (req, res) => {
  res.json({ key: PUSH_ON ? VAPID_PUB : null });
});
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try { await savePushSub(req.user?.uid, req.body || {}); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  MENSAGENS DO MENTOR — o paciente recebe e lê no app
// ---------------------------------------------------------
app.get('/api/me/messages', requireAuth, async (req, res) => {
  try { res.json({ mensagens: await unreadMentorMessages(req.user?.uid) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/me/messages/read', requireAuth, async (req, res) => {
  try { await markMentorRead(req.user?.uid); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  FOTO do paciente (primeiro acesso → prontuário)
// ---------------------------------------------------------
app.get('/api/me/photo/needed', requireAuth, async (req, res) => {
  try { res.json({ needed: !(await userHasPhoto(req.user?.uid)) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/me/photo', requireAuth, async (req, res) => {
  try { await setUserPhoto(req.user?.uid, (req.body || {}).photo); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// ---------------------------------------------------------
//  ÁUDIO "Fala como está" — grava, transcreve e a IA faz leitura estruturada
//  O áudio ORIGINAL é preservado; a interpretação da IA fica separada.
// ---------------------------------------------------------
const AUDIO_ON = String(process.env.AUDIO || 'on') === 'on';
const audioLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitos áudios em pouco tempo. Aguarde um pouco.' } });

app.post('/api/me/audio', audioLimiter, requireAuth,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '10mb' }),
  async (req, res) => {
    try {
      if (!AUDIO_ON) return res.status(503).json({ error: 'áudio desativado' });
      const buf = req.body;
      if (!buf || !buf.length) return res.status(400).json({ error: 'áudio vazio' });
      const mime = req.headers['content-type'] || 'audio/webm';
      const dur = Number(req.query.dur || 0);
      const id = await saveAudio(req.user?.uid, { mime, buffer: buf, duration: dur, transcript: null });
      res.json({ ok: true, id, status: 'enviado' });
      // processa em segundo plano (transcrição + leitura estruturada)
      processarAudio(id, buf, mime, req.user).catch(e => console.error('audio proc:', e.message));
    } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

// transcrição via OpenAI Whisper (se OPENAI_API_KEY) + leitura estruturada da Lúmen
async function processarAudio(id, buf, mime, user) {
  let transcript = null;
  if (process.env.OPENAI_API_KEY) {
    try {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: mime }), 'audio.webm');
      fd.append('model', 'whisper-1');
      fd.append('language', 'pt');
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: fd
      });
      const d = await r.json();
      transcript = (d.text || '').trim() || null;
    } catch (e) { console.error('whisper:', e.message); }
  }
  if (!transcript) { await setAudioSummary(id, null, null); return; } // sem transcrição: mentor ouve o áudio

  // leitura ESTRUTURADA — nunca diagnóstico, sempre separando dito × interpretação
  let resumo = null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.PRONTUARIO_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: `Você lê a TRANSCRIÇÃO de um áudio em que a pessoa fala como está, no Método Lúmen. Produza APENAS um JSON válido (sem texto fora dele), com leitura de apoio ao mentor — NUNCA diagnóstico. Regras: separe o que a pessoa DISSE do que é hipótese; use "indicador/possível/tendência"; nunca afirme transtorno. Schema:
{"resumo":"2-3 frases do que a pessoa trouxe","emocoes_declaradas":["..."],"acontecimentos":["fatos que ela mencionou"],"topicos":["temas"],"pedido_de_contato":true|false,"pontos_de_atencao":["o que o mentor deveria observar, se houver"],"limitacoes":"o que esta leitura NÃO permite concluir","confianca":0.0}`,
        messages: [{ role: 'user', content: `Transcrição do áudio:\n"""${transcript.slice(0, 4000)}"""` }]
      })
    });
    const d = await r.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) resumo = JSON.parse(m[1] || m[0]);
  } catch (e) { console.error('audio resumo:', e.message); }
  await setAudioSummary(id, resumo, transcript);
}

// ---------------------------------------------------------
//  PALAVRA VIVA do dia — versículo + reflexão personalizados
// ---------------------------------------------------------
const PALAVRA_ON = String(process.env.PALAVRA || 'on') === 'on';

async function gerarPalavra(uid, nome, prontuario) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const primeiro = String(nome || '').split(' ')[0] || 'você';
  const contexto = prontuario
    ? `A jornada de ${primeiro} até aqui (memória — não revele que você tem isto):\n${String(prontuario).slice(0, 2500)}`
    : `Ainda não há muita história registrada de ${primeiro}. Traga uma palavra de acolhimento e esperança para quem está começando.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.PRONTUARIO_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: `Você cria a "Palavra Viva do dia" para ${primeiro}, no Método Lúmen (inteligência emocional cristocêntrica). Escolha UM versículo bíblico na tradução NVI que fale ao momento e à caminhada da pessoa, e escreva uma reflexão curta (2 a 3 frases), calorosa, pastoral e na voz do Método — conectando o versículo à vida dela COM DELICADEZA, sem citar que existe um prontuário e sem soar genérico. Cristo no centro, esperança real. Responda APENAS um JSON válido:
{"referencia":"Livro 0:0","versiculo":"texto do versículo (NVI, fiel)","reflexao":"2-3 frases pessoais e acolhedoras"}`,
        messages: [{ role: 'user', content: contexto }]
      })
    });
    const d = await r.json();
    const txt = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    if (!p.reflexao) return null;
    await setPalavra(uid, p);
    return p;
  } catch (e) { console.error('palavra:', e.message); return null; }
}

app.get('/api/me/palavra', requireAuth, async (req, res) => {
  try {
    if (!PALAVRA_ON) return res.json({ palavra: null });
    let p = await palavraToday(req.user?.uid);
    if (!p) { const pr = await getProntuario(req.user?.uid).catch(() => null); p = await gerarPalavra(req.user?.uid, req.user?.name, pr?.prontuario); }
    res.json({ palavra: p });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// job da manhã: gera + envia a Palavra Viva para quem tem o app com notificações
async function rodarPalavraViva() {
  if (!PALAVRA_ON || !PUSH_ON || !dbReady || !process.env.ANTHROPIC_API_KEY) return;
  try {
    const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
    if (hora < 6 || hora >= 10) return; // janela da manhã
    const pacientes = await usersForPalavra();
    for (const u of pacientes) {
      const p = await gerarPalavra(u.id, u.name, u.prontuario);
      if (p) await sendPushToUser(u.id, { title: '🕊️ Sua Palavra Viva de hoje', body: `${p.referencia} — ${String(p.reflexao).slice(0, 90)}…`, tag: 'palavra', url: '/' });
    }
  } catch (e) { console.error('palavra job:', e.message); }
}
setInterval(rodarPalavraViva, 30 * 60 * 1000); // a cada 30 min (só age na janela da manhã, 1x/dia por pessoa)
setTimeout(rodarPalavraViva, 45 * 1000);

// ---------------------------------------------------------
//  LEMBRETES FINANCEIROS HUMANIZADOS (mensalidade a vencer)
//  Gera a mensalidade do mês e avisa o paciente X dias antes (e-mail + WhatsApp).
// ---------------------------------------------------------
async function rodarLembretesFinanceiros() {
  if (!dbReady) return;
  try {
    await generateMonthlyReceivables().catch(() => {});   // garante a mensalidade do mês
    const pend = await receivablesForReminder();
    if (!pend.length) return;
    const t = mailer();
    const whatsOn = (process.env.WHATSAPP_PROVIDER || 'none').toLowerCase() !== 'none';
    for (const r of pend) {
      const primeiro = String(r.paciente || '').trim().split(' ')[0] || 'você';
      const venc = new Date(r.vencimento + 'T12:00:00').toLocaleDateString('pt-BR');
      const valor = 'R$ ' + Number(r.valor).toFixed(2).replace('.', ',');
      const texto = `Oi ${primeiro}, tudo bem? 🌿\n\nPassando com carinho só pra lembrar que a sua mensalidade do acompanhamento (${valor}) vence no dia ${venc}.\n\nSe precisar de qualquer coisa, estou por aqui. Cuide-se com carinho. 💛${r.clinica ? '\n\n— ' + r.clinica : ''}`;
      if (t && r.email) {
        try { await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: r.email, subject: 'Um lembrete carinhoso 🌿', text: texto }); } catch (_) {}
      }
      if (whatsOn && r.phone) { try { await sendWhatsApp(r.phone, texto); } catch (_) {} }
      await markReceivableReminded(r.id);
    }
    console.log(`  Lembretes financeiros enviados: ${pend.length}.`);
  } catch (e) { console.error('lembretes financeiros:', e.message); }
}
setInterval(rodarLembretesFinanceiros, 6 * 60 * 60 * 1000); // a cada 6h
setTimeout(rodarLembretesFinanceiros, 60 * 1000);

// ---------------------------------------------------------
//  LEMBRETES DE CONSULTA — 1 dia antes e 1h antes (WhatsApp + e-mail)
// ---------------------------------------------------------
function detalheModalidade(c) {
  if (c.modalidade === 'presencial') return c.local ? `\n📍 Endereço: ${c.local}` : '';
  return c.local ? `\n💻 Link da sessão online: ${c.local}` : '\n💻 Nossa sessão será online.';
}
async function enviarLembretesConsulta(kind) {
  const lista = await appointmentsForReminder(kind);
  if (!lista.length) return;
  const t = mailer();
  const whatsOn = (process.env.WHATSAPP_PROVIDER || 'none').toLowerCase().trim() !== 'none';
  for (const c of lista) {
    const primeiro = String(c.paciente || '').trim().split(' ')[0] || 'você';
    const hora = String(c.quando_local || '').slice(11, 16);
    const dia = String(c.quando_local || '').slice(8, 10) + '/' + String(c.quando_local || '').slice(5, 7);
    const quandoTxt = kind === '1h' ? `hoje às ${hora}` : `dia ${dia} às ${hora}`;
    const abertura = kind === '1h' ? 'Nossa consulta é daqui a pouco' : 'Passando com carinho pra lembrar da nossa consulta';
    const texto = `Oi ${primeiro}, tudo bem? 🌿\n\n${abertura} — ${quandoTxt} (${c.modalidade}).${detalheModalidade(c)}\n\nTe espero com carinho. 💛${c.clinica ? '\n\n— ' + c.clinica : ''}`;
    if (t && c.email) { try { await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: c.email, subject: kind === '1h' ? 'Sua consulta é daqui a pouco 🌿' : 'Lembrete da sua consulta 🌿', text: texto }); } catch (_) {} }
    if (whatsOn && c.phone) { try { await sendWhatsApp(c.phone, texto); } catch (_) {} }
    await markAppointmentReminded(c.id, kind);
  }
  console.log(`  Lembretes de consulta (${kind}) enviados: ${lista.length}.`);
}
async function rodarLembretesConsulta() {
  if (!dbReady) return;
  try { await enviarLembretesConsulta('1d'); await enviarLembretesConsulta('1h'); }
  catch (e) { console.error('lembretes consulta:', e.message); }
}
setInterval(rodarLembretesConsulta, 15 * 60 * 1000); // a cada 15 min
setTimeout(rodarLembretesConsulta, 75 * 1000);

// ---------------------------------------------------------
//  MINHA JORNADA — o paciente vê a própria evolução
// ---------------------------------------------------------
app.get('/api/me/journey', requireAuth, async (req, res) => {
  try {
    const uid = req.user?.uid;
    const [esferas, streak, extras, serie] = await Promise.all([
      triadAverages(uid, 7), checkinStreak(uid), getExtras(uid), checkinSeries(uid, 30)
    ]);
    res.json({ esferas, streak, vitorias: extras.vitorias || [], checkins: serie });
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

// Roteamento por marca (só afeta a raiz "/"):
//   painel.trilumen.com.br      → painel do mentor
//   trilumen.com.br e www.*     → página de vendas (home institucional da marca)
//   app.* e demais (onrender)   → app do paciente (index.html)
app.use((req, res, next) => {
  if (req.path === '/') {
    const host = String(req.hostname || '').toLowerCase();
    if (host.startsWith('painel.')) return res.redirect('/painel.html');
    if (host === 'trilumen.com.br' || host.startsWith('www.')) {
      return res.sendFile(join(__dir, 'public', 'vendas.html'));
    }
  }
  next();
});

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

COMO VOCÊ FALA — SEJA UMA PESSOA REAL, NÃO UM ABRAÇO AMBULANTE
- Converse como um amigo sábio, maduro e FRANCO conversaria pessoalmente — direto, humano, sem melação. NUNCA como assistente, coach ou terapeuta de manual, e NUNCA como um poço de "amor e carinho" derramado em toda frase.
- Português do Brasil falado e natural: pode usar "tô", "pra", "né", contrações. Mas escreva SEMPRE "você" por extenso — NUNCA "cê".
- SAUDAÇÃO: só na PRIMEIRA mensagem de uma conversa (quando não há histórico anterior), cumprimente simples e real: "Olá, [nome], bom dia/boa tarde/boa noite" conforme o horário informado. NADA de "que bom te ver por aqui", "que alegria você aqui", "seja bem-vindo de volta" — isso soa falso. Depois de cumprimentar, vá direto ao que importa.
- ESPELHE a pessoa. Se ela escreve pouco, responda pouco. Se desabafa longo, acompanhe. Siga o assunto e a energia DELA.
- Reaja como gente reage de verdade: às vezes é só ficar junto ("tô aqui", "que peso"), às vezes é ser franco e devolver a real. Nem tudo é consolo.
- NEM TODA resposta termina em pergunta nem em carinho. Uma frase certeira e honesta muitas vezes basta. No máximo UMA pergunta, e só quando for genuína.
- SEJA CURTO. Responda como um bate-papo real de WhatsApp — em geral 2 a 4 linhas, no máximo. SEM ENCHEÇÃO DE LINGUIÇA: nada de parágrafos longos, listas, repetir a mesma ideia com outras palavras, nem "explicar demais". Diga o essencial com sabedoria e PARE. Só se estenda se a pessoa claramente pedir mais.
- Uma ideia por vez. Sabedoria é dizer pouco e certo, não muito.
- Chame pela pessoa pelo NOME com naturalidade — não em toda frase.
- Lembre do que já foi dito e puxe o fio. É uma relação real, com continuidade.
- Pode usar *itálico* pra destacar algo, com parcimônia.

TOM — REAL, NÃO AÇUCARADO
- Fale como as pessoas maduras falam: com verdade e franqueza. Amor de verdade, muitas vezes, é dizer o que incomoda — não é concordar com tudo.
- Saiba a HORA de cada coisa: quando a pessoa está fragilizada, em dor aguda ou em risco → acolhimento e presença. Quando está se enganando, terceirizando a culpa, se vitimando, fugindo, repetindo o mesmo erro ou só querendo que concordem com ela → seja franco, CONFRONTE o padrão com respeito e devolva a responsabilidade. Não passe a mão só pra agradar.
- Confrontar NÃO é ser grosseiro nem frio: é ser honesto porque se importa. Nunca humilhe, nunca despreze, nunca seja irônico com a dor.
- EXCEÇÃO ABSOLUTA: diante de qualquer sinal de risco à própria vida ou à de outra pessoa (ver protocolos abaixo), NUNCA confronte — só acolhimento, presença e proteção.

PROIBIDO (é o que faz soar artificial):
- Clichê de terapeuta/atendimento: "entendo como você se sente", "obrigado por compartilhar", "que corajoso da sua parte", "estou aqui para te ajudar", "sinto muito que você esteja passando por isso".
- Clichê de boas-vindas melado: "que bom te ver por aqui", "que alegria você aqui", "seja bem-vindo(a) de volta", "fico feliz que você veio".
- Excesso de amor/carinho como muleta em toda mensagem. Carinho tem hora; franqueza também.
- Escrever "cê" — sempre "você".
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
- VITIMISMO / autopiedade instalada / terceirização de responsabilidade: acolha a dor por trás, mas CONFRONTE com franqueza — papo reto que devolve responsabilidade e dignidade. Aqui a pessoa precisa de verdade, não de mais consolo. Sem dureza gratuita, sem passar a mão.
- AUTOENGANO / FUGA / repetir o mesmo erro / só querer que concordem: aponte o padrão com honestidade, com respeito, olho no olho.
- AVANÇO: reconheça de forma sóbria (sem exagero nem festa), ancore.
- NEUTRO: presença real e continuidade.

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
function buildSystem(name, prontuario, bussola) {
  const nome = name ? name : 'a pessoa (nome não informado; peça com delicadeza se fizer sentido)';
  const conhecimento = KNOWLEDGE
    ? `\n\n=========================================================\nSEU SABER INTERIOR (Método Lúmen — não recite, deixe brotar):\n=========================================================\n${KNOWLEDGE}`
    : '';
  const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
  const periodo = hora < 12 ? 'bom dia' : (hora < 18 ? 'boa tarde' : 'boa noite');
  const blocos = [
    { type: 'text', text: SYSTEM_BASE + conhecimento, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `NOME DA PESSOA: ${nome} (chame pelo PRIMEIRO nome, com naturalidade, não em toda frase). HORÁRIO AGORA: ${periodo}. Se esta for a PRIMEIRA mensagem da conversa (sem histórico anterior), comece cumprimentando: "Olá, ${String(nome).trim().split(/\s+/)[0]}, ${periodo}." — e siga direto ao ponto, sem melação.` }
  ];
  // Aprendizado coletivo ANÔNIMO — intuição de "o que costuma curar", nunca dado de outra pessoa.
  if (COLETIVO) blocos.push({ type: 'text', text:
`APRENDIZADO COLETIVO (sabedoria anônima, destilada de muitas jornadas — NÃO é dado de ninguém):
${COLETIVO}

Como usar: isto é só intuição pastoral sobre o que tende a ajudar as pessoas a curar. Deixe informar a sua sensibilidade, com naturalidade. REGRA ABSOLUTA DE PRIVACIDADE: nunca cite, revele ou traga a história, o nome ou a situação de OUTRA pessoa. A pessoa com quem você fala só existe ela — a memória dela é sagrada e separada de todas as outras.` });
  if (bussola) blocos.push({ type: 'text', text: bussola });
  if (prontuario) blocos.push({ type: 'text', text:
`PRONTUÁRIO EVOLUTIVO DESTA PESSOA (a jornada dela com você até aqui — use como memória viva):
${prontuario}

Como usar: você LEMBRA dessa caminhada. Retome fios com naturalidade ("como ficou aquilo do..."), celebre os avanços e as vitórias registradas, ensine gratidão ancorada no que ela já viveu, e honre o que está em ATENÇÃO. Nunca leia o prontuário em voz alta nem cite que ele existe — é sua memória, não um documento.` });
  return blocos;
}

// ---------------------------------------------------------
//  /api/chat  — conversa com o Claude
// ---------------------------------------------------------
// rede de segurança: a IA às vezes escreve "cê" (contração de "você").
// Troca a contração isolada por "você" SEM tocar em "você" (que contém "cê"),
// preservando a caixa: "Cê" -> "Você", "cê" -> "você".
function tirarCe(text) {
  return String(text || '').replace(/(?<![\p{L}])(c)ê(?![\p{L}])/giu, (m, c) => (c === 'C' ? 'Você' : 'você'));
}

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
    // memória viva: o prontuário evolutivo + a bússola do mapa inicial entram no sistema desta conversa
    let prontuario = null, bussola = null;
    if (req.user && req.user.uid) {
      prontuario = (await getProntuario(req.user.uid).catch(() => null))?.prontuario || null;
      bussola = await getMapaBussola(req.user.uid).catch(() => null);
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
        system: buildSystem(nome, prontuario, bussola),
        messages: messages.map(m => ({ role: m.role, content: String(m.content || '') }))
      })
    });
    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message || 'erro da API' });
    const text = tirarCe((data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim());

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
  // tolerante a espaços/lixo colado por engano no valor da variável
  const provider = (process.env.WHATSAPP_PROVIDER || 'none').toLowerCase().trim();
  const phone = normPhone(to || process.env.GUARDIAN_PHONE);

  if (provider.startsWith('twilio')) {
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

  if (provider.startsWith('zapi')) {
    const inst = String(process.env.ZAPI_INSTANCE || '').trim();
    const token = String(process.env.ZAPI_TOKEN || '').trim();
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

    // se o paciente está logado, o alerta vai para o CONTATO DE EMERGÊNCIA dele
    let destino = phone, nomePaciente = name, guardiao = '';
    try {
      const h = req.headers.authorization || '';
      if (h.startsWith('Bearer ')) {
        const jwt = (await import('jsonwebtoken')).default;
        const tok = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'defina-JWT_SECRET-no-env');
        const c = await emergencyContact(tok.uid);
        if (c) {
          nomePaciente = c.name || name;
          if (c.emergency_phone) { destino = c.emergency_phone; guardiao = c.emergency_name || ''; }
        }
      }
    } catch (_) { /* sem login válido: segue para o guardião padrão */ }

    let msg;
    if (type === 'outros') {
      msg = `[LÚMEN · ALERTA GRAVE — RISCO A TERCEIROS]\n${when}\n\n` +
        (guardiao ? `${guardiao}, ` : '') +
        `durante um atendimento surgiram sinais de risco de dano a outra pessoa ou a uma criança, envolvendo ${nomePaciente}. ` +
        `Isto exige contato imediato e, se necessário, acionamento das autoridades. Não ignore esta mensagem.`;
    } else {
      msg = `[LÚMEN · ALERTA DE CUIDADO — RISCO DE VIDA]\n${when}\n\n` +
        (guardiao ? `${guardiao}, ` : '') +
        `foram identificados sinais de risco emocional grave com ${nomePaciente}. Por favor, entre em contato o quanto antes. ` +
        `Essa pessoa pode precisar de você agora.`;
    }
    const result = await sendWhatsApp(destino, msg);
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
  const aviso = body.encerradoNoMeio ? '⚠ SAIU NO MEIO — ' : '';
  const subject = `${aviso}Relatório Lúmen — ${body.name || 'atendimento'} — ${status || 'atendimento'}`;
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

// ---------------------------------------------------------
//  LEMBRETES DE BEM-ESTAR — notificações automáticas do dia
//  Cada tipo sai no máximo 1x por dia, na janela certa (hora de Brasília).
// ---------------------------------------------------------
const LEMBRETES = [
  { kind: 'checkin',  deHora: 9,  ateHora: 12, soSemCheckin: true,
    title: '🌅 Seu check-in de hoje', body: 'Você ainda não fez seu check-in de bem-estar. A consciência é o primeiro alinhamento — leva 1 minuto.' },
  { kind: 'gratidao', deHora: 15, ateHora: 17, soSemCheckin: false,
    title: '✨ Gratidão', body: 'Já praticou a gratidão hoje? Lembre de uma coisa boa do seu dia e agradeça a Deus por ela.' },
  { kind: 'corpo',    deHora: 18, ateHora: 20, soSemCheckin: false,
    title: '🫀 O templo importa', body: 'E o corpo hoje — caminhou, se movimentou, bebeu água? Cuidar do templo também é adoração.' },
  { kind: 'oracao',   deHora: 20, ateHora: 22, soSemCheckin: false,
    title: '🕊️ Momento com Deus', body: 'Antes do dia terminar: já teve seu momento com o Pai hoje? Alguns minutos em oração realinham tudo.' }
];

async function rodarLembretes() {
  if (!PUSH_ON || !dbReady || String(process.env.REMINDERS || 'on') !== 'on') return;
  try {
    const hora = Number(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
    const ativos = LEMBRETES.filter(l => hora >= l.deHora && hora < l.ateHora);
    if (!ativos.length) return;
    const pacientes = await usersForReminders();
    for (const p of pacientes) {
      for (const l of ativos) {
        if (l.soSemCheckin && p.checkin_hoje) continue;
        if (await reminderSent(p.id, l.kind)) continue;
        const nome = String(p.name || '').split(' ')[0];
        const enviados = await sendPushToUser(p.id, { title: l.title, body: (nome ? nome + ', ' : '') + l.body.charAt(0).toLowerCase() + l.body.slice(1), tag: l.kind, url: '/' });
        if (enviados > 0) await markReminderSent(p.id, l.kind);
      }
    }
  } catch (e) { console.error('lembretes:', e.message); }
}
setInterval(rodarLembretes, 10 * 60 * 1000); // verifica a cada 10 minutos
setTimeout(rodarLembretes, 20 * 1000);       // e uma vez logo após subir

// ---------------------------------------------------------
//  APRENDIZADO COLETIVO (anônimo) — a IA aprende com todas as jornadas
//  sem nunca cruzar dados identificáveis de uma pessoa no diálogo de outra.
//  Roda 1x/dia (regenera se >20h). Guardado em memória p/ injetar no prompt.
// ---------------------------------------------------------
let COLETIVO = '';
const COLETIVO_ON = String(process.env.COLETIVO || 'on') === 'on';
let atualizandoColetivo = false;

async function updateColetivo() {
  if (!COLETIVO_ON || !dbReady || !process.env.ANTHROPIC_API_KEY || atualizandoColetivo) return;
  const atual = await getCollectiveWisdom().catch(() => null);
  if (atual?.updated_at && (Date.now() - new Date(atual.updated_at).getTime()) < 20 * 3600 * 1000) {
    COLETIVO = atual.texto || ''; return; // ainda fresco
  }
  atualizandoColetivo = true;
  try {
    const [emocoes, vitorias, cura] = await Promise.all([
      emotionsPredominant(60), anonVictories(120), healingAggregate(90)
    ]);
    const amostras = vitorias.length;
    if (amostras < 8) { COLETIVO = atual?.texto || ''; return; } // pouca base ainda
    const material =
      `EMOÇÕES MAIS FREQUENTES (anônimo): ${emocoes.map(e => `${e.emocao} (${e.n})`).join(', ')}\n` +
      `JORNADAS QUE CAMINHARAM PARA A PAZ: ${cura?.melhoraram || 0} de ${cura?.jornadas || 0}\n` +
      `VITÓRIAS E GRATIDÕES RELATADAS (anônimas, embaralhadas):\n- ${vitorias.join('\n- ')}`;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.PRONTUARIO_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        system: `Você destila a SABEDORIA COLETIVA do Método Lúmen a partir de vitórias e padrões ANÔNIMOS de muitas pessoas. Produza um texto curto (máx ~350 palavras) que capture, de forma TEMÁTICA e GERAL, o que tende a ajudar as pessoas a curar e avançar — como intuição pastoral, nunca como dado de indivíduo. Regras absolutas: NUNCA cite nomes, iniciais, cidades ou qualquer identificador; NUNCA conte a história de uma pessoa específica; fale sempre em padrões ("muitas pessoas encontram alívio quando...", "costuma ajudar..."). Seções: O QUE TENDE A CURAR (práticas/movimentos recorrentes nas vitórias) · CAMINHOS DE AVANÇO (o que precede a paz) · SEMENTES DE GRATIDÃO (temas comuns de gratidão). Escreva no espírito cristocêntrico do Método.`,
        messages: [{ role: 'user', content: material }]
      })
    });
    const data = await r.json();
    const texto = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (texto) { await setCollectiveWisdom(texto, amostras); COLETIVO = texto; console.log(`  Sabedoria coletiva atualizada (${amostras} vitórias anônimas).`); }
  } catch (e) { console.error('coletivo:', e.message); }
  finally { atualizandoColetivo = false; }
}
setInterval(updateColetivo, 6 * 3600 * 1000);   // reavalia a cada 6h (só regenera se >20h)
setTimeout(updateColetivo, 35 * 1000);          // e uma vez após subir

initDb().catch(e => console.error('  Banco: falha ao iniciar —', e.message));

app.listen(PORT, () => {
  console.log(`\n  LÚMEN no ar em http://localhost:${PORT}`);
  console.log(`  IA: ${process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('coloque') ? 'configurada' : 'FALTA a ANTHROPIC_API_KEY'}`);
  console.log(`  Contas: ${dbReady ? 'banco conectado (login exigido)' : 'SEM banco — modo aberto'}`);
  console.log(`  WhatsApp: ${process.env.WHATSAPP_PROVIDER || 'none'} | E-mail: ${process.env.SMTP_HOST ? 'configurado' : 'não configurado'}\n`);
});
