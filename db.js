// =========================================================
//  LÚMEN — banco de dados (Neon Postgres)
//  Contas, códigos de convite, histórico de conversas.
//  Dados sensíveis: senha com hash bcrypt, acesso só via JWT.
// =========================================================
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

export const dbReady = !!pool;

// --- cria as tabelas na subida (idempotente) ---
export async function initDb() {
  if (!pool) { console.warn('  Aviso: DATABASE_URL ausente — rodando SEM contas/histórico.'); return; }
  await pool.query(`
    -- ORGANIZAÇÕES (multi-tenant): cada terapeuta/clínica é uma org com um plano
    CREATE TABLE IF NOT EXISTS organizations (
      id BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      plano TEXT NOT NULL DEFAULT 'one',
      limite_pessoas INT NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'ativa',
      asaas_customer TEXT,
      asaas_subscription TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'paciente',
      invite_code TEXT,
      consent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_seen_at TIMESTAMPTZ
    );
    -- multi-tenant: vínculo do usuário à organização + login de mentor
    ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id BIGINT REFERENCES organizations(id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_login BOOLEAN DEFAULT false;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username)) WHERE username IS NOT NULL;
    ALTER TABLE invite_codes ADD COLUMN IF NOT EXISTS org_id BIGINT;
    -- organização padrão (Método Lúmen) para todos os dados atuais
    INSERT INTO organizations (id, nome, plano, limite_pessoas)
      VALUES (1, 'Método Lúmen', 'prime', 250) ON CONFLICT (id) DO NOTHING;
    SELECT setval(pg_get_serial_sequence('organizations','id'), GREATEST((SELECT max(id) FROM organizations), 1));
    UPDATE users SET org_id = 1 WHERE org_id IS NULL;
    UPDATE invite_codes SET org_id = 1 WHERE org_id IS NULL;
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      note TEXT,
      max_uses INT DEFAULT 1,
      used_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user_day ON messages (user_id, created_at);
    -- prontuário evolutivo (Etapa 3) — já deixamos a mesa posta
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      prontuario TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- dados cadastrais do acompanhamento
    ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS marital_status TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
    -- telefone e contato de emergência (para onde vai o alerta de risco desta pessoa)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_phone TEXT;
    -- foto do paciente (data URL pequena, redimensionada no cliente) para o prontuário
    ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT;
    -- áudios "Fala como está" (dado original separado da interpretação da IA)
    CREATE TABLE IF NOT EXISTS audio_entries (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      mime TEXT,
      bytes BYTEA,
      duration_sec INT,
      transcript TEXT,           -- o que foi dito (transcrição)
      resumo JSONB,              -- leitura ESTRUTURADA da IA (nunca sobrescreve o original)
      status TEXT DEFAULT 'enviado',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_audio_user ON audio_entries (user_id, created_at DESC);
    -- anotações privadas do mentor + vitórias estruturadas (extraídas pelo prontuário)
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS notas_mentor TEXT DEFAULT '';
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS vitorias JSONB DEFAULT '[]';
    -- check-in diário (o "filtro" de consciência: como estou hoje em corpo/alma/espírito)
    CREATE TABLE IF NOT EXISTS checkins (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      emocao TEXT,
      corpo INT, alma INT, espirito INT,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (user_id, day)
    );
    -- notificações push (PWA): cada aparelho inscrito do paciente
    CREATE TABLE IF NOT EXISTS push_subs (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      sub JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    -- mensagens do mentor para o paciente
    CREATE TABLE IF NOT EXISTS mentor_messages (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      texto TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      read_at TIMESTAMPTZ
    );
    -- controle dos lembretes de bem-estar (1 por tipo por dia)
    CREATE TABLE IF NOT EXISTS reminders_sent (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (user_id, day, kind)
    );
    -- PALAVRA VIVA do dia: versículo + reflexão personalizados por jornada (1 por pessoa/dia)
    CREATE TABLE IF NOT EXISTS palavra_viva (
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      referencia TEXT, versiculo TEXT, reflexao TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, day)
    );
    -- SABEDORIA COLETIVA (anônima): o que muitas jornadas ensinam sobre a cura.
    -- Linha única. Nunca guarda nome nem dado identificável de ninguém.
    CREATE TABLE IF NOT EXISTS collective_wisdom (
      id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      texto TEXT DEFAULT '',
      amostras INT DEFAULT 0,
      updated_at TIMESTAMPTZ
    );
  `);
  console.log('  Banco: tabelas prontas (users, invite_codes, messages, profiles, checkins).');
}

