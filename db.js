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
  `);
  console.log('  Banco: tabelas prontas (users, invite_codes, messages, profiles, checkins).');
}

const JWT_SECRET = process.env.JWT_SECRET || 'defina-JWT_SECRET-no-env';
const norm = e => String(e || '').trim().toLowerCase();

// --- cadastro com código de convite + consentimento LGPD ---
export async function register({ name, email, password, invite, consent, birth, marital, city, address }) {
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
  const code = String(invite || '').trim().toUpperCase();
  const inv = await pool.query('SELECT * FROM invite_codes WHERE code=$1', [code]);
  if (!inv.rows[0]) throw new Error('Código de convite inválido.');
  if (inv.rows[0].used_count >= inv.rows[0].max_uses) throw new Error('Este código de convite já foi utilizado.');
  const dup = await pool.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (dup.rows[0]) throw new Error('Já existe uma conta com este e-mail. Use "Entrar".');
  const hash = await bcrypt.hash(password, 10);
  const u = await pool.query(
    `INSERT INTO users (email,name,password_hash,invite_code,consent_at,last_seen_at,birth_date,marital_status,city,address)
     VALUES ($1,$2,$3,$4,now(),now(),$5,$6,$7,$8) RETURNING id,name,email,role`,
    [email, name, hash, code, nasc, String(marital).trim(), String(city).trim(), String(address || '').trim()]
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
export async function createInvite(note, maxUses = 1) {
  if (!pool) throw new Error('banco não configurado');
  const code = 'LUMEN-' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await pool.query('INSERT INTO invite_codes (code,note,max_uses) VALUES ($1,$2,$3)', [code, note || '', maxUses]);
  return code;
}

export async function listUsers() {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT u.id, u.name, u.email, u.created_at, u.last_seen_at,
           count(m.id) FILTER (WHERE m.role='user') AS mensagens,
           max(m.created_at) AS ultima_conversa,
           (SELECT meta FROM messages m2 WHERE m2.user_id=u.id AND m2.meta IS NOT NULL
             ORDER BY m2.id DESC LIMIT 1) AS ultimo_meta
    FROM users u LEFT JOIN messages m ON m.user_id = u.id
    GROUP BY u.id ORDER BY max(m.created_at) DESC NULLS LAST`);
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
           date_part('year', age(birth_date))::int AS idade
    FROM users WHERE id=$1`, [userId]);
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