const JWT_SECRET = process.env.JWT_SECRET || 'defina-JWT_SECRET-no-env';
const norm = e => String(e || '').trim().toLowerCase();

// planos comerciais TriLumen
export const PLANOS = {
  one:   { nome: 'TRILUMEN ONE',   limite: 30,  preco: 79.90 },
  plus:  { nome: 'TRILUMEN PLUS',  limite: 100, preco: 149.90 },
  prime: { nome: 'TRILUMEN PRIME', limite: 250, preco: 259.90 }
};

// --- cadastro com código de convite + consentimento LGPD ---
export async function register({ name, email, password, invite, consent, birth, marital, city, address, phone, emergencyName, emergencyPhone, photo }) {
  if (!pool) throw new Error('banco não configurado');
  name = String(name || '').trim(); email = norm(email);
  if (!name || name.length < 2) throw new Error('Informe seu nome.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  if (!password || password.length < 6) throw new Error('A senha precisa de pelo menos 6 caracteres.');
  if (!consent) throw new Error('É preciso aceitar o termo de consentimento para usar a Lúmen.');
  const nasc = String(birth || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nasc)) throw new Error('Informe sua data de nascimento.');
  if (!String(marital || '').trim()) throw new Error('Informe seu estado civil.');
  if (!String(city || '').trim()) throw new Error('Informe sua cidade.');
  const fone = String(phone || '').replace(/\D/g, '');
  if (fone.length < 10) throw new Error('Informe seu WhatsApp com DDD.');
  const emgNome = String(emergencyName || '').trim();
  const emgFone = String(emergencyPhone || '').replace(/\D/g, '');
  if (!emgNome || emgFone.length < 10) throw new Error('Informe um contato de emergência (nome e WhatsApp com DDD) — é quem cuidará de você se precisar.');
  const code = String(invite || '').trim().toUpperCase();
  const inv = await pool.query('SELECT * FROM invite_codes WHERE code=$1', [code]);
  if (!inv.rows[0]) throw new Error('Código de convite inválido.');
  if (inv.rows[0].used_count >= inv.rows[0].max_uses) throw new Error('Este código de convite já foi utilizado.');
  const orgId = inv.rows[0].org_id || 1;
  // limite do plano da organização
  const org = await pool.query('SELECT limite_pessoas, status FROM organizations WHERE id=$1', [orgId]);
  if (org.rows[0] && org.rows[0].status !== 'ativa') throw new Error('Esta conta está inativa. Fale com seu mentor.');
  if (org.rows[0]) {
    const cnt = await pool.query("SELECT count(*)::int AS n FROM users WHERE org_id=$1 AND role='paciente'", [orgId]);
    if (cnt.rows[0].n >= org.rows[0].limite_pessoas) throw new Error('O limite de pessoas deste plano foi atingido. Fale com seu mentor.');
  }
  const dup = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (dup.rows[0]) throw new Error('Já existe uma conta com este e-mail. Use "Entrar".');
  const hash = await bcrypt.hash(password, 10);
  // foto: aceita apenas data URL de imagem pequena (redimensionada no cliente)
  const foto = (typeof photo === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(photo) && photo.length < 400000) ? photo : null;
  const u = await pool.query(
    `INSERT INTO users (email,name,password_hash,invite_code,consent_at,last_seen_at,birth_date,marital_status,city,address,phone,emergency_name,emergency_phone,photo,org_id)
     VALUES ($1,$2,$3,$4,now(),now(),$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,name,email,role`,
    [email, name, hash, code, nasc, String(marital).trim(), String(city).trim(), String(address || '').trim(), fone, emgNome, emgFone, foto, orgId]
  );
  await pool.query('UPDATE invite_codes SET used_count=used_count+1 WHERE code=$1', [code]);
  await pool.query('INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u.rows[0].id]);
  return issueToken(u.rows[0]);
}

export async function login({ email, password }) {
  if (!pool) throw new Error('banco não configurado');
  const u = await pool.query('SELECT * FROM users WHERE email=$1', [norm(email)]);
  if (!u.rows[0] || !(await bcrypt.compare(String(password || ''), u.rows[0].password_hash)))
    throw new Error('E-mail ou senha incorretos.');
  await pool.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [u.rows[0].id]);
  return issueToken(u.rows[0]);
}

function issueToken(u) {
  const token = jwt.sign({ uid: u.id, name: u.name, role: u.role }, JWT_SECRET, { expiresIn: '30d' });
  return { token, name: u.name, email: u.email, role: u.role };
}

// --- middleware: exige login nas rotas de conversa ---
export function requireAuth(req, res, next) {
  if (!pool) return next(); // sem banco, segue sem contas (modo antigo)
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'login_necessario' });
  }
}

// --- grava mensagens (com o META da Lúmen) por paciente ---
export async function saveMessage(userId, role, content, meta) {
  if (!pool || !userId) return;
  await pool.query('INSERT INTO messages (user_id,role,content,meta) VALUES ($1,$2,$3,$4)',
    [userId, role, content, meta ? JSON.stringify(meta) : null]);
}

// --- histórico recente (para continuar a conversa entre sessões) ---
export async function recentHistory(userId, limit = 30) {
  if (!pool || !userId) return [];
  const r = await pool.query(
    'SELECT role, content FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [userId, limit]);
  return r.rows.reverse();
}

// --- convites (o mentor gera pelo navegador com a ADMIN_KEY) ---
export async function createInvite(note, maxUses = 1, orgId = 1) {
  if (!pool) throw new Error('banco não configurado');
  const code = 'LUMEN-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await pool.query('INSERT INTO invite_codes (code,note,max_uses,org_id) VALUES ($1,$2,$3,$4)', [code, note || '', maxUses, orgId]);
  return code;
}

// =========================================================
//  MULTI-TENANT: organizações, provisionamento e login de mentor
// =========================================================
function slugUser(email) {
  const base = String(email || 'mentor').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'mentor';
  return base + Math.floor(100 + Math.random() * 900);
}

// cria a organização + a conta de mentor com acesso TEMPORÁRIO (usado após o pagamento)
export async function provisionarAssinatura({ plano, nome, email, asaasCustomer, asaasSubscription }) {
  if (!pool) throw new Error('banco não configurado');
  const p = PLANOS[String(plano || '').toLowerCase()] || PLANOS.one;
  email = norm(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('e-mail inválido');
  const nomeOrg = String(nome || email.split('@')[0]).trim();
  // se já existe conta com esse e-mail, não duplica (idempotência de webhook)
  const existe = await pool.query('SELECT id, org_id FROM users WHERE email=$1', [email]);
  if (existe.rows[0]) {
    return { jaExistia: true, email, org_id: existe.rows[0].org_id, plano: String(plano).toLowerCase() };
  }
  const org = await pool.query(
    `INSERT INTO organizations (nome, plano, limite_pessoas, asaas_customer, asaas_subscription)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [nomeOrg, String(plano).toLowerCase(), p.limite, asaasCustomer || null, asaasSubscription || null]);
  const orgId = org.rows[0].id;
  const username = slugUser(email);
  const senhaTemp = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
  const hash = await bcrypt.hash(senhaTemp, 10);
  await pool.query(
    `INSERT INTO users (email, name, password_hash, role, org_id, username, must_change_login, consent_at, last_seen_at)
     VALUES ($1,$2,$3,'mentor',$4,$5,true,now(),now())`,
    [email, nomeOrg, hash, orgId, username]);
  return { jaExistia: false, org_id: orgId, plano: String(plano).toLowerCase(), plano_nome: p.nome,
           email, username, senha_temp: senhaTemp, limite: p.limite };
}

// login do mentor (por e-mail OU usuário)
export async function mentorLogin({ login, password }) {
  if (!pool) throw new Error('banco não configurado');
  const l = norm(login);
  const u = await pool.query(
    `SELECT * FROM users WHERE role IN ('mentor','owner') AND (email=$1 OR lower(username)=$1)`, [l]);
  if (!u.rows[0] || !(await bcrypt.compare(String(password || ''), u.rows[0].password_hash)))
    throw new Error('Usuário ou senha incorretos.');
  await pool.query('UPDATE users SET last_seen_at=now() WHERE id=$1', [u.rows[0].id]);
  const token = jwt.sign({ uid: u.rows[0].id, org_id: u.rows[0].org_id, role: u.rows[0].role, mentor: true },
    JWT_SECRET, { expiresIn: '30d' });
  return { token, name: u.rows[0].name, username: u.rows[0].username, must_change: !!u.rows[0].must_change_login, org_id: u.rows[0].org_id };
}

export async function changeMentorLogin(uid, { username, password }) {
  if (!pool || !uid) throw new Error('banco não configurado');
  const user = String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (user.length < 3) throw new Error('Escolha um nome de usuário (mín. 3 caracteres, sem espaços).');
  if (!password || password.length < 6) throw new Error('A nova senha precisa de pelo menos 6 caracteres.');
  const dup = await pool.query('SELECT 1 FROM users WHERE lower(username)=$1 AND id<>$2', [user, uid]);
  if (dup.rows[0]) throw new Error('Esse nome de usuário já está em uso.');
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET username=$1, password_hash=$2, must_change_login=false WHERE id=$3', [user, hash, uid]);
  return { ok: true, username: user };
}

export async function orgById(orgId) {
  if (!pool || !orgId) return null;
  const r = await pool.query(`SELECT o.*,
      (SELECT count(*)::int FROM users u WHERE u.org_id=o.id AND u.role='paciente') AS pessoas
    FROM organizations o WHERE id=$1`, [orgId]);
  return r.rows[0] || null;
}
export async function patientOrg(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT org_id FROM users WHERE id=$1', [userId]);
  return r.rows[0]?.org_id || null;
}

export async function listUsers(orgId = null) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT u.id, u.name, u.email, u.created_at, u.last_seen_at, u.birth_date,
           date_part('day', u.birth_date)::int AS nasc_dia, date_part('month', u.birth_date)::int AS nasc_mes,
           count(m.id) FILTER (WHERE m.role='user') AS mensagens,
           max(m.created_at) AS ultima_conversa,
           (SELECT meta FROM messages m2 WHERE m2.user_id=u.id AND m2.meta IS NOT NULL
             ORDER BY m2.id DESC LIMIT 1) AS ultimo_meta,
           EXISTS (SELECT 1 FROM messages m3 WHERE m3.user_id=u.id
             AND m3.meta->>'risco'='ALTO' AND m3.created_at > now() - interval '7 days') AS risco_recente
    FROM users u LEFT JOIN messages m ON m.user_id = u.id
    WHERE u.role='paciente' AND ($1::bigint IS NULL OR u.org_id=$1)
    GROUP BY u.id ORDER BY max(m.created_at) DESC NULLS LAST`, [orgId]);
  return r.rows;
}

// =========================================================
//  PRONTUÁRIO EVOLUTIVO + DADOS DOS PAINÉIS
// =========================================================
export async function getProntuario(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT prontuario, updated_at FROM profiles WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}

export async function setProntuario(userId, texto) {
  if (!pool || !userId) return;
  await pool.query(`INSERT INTO profiles (user_id, prontuario, updated_at) VALUES ($1,$2,now())
    ON CONFLICT (user_id) DO UPDATE SET prontuario=$2, updated_at=now()`, [userId, texto]);
}

// mensagens ainda não incorporadas ao prontuário (desde a última atualização)
export async function messagesSinceProfile(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT m.role, m.content, m.meta, m.created_at
    FROM messages m LEFT JOIN profiles p ON p.user_id = m.user_id
    WHERE m.user_id=$1 AND (p.updated_at IS NULL OR m.created_at > p.updated_at)
    ORDER BY m.id`, [userId]);
  return r.rows;
}

// agregados por dia para os gráficos: emoção dominante, intensidade média,
// pior status, e a tríade corpo/alma/espírito média
export async function patientDaily(userId, days = 60) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
           count(*) AS conversas,
           round(avg((meta->>'intensidade')::numeric),1) AS intensidade,
           round(avg((meta->>'corpo')::numeric),1)    AS corpo,
           round(avg((meta->>'alma')::numeric),1)     AS alma,
           round(avg((meta->>'espirito')::numeric),1) AS espirito,
           mode() WITHIN GROUP (ORDER BY meta->>'emocao') AS emocao,
           CASE WHEN bool_or(meta->>'status'='vermelho') THEN 'vermelho'
                WHEN bool_or(meta->>'status'='amarelo')  THEN 'amarelo'
                ELSE 'verde' END AS status
    FROM messages
    WHERE user_id=$1 AND role='assistant' AND meta IS NOT NULL
      AND created_at > now() - ($2 || ' days')::interval
    GROUP BY 1 ORDER BY 1`, [userId, days]);
  return r.rows;
}

export async function getUserBasic(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query(`
    SELECT id, name, email, created_at, last_seen_at,
           birth_date, marital_status, city, address,
           phone, emergency_name, emergency_phone, photo,
           date_part('year', age(birth_date))::int AS idade
    FROM users WHERE id=$1`, [userId]);
  return r.rows[0] || null;
}

// foto no primeiro acesso (para quem não enviou no cadastro)
export async function userHasPhoto(userId) {
  if (!pool || !userId) return true;
  const r = await pool.query('SELECT (photo IS NOT NULL) AS tem FROM users WHERE id=$1', [userId]);
  return !!r.rows[0]?.tem;
}
export async function setUserPhoto(userId, photo) {
  if (!pool || !userId) return;
  if (!(typeof photo === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(photo) && photo.length < 400000)) throw new Error('foto inválida');
  await pool.query('UPDATE users SET photo=$2 WHERE id=$1', [userId, photo]);
}

// =========================================================
//  ÁUDIOS "Fala como está"
// =========================================================
export async function saveAudio(userId, { mime, buffer, duration, transcript }) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const r = await pool.query(
    `INSERT INTO audio_entries (user_id, mime, bytes, duration_sec, transcript, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, String(mime || 'audio/webm'), buffer, Math.round(duration || 0), transcript || null, transcript ? 'transcrito' : 'enviado']);
  return r.rows[0].id;
}
export async function setAudioSummary(id, resumo, transcript) {
  if (!pool) return;
  const status = resumo ? 'concluido' : (transcript ? 'transcrito' : 'audio_only');
  await pool.query('UPDATE audio_entries SET resumo=$2, transcript=COALESCE($3,transcript), status=$4 WHERE id=$1',
    [id, resumo ? JSON.stringify(resumo) : null, transcript || null, status]);
}
export async function getAudioBytes(id) {
  if (!pool) return null;
  const r = await pool.query(`SELECT a.mime, a.bytes, u.org_id
    FROM audio_entries a JOIN users u ON u.id=a.user_id WHERE a.id=$1`, [id]);
  return r.rows[0] || null;
}
export async function listAudios(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(
    `SELECT id, mime, duration_sec, transcript, resumo, status, created_at
     FROM audio_entries WHERE user_id=$1 ORDER BY id DESC LIMIT 40`, [userId]);
  return r.rows;
}
export async function myAudios(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(
    `SELECT id, duration_sec, status, created_at FROM audio_entries WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [userId]);
  return r.rows;
}

// contato de emergência do paciente (para onde o alerta de risco vai)
export async function emergencyContact(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT name, emergency_name, emergency_phone FROM users WHERE id=$1', [userId]);
  return r.rows[0] || null;
}

// sequência de dias seguidos com check-in (terminando hoje ou ontem)
export async function checkinStreak(userId) {
  if (!pool || !userId) return 0;
  const r = await pool.query(`
    WITH dias AS (SELECT day FROM checkins WHERE user_id=$1 ORDER BY day DESC LIMIT 120)
    SELECT count(*)::int AS streak FROM (
      SELECT day, row_number() OVER (ORDER BY day DESC) AS rn,
             (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje
      FROM dias
    ) t
    WHERE day = hoje - (rn - 1)::int OR day = hoje - rn::int`, [userId]);
  return r.rows[0]?.streak || 0;
}

// vitórias estruturadas + anotações do mentor
export async function getExtras(userId) {
  if (!pool || !userId) return { vitorias: [], notas_mentor: '' };
  const r = await pool.query('SELECT vitorias, notas_mentor FROM profiles WHERE user_id=$1', [userId]);
  return r.rows[0] || { vitorias: [], notas_mentor: '' };
}

export async function mergeVitorias(userId, novas) {
  if (!pool || !userId || !Array.isArray(novas) || !novas.length) return;
  const atual = (await getExtras(userId)).vitorias || [];
  const chaves = new Set(atual.map(v => (v.texto || '').toLowerCase().slice(0, 60)));
  for (const v of novas) {
    const t = String(v.texto || '').trim();
    if (t && !chaves.has(t.toLowerCase().slice(0, 60))) atual.push({ data: String(v.data || '').slice(0, 20), texto: t.slice(0, 200) });
  }
  await pool.query('UPDATE profiles SET vitorias=$2 WHERE user_id=$1', [userId, JSON.stringify(atual.slice(-40))]);
}

export async function setNotasMentor(userId, texto) {
  if (!pool || !userId) throw new Error('banco não configurado');
  await pool.query(`INSERT INTO profiles (user_id, notas_mentor) VALUES ($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET notas_mentor=$2`, [userId, String(texto || '').slice(0, 8000)]);
}

// =========================================================
//  PUSH (PWA) + MENSAGENS DO MENTOR + LEMBRETES
// =========================================================
export async function savePushSub(userId, sub) {
  if (!pool || !userId || !sub?.endpoint) throw new Error('inscrição inválida');
  await pool.query(`INSERT INTO push_subs (user_id, endpoint, sub) VALUES ($1,$2,$3)
    ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, sub=$3`, [userId, sub.endpoint, JSON.stringify(sub)]);
}

export async function pushSubsOf(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query('SELECT endpoint, sub FROM push_subs WHERE user_id=$1', [userId]);
  return r.rows;
}

export async function deletePushSub(endpoint) {
  if (!pool) return;
  await pool.query('DELETE FROM push_subs WHERE endpoint=$1', [endpoint]);
}

export async function saveMentorMessage(userId, texto) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const r = await pool.query('INSERT INTO mentor_messages (user_id, texto) VALUES ($1,$2) RETURNING id, created_at',
    [userId, String(texto || '').slice(0, 2000)]);
  return r.rows[0];
}

export async function unreadMentorMessages(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(`SELECT id, texto, created_at FROM mentor_messages
    WHERE user_id=$1 AND read_at IS NULL ORDER BY id`, [userId]);
  return r.rows;
}

export async function markMentorRead(userId) {
  if (!pool || !userId) return;
  await pool.query('UPDATE mentor_messages SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [userId]);
}

// pacientes com aparelho inscrito + se já fizeram o check-in de hoje (para os lembretes)
export async function usersForReminders() {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT DISTINCT u.id, u.name,
      EXISTS (SELECT 1 FROM checkins c WHERE c.user_id=u.id
        AND c.day=(now() AT TIME ZONE 'America/Sao_Paulo')::date) AS checkin_hoje
    FROM users u JOIN push_subs p ON p.user_id=u.id`);
  return r.rows;
}

export async function reminderSent(userId, kind) {
  if (!pool) return true;
  const r = await pool.query(`SELECT 1 FROM reminders_sent
    WHERE user_id=$1 AND kind=$2 AND day=(now() AT TIME ZONE 'America/Sao_Paulo')::date`, [userId, kind]);
  return !!r.rows[0];
}

export async function markReminderSent(userId, kind) {
  if (!pool) return;
  await pool.query(`INSERT INTO reminders_sent (user_id, day, kind)
    VALUES ($1,(now() AT TIME ZONE 'America/Sao_Paulo')::date,$2) ON CONFLICT DO NOTHING`, [userId, kind]);
}

// =========================================================
//  PALAVRA VIVA do dia (versículo + reflexão por jornada)
// =========================================================
export async function palavraToday(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query(`SELECT referencia, versiculo, reflexao, created_at FROM palavra_viva
    WHERE user_id=$1 AND day=(now() AT TIME ZONE 'America/Sao_Paulo')::date`, [userId]);
  return r.rows[0] || null;
}
export async function setPalavra(userId, { referencia, versiculo, reflexao }) {
  if (!pool || !userId) return;
  await pool.query(`INSERT INTO palavra_viva (user_id, day, referencia, versiculo, reflexao)
    VALUES ($1,(now() AT TIME ZONE 'America/Sao_Paulo')::date,$2,$3,$4)
    ON CONFLICT (user_id, day) DO UPDATE SET referencia=$2, versiculo=$3, reflexao=$4`,
    [userId, String(referencia || '').slice(0, 60), String(versiculo || '').slice(0, 600), String(reflexao || '').slice(0, 900)]);
}
// pacientes com aparelho inscrito e SEM a palavra de hoje (para o job da manhã)
export async function usersForPalavra() {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT DISTINCT u.id, u.name, p.prontuario
    FROM users u
    JOIN push_subs s ON s.user_id=u.id
    LEFT JOIN profiles p ON p.user_id=u.id
    WHERE NOT EXISTS (SELECT 1 FROM palavra_viva pv WHERE pv.user_id=u.id
      AND pv.day=(now() AT TIME ZONE 'America/Sao_Paulo')::date)`);
  return r.rows;
}

// =========================================================
//  SABEDORIA COLETIVA (aprendizado anônimo entre jornadas)
//  Só agregados/temas. NUNCA nomes ou dados identificáveis.
// =========================================================
export async function getCollectiveWisdom() {
  if (!pool) return null;
  const r = await pool.query('SELECT texto, amostras, updated_at FROM collective_wisdom WHERE id=1');
  return r.rows[0] || null;
}

export async function setCollectiveWisdom(texto, amostras) {
  if (!pool) return;
  await pool.query(`INSERT INTO collective_wisdom (id, texto, amostras, updated_at)
    VALUES (1,$1,$2,now()) ON CONFLICT (id) DO UPDATE SET texto=$1, amostras=$2, updated_at=now()`,
    [String(texto || '').slice(0, 6000), amostras || 0]);
}

// vitórias de TODAS as pessoas, achatadas e SEM vínculo a ninguém (anônimo)
export async function anonVictories(limit = 120) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT (v->>'texto') AS texto
    FROM profiles, jsonb_array_elements(COALESCE(vitorias,'[]'::jsonb)) AS v
    WHERE v->>'texto' IS NOT NULL
    ORDER BY random() LIMIT $1`, [limit]);
  return r.rows.map(x => x.texto).filter(Boolean);
}

// sinais agregados de melhora (anônimo): quantas jornadas foram de amarelo/vermelho -> verde
export async function healingAggregate(days = 90) {
  if (!pool) return null;
  const r = await pool.query(`
    WITH por_pessoa AS (
      SELECT user_id,
        min(created_at) FILTER (WHERE meta->>'status' IN ('amarelo','vermelho')) AS inicio_dificil,
        max(created_at) FILTER (WHERE meta->>'status'='verde') AS chegou_verde
      FROM messages
      WHERE role='assistant' AND meta IS NOT NULL AND created_at > now() - ($1||' days')::interval
      GROUP BY user_id)
    SELECT count(*)::int AS jornadas,
           count(*) FILTER (WHERE chegou_verde > inicio_dificil)::int AS melhoraram
    FROM por_pessoa`, [days]);
  return r.rows[0] || null;
}

// =========================================================
//  CHECK-IN DIÁRIO (o filtro de consciência)
// =========================================================
export async function todayCheckin(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query(`SELECT * FROM checkins WHERE user_id=$1
    AND day = (now() AT TIME ZONE 'America/Sao_Paulo')::date`, [userId]);
  return r.rows[0] || null;
}

export async function saveCheckin(userId, { emocao, corpo, alma, espirito }) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const n = v => Math.max(0, Math.min(10, Number(v ?? 5)));
  const r = await pool.query(`
    INSERT INTO checkins (user_id, day, emocao, corpo, alma, espirito)
    VALUES ($1, (now() AT TIME ZONE 'America/Sao_Paulo')::date, $2, $3, $4, $5)
    ON CONFLICT (user_id, day) DO UPDATE SET emocao=$2, corpo=$3, alma=$4, espirito=$5, created_at=now()
    RETURNING *`, [userId, String(emocao || '').slice(0, 40), n(corpo), n(alma), n(espirito)]);
  return r.rows[0];
}

export async function checkinSeries(userId, days = 60) {
  if (!pool || !userId) return [];
  const r = await pool.query(`SELECT day::text AS dia, emocao, corpo, alma, espirito
    FROM checkins WHERE user_id=$1 AND day > (now() AT TIME ZONE 'America/Sao_Paulo')::date - $2::int
    ORDER BY day`, [userId, days]);
  return r.rows;
}

// =========================================================
//  TRANSCRIÇÕES — as sessões para consulta do mentor
// =========================================================
export async function sessionDays(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
           count(*) FILTER (WHERE role='user') AS perguntas,
           min(created_at) AS inicio, max(created_at) AS fim
    FROM messages WHERE user_id=$1 GROUP BY 1 ORDER BY 1 DESC`, [userId]);
  return r.rows;
}

export async function transcriptOfDay(userId, day) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT role, content, meta, created_at
    FROM messages
    WHERE user_id=$1 AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
    ORDER BY id`, [userId, day]);
  return r.rows;
}

// =========================================================
//  VISÃO GERAL DA PLATAFORMA (dashboard TriLumen)
// =========================================================
export async function overviewStats() {
  if (!pool) return null;
  const r = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM users) AS pessoas,
      (SELECT count(DISTINCT user_id)::int FROM messages WHERE created_at > now() - interval '30 days') AS jornadas,
      (SELECT count(DISTINCT user_id)::int FROM messages
         WHERE meta->>'risco'='ALTO' AND created_at > now() - interval '7 days') AS alertas,
      (SELECT count(*)::int FROM checkins
         WHERE day = (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS checkins_hoje`);
  return r.rows[0];
}

// evolução emocional agregada de todos os pacientes (média da tríade por dia)
export async function globalDaily(days = 30) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
           round(avg((meta->>'corpo')::numeric),1)    AS corpo,
           round(avg((meta->>'alma')::numeric),1)     AS alma,
           round(avg((meta->>'espirito')::numeric),1) AS espirito,
           round(avg((meta->>'intensidade')::numeric),1) AS intensidade
    FROM messages
    WHERE role='assistant' AND meta IS NOT NULL
      AND created_at > now() - ($1 || ' days')::interval
    GROUP BY 1 ORDER BY 1`, [days]);
  return r.rows;
}

// emoções predominantes na plataforma (para o gráfico de rosca)
export async function emotionsPredominant(days = 30) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT meta->>'emocao' AS emocao, count(*)::int AS n
    FROM messages
    WHERE role='assistant' AND meta->>'emocao' IS NOT NULL AND meta->>'emocao' <> ''
      AND created_at > now() - ($1 || ' days')::interval
    GROUP BY 1 ORDER BY n DESC LIMIT 6`, [days]);
  return r.rows;
}

// médias da tríade nos últimos N dias (para as esferas do painel)
export async function triadAverages(userId, days = 7) {
  if (!pool || !userId) return null;
  const r = await pool.query(`
    SELECT round(avg((meta->>'corpo')::numeric),1)    AS corpo,
           round(avg((meta->>'alma')::numeric),1)     AS alma,
           round(avg((meta->>'espirito')::numeric),1) AS espirito,
           count(*) AS amostras
    FROM messages
    WHERE user_id=$1 AND role='assistant' AND meta ? 'corpo'
      AND created_at > now() - ($2 || ' days')::interval`, [userId, days]);
  return r.rows[0] || null;
}
