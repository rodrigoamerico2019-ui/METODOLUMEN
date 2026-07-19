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
    -- controle financeiro da licença (painel ADM): vencimento e último pagamento
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS proximo_vencimento DATE;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS ultimo_pagamento TIMESTAMPTZ;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS origem TEXT DEFAULT 'asaas';
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
    -- MAPA INICIAL (questionário obrigatório do 1º acesso): respostas + bússola p/ a IA + sinal de risco
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mapa JSONB;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mapa_bussola TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mapa_em TIMESTAMPTZ;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS mapa_risco BOOLEAN DEFAULT false;
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
    -- CHECKOUTS Asaas: liga o pagamento (assinatura) ao provisionamento do acesso
    CREATE TABLE IF NOT EXISTS checkouts (
      asaas_subscription TEXT PRIMARY KEY,
      asaas_customer TEXT,
      email TEXT, nome TEXT, plano TEXT,
      status TEXT DEFAULT 'pendente',
      created_at TIMESTAMPTZ DEFAULT now(),
      provisioned_at TIMESTAMPTZ
    );
    ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS ciclo TEXT DEFAULT 'mensal';
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
    -- ESCALAS DE ACOMPANHAMENTO: cada resposta do paciente com pontuação (0–100).
    -- A definição das escalas vive no código (escalas.js); aqui guardamos a evolução.
    CREATE TABLE IF NOT EXISTS scale_responses (
      id BIGSERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      scale_key TEXT NOT NULL,
      answers JSONB NOT NULL,
      raw INT, max INT,
      score NUMERIC NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_scale_user ON scale_responses (user_id, scale_key, created_at DESC);
    -- ===== CENTRAL FINANCEIRA DO CONSULTÓRIO (do mentor, por organização) =====
    -- Plano/mensalidade que o mentor define para cada paciente
    CREATE TABLE IF NOT EXISTS patient_plans (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      valor NUMERIC NOT NULL DEFAULT 0,
      dia_vencimento INT NOT NULL DEFAULT 10,
      lembrete_dias INT NOT NULL DEFAULT 5,
      ativo BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- Contas a RECEBER (mensalidades geradas do plano + lançamentos manuais)
    CREATE TABLE IF NOT EXISTS receivables (
      id BIGSERIAL PRIMARY KEY,
      org_id BIGINT,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      descricao TEXT,
      valor NUMERIC NOT NULL,
      vencimento DATE NOT NULL,
      competencia TEXT,                          -- 'YYYY-MM' (não duplica a mensalidade do mês)
      status TEXT NOT NULL DEFAULT 'pendente',   -- pendente | pago
      pago_em TIMESTAMPTZ,
      lembrete_em TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_receiv_org ON receivables (org_id, vencimento);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_receiv_comp ON receivables (user_id, competencia) WHERE competencia IS NOT NULL;
    -- Contas a PAGAR (despesas do consultório)
    CREATE TABLE IF NOT EXISTS payables (
      id BIGSERIAL PRIMARY KEY,
      org_id BIGINT,
      descricao TEXT NOT NULL,
      valor NUMERIC NOT NULL,
      vencimento DATE,
      status TEXT NOT NULL DEFAULT 'pendente',   -- pendente | pago
      pago_em TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_pay_org ON payables (org_id, vencimento);
    -- AGENDA de consultas (online/presencial) + lembretes automáticos
    CREATE TABLE IF NOT EXISTS appointments (
      id BIGSERIAL PRIMARY KEY,
      org_id BIGINT,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      quando TIMESTAMPTZ NOT NULL,
      duracao_min INT DEFAULT 50,
      modalidade TEXT DEFAULT 'online',     -- online | presencial
      local TEXT,                            -- link (online) ou endereço (presencial)
      obs TEXT,
      status TEXT DEFAULT 'agendada',        -- agendada | realizada | cancelada
      lembrete_1d_em TIMESTAMPTZ,
      lembrete_1h_em TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_appt_org ON appointments (org_id, quando);
    CREATE INDEX IF NOT EXISTS idx_appt_user ON appointments (user_id, quando);

    -- =========================================================
    --  MÓDULO DE CLIENTES E PRONTUÁRIO (multiorganização)
    --  O cliente = users(role='paciente') estendido por tabelas satélite.
    -- =========================================================
    -- Unidades da organização (opcional)
    CREATE TABLE IF NOT EXISTS org_units (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
      nome TEXT NOT NULL, ativo BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
    );
    -- RBAC: cada membro da equipe é um usuário com um papel na org
    CREATE TABLE IF NOT EXISTS org_members (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE, unit_id BIGINT REFERENCES org_units(id),
      role TEXT NOT NULL DEFAULT 'professional',   -- owner|admin|professional|professional_secondary|reception|financeiro
      registro_profissional TEXT, ativo BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (org_id, user_id)
    );
    -- migra mentores/owners atuais para org_members (admin/owner) — idempotente
    INSERT INTO org_members (org_id, user_id, role)
      SELECT org_id, id, CASE WHEN role='owner' THEN 'owner' ELSE 'admin' END
      FROM users WHERE role IN ('mentor','owner') AND org_id IS NOT NULL
      ON CONFLICT (org_id, user_id) DO NOTHING;
    -- Ficha estendida do cliente
    CREATE TABLE IF NOT EXISTS client_details (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, org_id BIGINT, unit_id BIGINT,
      codigo TEXT, nome_social TEXT, sexo TEXT, genero TEXT, cpf TEXT, rg TEXT,
      profissao TEXT, empresa TEXT, escolaridade TEXT, idioma TEXT, whatsapp TEXT,
      cep TEXT, estado TEXT, pais TEXT, com_quem_reside TEXT, possui_filhos BOOLEAN, qtd_filhos INT,
      info_familiar TEXT, acessibilidade TEXT, obs TEXT,
      tipo_acompanhamento TEXT, data_entrada DATE, origem TEXT, status TEXT DEFAULT 'ativo',
      canal_preferencial TEXT, obs_inicial TEXT,
      created_by INT, updated_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ
    );
    -- vínculo cliente ↔ profissionais (principal + secundários)
    CREATE TABLE IF NOT EXISTS client_professionals (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      member_id BIGINT REFERENCES org_members(id) ON DELETE CASCADE, principal BOOLEAN DEFAULT false,
      modulos JSONB DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (client_user_id, member_id)
    );
    -- responsáveis legais
    CREATE TABLE IF NOT EXISTS client_legal_guardians (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT, cpf TEXT, birth_date DATE, parentesco TEXT, phone TEXT, whatsapp TEXT, email TEXT, endereco TEXT,
      responsavel_financeiro BOOLEAN, guarda_legal BOOLEAN, doc_url TEXT,
      autoriza_atendimento BOOLEAN, autoriza_comunicacao BOOLEAN, restricoes TEXT, obs TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ
    );
    -- contatos de emergência (múltiplos)
    CREATE TABLE IF NOT EXISTS client_emergency_contacts (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT, relacionamento TEXT, phone TEXT, whatsapp TEXT, email TEXT, melhor_horario TEXT,
      pode_emergencia BOOLEAN DEFAULT true, situacoes TEXT, obs TEXT,
      created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ
    );
    -- perfis sensíveis (JSONB flexível; acesso exige permissão específica)
    CREATE TABLE IF NOT EXISTS client_health_profiles (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, org_id BIGINT,
      dados JSONB DEFAULT '{}', updated_by INT, updated_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS client_emotional_profiles (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      escalas JSONB DEFAULT '{}', campos JSONB DEFAULT '{}', created_by INT, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS client_spiritual_profiles (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      ativo BOOLEAN DEFAULT false, dados JSONB DEFAULT '{}', created_by INT, created_at TIMESTAMPTZ DEFAULT now()
    );
    -- medicamentos (estruturado; nunca apagar de vez — usa status/suspensão)
    CREATE TABLE IF NOT EXISTS client_medications (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT NOT NULL, principio_ativo TEXT, dosagem TEXT, unidade TEXT, forma TEXT,
      frequencia TEXT, horarios TEXT, via TEXT, motivo TEXT, prescrito_por TEXT, especialidade TEXT,
      data_inicio DATE, data_fim_prevista DATE, uso_continuo BOOLEAN, usando_atualmente BOOLEAN DEFAULT true,
      adesao TEXT, efeitos_positivos TEXT, efeitos_adversos TEXT, obs TEXT,
      data_suspensao DATE, motivo_suspensao TEXT, status TEXT DEFAULT 'ativo',
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_by INT, updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- objetivos do acompanhamento
    CREATE TABLE IF NOT EXISTS client_goals (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      titulo TEXT, descricao TEXT, categoria TEXT, prioridade TEXT, nota_inicial INT, meta INT, prazo DATE,
      indicador TEXT, obstaculos TEXT, recursos TEXT, apoio TEXT, status TEXT DEFAULT 'planejado',
      progresso INT DEFAULT 0, data_revisao DATE, obs TEXT,
      created_by INT, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ
    );
    -- consentimentos (LGPD)
    CREATE TABLE IF NOT EXISTS client_consents (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL, versao TEXT, texto TEXT, status TEXT DEFAULT 'aceito',
      aceito_em TIMESTAMPTZ DEFAULT now(), revogado_em TIMESTAMPTZ, motivo_revogacao TEXT,
      usuario_id INT, ip TEXT, dispositivo TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    -- documentos
    CREATE TABLE IF NOT EXISTS client_documents (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      nome TEXT, tipo TEXT, mime TEXT, tamanho INT, bytes BYTEA, compartilhado BOOLEAN DEFAULT false,
      uploaded_by INT, created_at TIMESTAMPTZ DEFAULT now(), deleted_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS client_tags (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      tag TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    -- sessões clínicas (prontuário)
    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      member_id BIGINT REFERENCES org_members(id), unit_id BIGINT,
      quando TIMESTAMPTZ, duracao_min INT DEFAULT 50, modalidade TEXT, tipo TEXT,
      status TEXT DEFAULT 'agendada', data_proxima TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
      finalizado_em TIMESTAMPTZ, finalizado_por INT, deleted_at TIMESTAMPTZ
    );
    -- prontuário PRIVADO (1:1 com a sessão — nunca vai automático ao cliente)
    CREATE TABLE IF NOT EXISTS session_records (
      session_id BIGINT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, org_id BIGINT,
      demanda TEXT, estado_emocional_inicial TEXT, temas TEXT, intervencoes TEXT, percepcoes TEXT,
      evolucao TEXT, condutas TEXT, encaminhamentos TEXT, riscos TEXT, proximos_passos TEXT,
      obs_privadas TEXT, updated_at TIMESTAMPTZ DEFAULT now()
    );
    -- resumo COMPARTILHÁVEL (1:1 — liberado manualmente)
    CREATE TABLE IF NOT EXISTS session_shared_summaries (
      session_id BIGINT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, org_id BIGINT,
      resumo TEXT, compartilhado BOOLEAN DEFAULT false, incluir_relatorio BOOLEAN DEFAULT false,
      permite_download BOOLEAN DEFAULT false, permite_impressao BOOLEAN DEFAULT false,
      compartilha_tarefas BOOLEAN DEFAULT false, shared_by INT, shared_at TIMESTAMPTZ
    );
    -- tarefas
    CREATE TABLE IF NOT EXISTS session_tasks (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, session_id BIGINT REFERENCES sessions(id) ON DELETE CASCADE,
      client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      titulo TEXT, descricao TEXT, status TEXT DEFAULT 'pendente', prazo DATE,
      compartilhada BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
    );
    -- relatórios + versões + entregas
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, client_user_id INT REFERENCES users(id) ON DELETE CASCADE,
      member_id BIGINT, tipo TEXT, periodo_inicio DATE, periodo_fim DATE, config JSONB DEFAULT '{}',
      status TEXT DEFAULT 'gerado', created_by INT, created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_versions (
      id BIGSERIAL PRIMARY KEY, report_id BIGINT REFERENCES reports(id) ON DELETE CASCADE, versao INT DEFAULT 1,
      doc_uid TEXT, dados_incluidos JSONB, pdf BYTEA, gerado_por INT, gerado_em TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS report_deliveries (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, report_id BIGINT REFERENCES reports(id) ON DELETE CASCADE,
      canal TEXT, destinatario TEXT, assunto TEXT, mensagem TEXT, status TEXT, erro TEXT,
      enviado_por INT, enviado_em TIMESTAMPTZ DEFAULT now()
    );
    -- auditoria
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY, org_id BIGINT, user_id INT, client_user_id INT,
      acao TEXT, entidade TEXT, entidade_id TEXT, dados JSONB, ip TEXT, created_at TIMESTAMPTZ DEFAULT now()
    );
    -- índices
    CREATE INDEX IF NOT EXISTS idx_orgmembers_org ON org_members (org_id, ativo);
    CREATE INDEX IF NOT EXISTS idx_clientdet_org ON client_details (org_id, status);
    CREATE INDEX IF NOT EXISTS idx_clientprof_client ON client_professionals (client_user_id);
    CREATE INDEX IF NOT EXISTS idx_meds_client ON client_medications (client_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_goals_client ON client_goals (client_user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_client ON sessions (client_user_id, quando DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_org ON sessions (org_id, quando DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_client ON session_tasks (client_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_consents_client ON client_consents (client_user_id, tipo);
    CREATE INDEX IF NOT EXISTS idx_docs_client ON client_documents (client_user_id);
    CREATE INDEX IF NOT EXISTS idx_reports_client ON reports (client_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs (org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_client ON audit_logs (client_user_id, created_at DESC);
    -- PLANO DE AÇÃO: um plano por paciente (foco + passos práticos), gerado pela IA,
    -- revisado pelo mentor e, quando ele quiser, entregue ao paciente no app.
    CREATE TABLE IF NOT EXISTS action_plans (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      foco TEXT,
      passos JSONB DEFAULT '[]',
      entregue BOOLEAN DEFAULT false,
      gerado_em TIMESTAMPTZ,
      entregue_em TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('  Banco: tabelas prontas (users, invite_codes, messages, profiles, checkins).');
}

const JWT_SECRET = process.env.JWT_SECRET || 'defina-JWT_SECRET-no-env';
const norm = e => String(e || '').trim().toLowerCase();

// planos comerciais TriLumen
export const PLANOS = {
  essencial:    { nome: 'TRILUMEN ESSENCIAL',    limite: 30,  preco: 99.90,  preco_anual: 989.00 },
  profissional: { nome: 'TRILUMEN PROFISSIONAL', limite: 100, preco: 179.90, preco_anual: 1890.00 },
  clinica:      { nome: 'TRILUMEN CLÍNICA',      limite: 250, preco: 329.90, preco_anual: 3490.00 },
  premium:      { nome: 'TRILUMEN PREMIUM',      limite: 500, preco: 549.90, preco_anual: 5490.00 },
  // aliases legados (compatibilidade com organizações/links antigos)
  one:   { nome: 'TRILUMEN ESSENCIAL',    limite: 30,  preco: 99.90,  preco_anual: 989.00 },
  plus:  { nome: 'TRILUMEN PROFISSIONAL', limite: 100, preco: 179.90, preco_anual: 1890.00 },
  prime: { nome: 'TRILUMEN CLÍNICA',      limite: 250, preco: 329.90, preco_anual: 3490.00 }
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

// criação MANUAL de cliente pelo painel ADM (sem Asaas): gera usuário + senha temporária
export async function provisionarManual({ nome, email, plano, limite, vencimento }) {
  if (!pool) throw new Error('banco não configurado');
  email = norm(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('e-mail inválido');
  const p = PLANOS[String(plano || '').toLowerCase()] || PLANOS.essencial;
  const lim = Math.max(1, Math.min(2000, Number(limite) || p.limite));
  const nomeOrg = String(nome || email.split('@')[0]).trim();
  if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rows[0])
    throw new Error('Já existe uma conta com este e-mail.');
  const venc = (vencimento && /^\d{4}-\d{2}-\d{2}$/.test(vencimento)) ? vencimento : null;
  const org = await pool.query(
    `INSERT INTO organizations (nome, plano, limite_pessoas, status, origem, proximo_vencimento)
     VALUES ($1,$2,$3,'ativa','manual',$4) RETURNING id`,
    [nomeOrg, String(plano || 'essencial').toLowerCase(), lim, venc]);
  const orgId = org.rows[0].id;
  const username = slugUser(email);
  const senhaTemp = Math.random().toString(36).slice(2, 6) + Math.random().toString(36).slice(2, 6);
  const hash = await bcrypt.hash(senhaTemp, 10);
  await pool.query(
    `INSERT INTO users (email, name, password_hash, role, org_id, username, must_change_login, consent_at, last_seen_at)
     VALUES ($1,$2,$3,'mentor',$4,$5,true,now(),now())`,
    [email, nomeOrg, hash, orgId, username]);
  return { org_id: orgId, nome: nomeOrg, email, username, senha_temp: senhaTemp,
           plano: String(plano || 'essencial').toLowerCase(), plano_nome: p.nome, limite: lim };
}

// suspender / reativar uma licença
export async function setOrgStatus(orgId, status) {
  if (!pool || !orgId) throw new Error('banco não configurado');
  const st = status === 'ativa' ? 'ativa' : 'inativa';
  await pool.query('UPDATE organizations SET status=$2 WHERE id=$1', [orgId, st]);
  return { ok: true, status: st };
}

// alterar o limite de pacientes de um cliente
export async function setOrgLimite(orgId, limite) {
  if (!pool || !orgId) throw new Error('banco não configurado');
  const lim = Math.max(1, Math.min(2000, Number(limite) || 0));
  if (!lim) throw new Error('limite inválido');
  await pool.query('UPDATE organizations SET limite_pessoas=$2 WHERE id=$1', [orgId, lim]);
  return { ok: true, limite: lim };
}

// webhook: registra pagamento recebido + próximo vencimento na organização
export async function markOrgPagamento(subscription, proximoVencimento) {
  if (!pool || !subscription) return;
  if (proximoVencimento)
    await pool.query(`UPDATE organizations SET ultimo_pagamento=now(), status='ativa', proximo_vencimento=$2 WHERE asaas_subscription=$1`, [subscription, proximoVencimento]);
  else
    await pool.query(`UPDATE organizations SET ultimo_pagamento=now(), status='ativa' WHERE asaas_subscription=$1`, [subscription]);
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

// TODAS as organizações com uso e dados da assinatura (Central de Licenças — super-admin)
export async function listOrganizations() {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT o.id, o.nome, o.plano, o.limite_pessoas, o.status,
           o.asaas_subscription, o.asaas_customer, o.created_at,
           o.proximo_vencimento, o.ultimo_pagamento, COALESCE(o.origem,'asaas') AS origem,
           (SELECT count(*)::int FROM users u WHERE u.org_id=o.id AND u.role='paciente') AS pessoas,
           (SELECT u.email    FROM users u WHERE u.org_id=o.id AND u.role IN ('mentor','owner') ORDER BY u.id LIMIT 1) AS mentor_email,
           (SELECT u.username FROM users u WHERE u.org_id=o.id AND u.role IN ('mentor','owner') ORDER BY u.id LIMIT 1) AS mentor_username,
           (SELECT bool_or(u.must_change_login) FROM users u WHERE u.org_id=o.id AND u.role IN ('mentor','owner')) AS primeiro_acesso_pendente,
           (SELECT max(u.last_seen_at) FROM users u WHERE u.org_id=o.id AND u.role IN ('mentor','owner')) AS mentor_ultimo_acesso
    FROM organizations o ORDER BY o.created_at DESC`);
  return r.rows;
}

// checkouts do Asaas (assinatura → provisionamento)
export async function saveCheckout({ sub, customer, email, nome, plano, ciclo }) {
  if (!pool) return;
  await pool.query(`INSERT INTO checkouts (asaas_subscription, asaas_customer, email, nome, plano, ciclo)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (asaas_subscription) DO NOTHING`,
    [sub, customer, norm(email), nome, plano, ciclo === 'anual' ? 'anual' : 'mensal']);
}
export async function getCheckoutBySub(sub) {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM checkouts WHERE asaas_subscription=$1', [sub]);
  return r.rows[0] || null;
}
export async function markCheckoutProvisioned(sub) {
  if (!pool) return;
  await pool.query("UPDATE checkouts SET status='provisionado', provisioned_at=now() WHERE asaas_subscription=$1", [sub]);
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
             AND m3.meta->>'risco'='ALTO' AND m3.created_at > now() - interval '7 days') AS risco_recente,
           (SELECT p.mapa_risco FROM profiles p WHERE p.user_id=u.id) AS mapa_risco
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
//  MAPA INICIAL (questionário do 1º acesso)
// =========================================================
export async function mapaNeeded(userId) {
  if (!pool || !userId) return false;
  const r = await pool.query('SELECT mapa_em FROM profiles WHERE user_id=$1', [userId]);
  return !r.rows[0] || !r.rows[0].mapa_em;      // ainda não respondeu
}
export async function getMapa(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT mapa, mapa_bussola, mapa_em, mapa_risco FROM profiles WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}
export async function getMapaBussola(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT mapa_bussola FROM profiles WHERE user_id=$1', [userId]);
  return r.rows[0]?.mapa_bussola || null;
}
export async function saveMapaInicial(userId, { escolhidas, bussola, risco }) {
  if (!pool || !userId) throw new Error('banco não configurado');
  await pool.query(`INSERT INTO profiles (user_id, mapa, mapa_bussola, mapa_em, mapa_risco)
    VALUES ($1,$2,$3,now(),$4)
    ON CONFLICT (user_id) DO UPDATE SET mapa=$2, mapa_bussola=$3, mapa_em=now(), mapa_risco=$4`,
    [userId, JSON.stringify(escolhidas || []), String(bussola || '').slice(0, 4000), !!risco]);
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

// todas as mensagens já enviadas ao paciente (para a linha do tempo)
export async function mentorMessagesAll(userId, limit = 40) {
  if (!pool || !userId) return [];
  const r = await pool.query(`SELECT texto, created_at FROM mentor_messages
    WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  return r.rows;
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
export async function overviewStats(orgId = null) {
  if (!pool) return null;
  const r = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM users u WHERE u.role='paciente' AND ($1::bigint IS NULL OR u.org_id=$1)) AS pessoas,
      (SELECT count(DISTINCT m.user_id)::int FROM messages m JOIN users u ON u.id=m.user_id
         WHERE m.created_at > now() - interval '30 days' AND ($1::bigint IS NULL OR u.org_id=$1)) AS jornadas,
      (SELECT count(DISTINCT m.user_id)::int FROM messages m JOIN users u ON u.id=m.user_id
         WHERE m.meta->>'risco'='ALTO' AND m.created_at > now() - interval '7 days' AND ($1::bigint IS NULL OR u.org_id=$1)) AS alertas,
      (SELECT count(*)::int FROM checkins c JOIN users u ON u.id=c.user_id
         WHERE c.day = (now() AT TIME ZONE 'America/Sao_Paulo')::date AND ($1::bigint IS NULL OR u.org_id=$1)) AS checkins_hoje`,
    [orgId]);
  return r.rows[0];
}

// evolução emocional agregada dos pacientes DA ORGANIZAÇÃO (média da tríade por dia)
export async function globalDaily(orgId = null, days = 30) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
           round(avg((m.meta->>'corpo')::numeric),1)    AS corpo,
           round(avg((m.meta->>'alma')::numeric),1)     AS alma,
           round(avg((m.meta->>'espirito')::numeric),1) AS espirito,
           round(avg((m.meta->>'intensidade')::numeric),1) AS intensidade
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.role='assistant' AND m.meta IS NOT NULL
      AND m.created_at > now() - ($2 || ' days')::interval
      AND ($1::bigint IS NULL OR u.org_id=$1)
    GROUP BY 1 ORDER BY 1`, [orgId, days]);
  return r.rows;
}

// emoções predominantes DA ORGANIZAÇÃO (para o gráfico de rosca)
export async function emotionsPredominant(orgId = null, days = 30) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT m.meta->>'emocao' AS emocao, count(*)::int AS n
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.role='assistant' AND m.meta->>'emocao' IS NOT NULL AND m.meta->>'emocao' <> ''
      AND m.created_at > now() - ($2 || ' days')::interval
      AND ($1::bigint IS NULL OR u.org_id=$1)
    GROUP BY 1 ORDER BY n DESC LIMIT 6`, [orgId, days]);
  return r.rows;
}

// =========================================================
//  ESCALAS DE ACOMPANHAMENTO (respostas + evolução)
// =========================================================
export async function saveScaleResponse(userId, scaleKey, { answers, raw, max, score }) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const r = await pool.query(
    `INSERT INTO scale_responses (user_id, scale_key, answers, raw, max, score)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
    [userId, String(scaleKey), JSON.stringify(answers), raw, max, score]);
  return r.rows[0];
}

// última resposta de cada escala do paciente (para saber o que já está em dia)
export async function latestScales(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT DISTINCT ON (scale_key) scale_key, score, raw, max, created_at
    FROM scale_responses WHERE user_id=$1
    ORDER BY scale_key, created_at DESC`, [userId]);
  return r.rows;
}

// histórico de UMA escala (para a linha de evolução)
export async function scaleHistory(userId, scaleKey, limit = 24) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT score, created_at,
           (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia
    FROM scale_responses WHERE user_id=$1 AND scale_key=$2
    ORDER BY created_at DESC LIMIT $3`, [userId, scaleKey, limit]);
  return r.rows.reverse();
}

// todas as respostas do paciente agrupadas por escala (para o painel do mentor)
export async function scalesForPatient(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT scale_key, score,
           (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia,
           created_at
    FROM scale_responses WHERE user_id=$1
    ORDER BY scale_key, created_at`, [userId]);
  return r.rows;
}

// =========================================================
//  PLANO DE AÇÃO (gerado pela IA, revisado e entregue pelo mentor)
// =========================================================
export async function getActionPlan(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT foco, passos, entregue, gerado_em, entregue_em FROM action_plans WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}
export async function saveActionPlan(userId, { foco, passos }) {
  if (!pool || !userId) throw new Error('banco não configurado');
  await pool.query(`INSERT INTO action_plans (user_id, foco, passos, gerado_em, updated_at)
    VALUES ($1,$2,$3,now(),now())
    ON CONFLICT (user_id) DO UPDATE SET foco=$2, passos=$3, gerado_em=now(), updated_at=now()`,
    [userId, String(foco || '').slice(0, 400), JSON.stringify(Array.isArray(passos) ? passos.slice(0, 8) : [])]);
  return getActionPlan(userId);
}
export async function setPlanDelivered(userId, entregue) {
  if (!pool || !userId) return;
  await pool.query(`UPDATE action_plans SET entregue=$2, entregue_em=CASE WHEN $2 THEN now() ELSE entregue_em END, updated_at=now()
    WHERE user_id=$1`, [userId, !!entregue]);
  return getActionPlan(userId);
}
// plano visível ao paciente (só se o mentor entregou)
export async function deliveredPlan(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT foco, passos, entregue_em FROM action_plans WHERE user_id=$1 AND entregue=true', [userId]);
  return r.rows[0] || null;
}

// =========================================================
//  CENTRAL FINANCEIRA DO CONSULTÓRIO (mentor, escopo por org)
// =========================================================
export async function getPatientPlan(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT valor, dia_vencimento, lembrete_dias, ativo FROM patient_plans WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}
export async function setPatientPlan(userId, { valor, dia_vencimento, lembrete_dias, ativo }) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const v = Math.max(0, Number(valor) || 0);
  const dia = Math.min(28, Math.max(1, Number(dia_vencimento) || 10));
  const lem = Math.min(30, Math.max(0, Number(lembrete_dias ?? 5)));
  await pool.query(`INSERT INTO patient_plans (user_id, valor, dia_vencimento, lembrete_dias, ativo, updated_at)
    VALUES ($1,$2,$3,$4,$5,now())
    ON CONFLICT (user_id) DO UPDATE SET valor=$2, dia_vencimento=$3, lembrete_dias=$4, ativo=$5, updated_at=now()`,
    [userId, v, dia, lem, ativo !== false]);
  return getPatientPlan(userId);
}
export async function patientReceivables(userId, limit = 24) {
  if (!pool || !userId) return [];
  const r = await pool.query(`SELECT id, descricao, valor, vencimento::text AS vencimento, status, pago_em, competencia
    FROM receivables WHERE user_id=$1 ORDER BY vencimento DESC LIMIT $2`, [userId, limit]);
  return r.rows;
}
export async function listReceivables(orgId, limit = 300) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT r.id, r.user_id, u.name AS paciente, r.descricao, r.valor, r.vencimento::text AS vencimento,
           r.status, r.pago_em, r.competencia,
           (r.status='pendente' AND r.vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS vencida
    FROM receivables r LEFT JOIN users u ON u.id=r.user_id
    WHERE ($1::bigint IS NULL OR r.org_id=$1)
    ORDER BY r.status='pendente' DESC, r.vencimento DESC LIMIT $2`, [orgId, limit]);
  return r.rows;
}
export async function addReceivable({ orgId, userId, descricao, valor, vencimento, competencia }) {
  if (!pool) throw new Error('banco não configurado');
  const v = Number(valor); if (!(v > 0)) throw new Error('valor inválido');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(vencimento || ''))) throw new Error('vencimento inválido');
  const r = await pool.query(`INSERT INTO receivables (org_id, user_id, descricao, valor, vencimento, competencia)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [orgId, userId || null, String(descricao || 'Mensalidade').slice(0, 120), v, vencimento, competencia || null]);
  return r.rows[0];
}
export async function setReceivablePaid(id, orgId, pago) {
  if (!pool) throw new Error('banco não configurado');
  await pool.query(`UPDATE receivables SET status=$3, pago_em=CASE WHEN $3='pago' THEN now() ELSE NULL END
    WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)`, [id, orgId, pago ? 'pago' : 'pendente']);
  return { ok: true };
}
export async function listPayables(orgId, limit = 200) {
  if (!pool) return [];
  const r = await pool.query(`SELECT id, descricao, valor, vencimento::text AS vencimento, status, pago_em,
      (status='pendente' AND vencimento IS NOT NULL AND vencimento < (now() AT TIME ZONE 'America/Sao_Paulo')::date) AS vencida
    FROM payables WHERE ($1::bigint IS NULL OR org_id=$1)
    ORDER BY status='pendente' DESC, vencimento DESC NULLS LAST LIMIT $2`, [orgId, limit]);
  return r.rows;
}
export async function addPayable(orgId, { descricao, valor, vencimento }) {
  if (!pool) throw new Error('banco não configurado');
  const v = Number(valor); if (!(v > 0)) throw new Error('valor inválido');
  if (!String(descricao || '').trim()) throw new Error('descreva a despesa');
  const venc = /^\d{4}-\d{2}-\d{2}$/.test(String(vencimento || '')) ? vencimento : null;
  const r = await pool.query(`INSERT INTO payables (org_id, descricao, valor, vencimento) VALUES ($1,$2,$3,$4) RETURNING id`,
    [orgId, String(descricao).slice(0, 120), v, venc]);
  return r.rows[0];
}
export async function setPayablePaid(id, orgId, pago) {
  if (!pool) throw new Error('banco não configurado');
  await pool.query(`UPDATE payables SET status=$3, pago_em=CASE WHEN $3='pago' THEN now() ELSE NULL END
    WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)`, [id, orgId, pago ? 'pago' : 'pendente']);
  return { ok: true };
}
export async function deletePayable(id, orgId) {
  if (!pool) return;
  await pool.query('DELETE FROM payables WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)', [id, orgId]);
  return { ok: true };
}
export async function financeSummary(orgId) {
  if (!pool) return null;
  const r = await pool.query(`
    WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d)
    SELECT
      COALESCE((SELECT sum(valor) FROM receivables WHERE ($1::bigint IS NULL OR org_id=$1) AND status='pendente'),0) AS a_receber,
      COALESCE((SELECT sum(valor) FROM receivables WHERE ($1::bigint IS NULL OR org_id=$1) AND status='pendente'
        AND vencimento < (SELECT d FROM hoje)),0) AS vencido,
      COALESCE((SELECT sum(valor) FROM receivables WHERE ($1::bigint IS NULL OR org_id=$1) AND status='pago'
        AND date_trunc('month', pago_em AT TIME ZONE 'America/Sao_Paulo') = date_trunc('month',(SELECT d FROM hoje))),0) AS recebido_mes,
      COALESCE((SELECT sum(valor) FROM payables WHERE ($1::bigint IS NULL OR org_id=$1) AND status='pendente'),0) AS a_pagar
  `, [orgId]);
  return r.rows[0] || null;
}
// job: gera a mensalidade do mês para cada plano ativo (idempotente por competência)
export async function generateMonthlyReceivables() {
  if (!pool) return 0;
  const r = await pool.query(`
    WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d)
    INSERT INTO receivables (org_id, user_id, descricao, valor, vencimento, competencia)
    SELECT u.org_id, p.user_id, 'Mensalidade do acompanhamento', p.valor,
           make_date(extract(year from (SELECT d FROM hoje))::int, extract(month from (SELECT d FROM hoje))::int, p.dia_vencimento),
           to_char((SELECT d FROM hoje),'YYYY-MM')
    FROM patient_plans p JOIN users u ON u.id=p.user_id
    WHERE p.ativo=true AND p.valor > 0
    ON CONFLICT (user_id, competencia) WHERE competencia IS NOT NULL DO NOTHING
    RETURNING id`);
  return r.rowCount;
}
// job: contas a receber que vencem em N dias (do plano do paciente) e ainda não foram lembradas
export async function receivablesForReminder() {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT r.id, r.valor, r.vencimento::text AS vencimento, u.name AS paciente, u.email, u.phone,
           o.nome AS clinica
    FROM receivables r
    JOIN users u ON u.id=r.user_id
    JOIN patient_plans p ON p.user_id=r.user_id
    LEFT JOIN organizations o ON o.id=u.org_id
    WHERE r.status='pendente' AND r.lembrete_em IS NULL AND p.lembrete_dias > 0
      AND r.vencimento = ((now() AT TIME ZONE 'America/Sao_Paulo')::date + p.lembrete_dias)`);
  return r.rows;
}
export async function markReceivableReminded(id) {
  if (!pool) return;
  await pool.query('UPDATE receivables SET lembrete_em=now() WHERE id=$1', [id]);
}

// =========================================================
//  AGENDA DE CONSULTAS (mentor, escopo por org)
// =========================================================
const FMT_LOCAL = `to_char(quando AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD"T"HH24:MI')`;
export async function listAppointments(orgId, days = 45) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT a.id, a.user_id, u.name AS paciente, a.quando, ${FMT_LOCAL} AS quando_local,
           a.duracao_min, a.modalidade, a.local, a.obs, a.status,
           (a.quando < now()) AS passou
    FROM appointments a LEFT JOIN users u ON u.id=a.user_id
    WHERE ($1::bigint IS NULL OR a.org_id=$1)
      AND a.quando > now() - interval '7 days' AND a.quando < now() + ($2 || ' days')::interval
    ORDER BY a.quando`, [orgId, days]);
  return r.rows;
}
export async function patientAppointments(userId, limit = 20) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT id, ${FMT_LOCAL} AS quando_local, modalidade, local, status, (quando < now()) AS passou
    FROM appointments WHERE user_id=$1 ORDER BY quando DESC LIMIT $2`, [userId, limit]);
  return r.rows;
}
export async function addAppointment({ orgId, userId, quando, duracao_min, modalidade, local, obs }) {
  if (!pool) throw new Error('banco não configurado');
  if (!userId) throw new Error('escolha o paciente');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(quando || ''))) throw new Error('data/hora inválida');
  const mod = modalidade === 'presencial' ? 'presencial' : 'online';
  const r = await pool.query(`
    INSERT INTO appointments (org_id, user_id, quando, duracao_min, modalidade, local, obs)
    VALUES ($1,$2, ($3::timestamp AT TIME ZONE 'America/Sao_Paulo'), $4,$5,$6,$7) RETURNING id`,
    [orgId, userId, quando, Math.max(10, Math.min(240, Number(duracao_min) || 50)), mod,
     String(local || '').slice(0, 300), String(obs || '').slice(0, 400)]);
  return r.rows[0];
}
export async function setAppointmentStatus(id, orgId, status) {
  if (!pool) throw new Error('banco não configurado');
  const st = ['realizada', 'cancelada', 'agendada'].includes(status) ? status : 'agendada';
  await pool.query('UPDATE appointments SET status=$3 WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)', [id, orgId, st]);
  return { ok: true, status: st };
}
export async function deleteAppointment(id, orgId) {
  if (!pool) return;
  await pool.query('DELETE FROM appointments WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)', [id, orgId]);
  return { ok: true };
}
// consultas que precisam de lembrete: kind '1d' (dentro de 24h, >90min) ou '1h' (dentro de 90min)
export async function appointmentsForReminder(kind) {
  if (!pool) return [];
  const col = kind === '1h' ? 'lembrete_1h_em' : 'lembrete_1d_em';
  const janela = kind === '1h'
    ? "a.quando BETWEEN now() AND now() + interval '90 minutes'"
    : "a.quando BETWEEN now() + interval '90 minutes' AND now() + interval '24 hours'";
  const r = await pool.query(`
    SELECT a.id, a.modalidade, a.local, ${FMT_LOCAL} AS quando_local,
           u.name AS paciente, u.email, u.phone, o.nome AS clinica
    FROM appointments a JOIN users u ON u.id=a.user_id
    LEFT JOIN organizations o ON o.id=u.org_id
    WHERE a.status='agendada' AND a.${col} IS NULL AND ${janela}`);
  return r.rows;
}
export async function markAppointmentReminded(id, kind) {
  if (!pool) return;
  const col = kind === '1h' ? 'lembrete_1h_em' : 'lembrete_1d_em';
  await pool.query(`UPDATE appointments SET ${col}=now() WHERE id=$1`, [id]);
}

// =========================================================
//  MÓDULO DE CLIENTES — RBAC, cadastro, lista, perfil, auditoria (Etapa 3)
// =========================================================
export async function getMemberRole(orgId, userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2 AND ativo=true', [orgId, userId]);
  return r.rows[0]?.role || null;
}
export async function listOrgMembers(orgId) {
  if (!pool) return [];
  const r = await pool.query(`SELECT om.id, om.role, u.name, u.email FROM org_members om JOIN users u ON u.id=om.user_id
    WHERE ($1::bigint IS NULL OR om.org_id=$1) AND om.ativo=true ORDER BY u.name`, [orgId]);
  return r.rows;
}
export async function registrarAuditoria({ orgId, userId, clientId, acao, entidade, entidadeId, dados, ip }) {
  if (!pool) return;
  await pool.query(`INSERT INTO audit_logs (org_id, user_id, client_user_id, acao, entidade, entidade_id, dados, ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orgId || null, userId || null, clientId || null, acao, entidade || null, entidadeId != null ? String(entidadeId) : null,
     dados ? JSON.stringify(dados) : null, ip || null]);
}
export async function listAudit(orgId, clientId, limit = 100) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT a.acao, a.entidade, a.entidade_id, a.dados, a.created_at, u.name AS quem
    FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id
    WHERE ($1::bigint IS NULL OR a.org_id=$1) AND ($2::int IS NULL OR a.client_user_id=$2)
    ORDER BY a.created_at DESC LIMIT $3`, [orgId, clientId || null, limit]);
  return r.rows;
}
const codigoCliente = () => 'CLI-' + Math.random().toString(36).slice(2, 7).toUpperCase();

// CADASTRO RÁPIDO — cria o cliente (users role=paciente, SEM senha) + ficha estendida
export async function criarClienteRapido(orgId, criadorUid, d = {}) {
  if (!pool) throw new Error('banco não configurado');
  const nome = String(d.name || '').trim();
  if (nome.length < 2) throw new Error('Informe o nome do cliente.');
  let email = norm(d.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mail inválido.');
  if (!email) email = 'cliente_' + Date.now() + Math.random().toString(36).slice(2, 6) + '@sem-email.trilumen';
  if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rows[0]) throw new Error('Já existe um cadastro com este e-mail.');
  const nasc = /^\d{4}-\d{2}-\d{2}$/.test(String(d.birth || '')) ? d.birth : null;
  const u = await pool.query(
    `INSERT INTO users (email, name, password_hash, role, org_id, birth_date, phone, created_at)
     VALUES ($1,$2,'', 'paciente', $3, $4, $5, now()) RETURNING id`,
    [email, nome, orgId, nasc, String(d.phone || '').replace(/\D/g, '') || null]);
  const cid = u.rows[0].id;
  const codigo = codigoCliente();
  await pool.query(`INSERT INTO client_details
    (user_id, org_id, codigo, nome_social, whatsapp, tipo_acompanhamento, data_entrada, origem, status, canal_preferencial, obs_inicial, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [cid, orgId, codigo, String(d.nome_social || '').trim() || null, String(d.whatsapp || '').replace(/\D/g, '') || null,
     d.tipo_acompanhamento || null,
     /^\d{4}-\d{2}-\d{2}$/.test(String(d.data_entrada || '')) ? d.data_entrada : new Date().toISOString().slice(0, 10),
     d.origem || null, d.status || 'ativo', d.canal_preferencial || null, String(d.obs_inicial || '').slice(0, 500) || null, criadorUid || null]);
  await pool.query('INSERT INTO profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [cid]);
  if (d.member_id) await pool.query(
    `INSERT INTO client_professionals (org_id, client_user_id, member_id, principal) VALUES ($1,$2,$3,true)
     ON CONFLICT (client_user_id, member_id) DO NOTHING`, [orgId, cid, Number(d.member_id)]);
  await registrarAuditoria({ orgId, userId: criadorUid, clientId: cid, acao: 'cliente_criado', entidade: 'client', entidadeId: cid,
    dados: { nome, codigo }, ip: d.ip });
  return { id: cid, codigo, email: email.includes('@sem-email.') ? null : email };
}

export async function listClients(orgId, { q, status, limit = 200 } = {}) {
  if (!pool) return [];
  const r = await pool.query(`
    SELECT u.id, u.name, u.email, u.phone, u.created_at,
           cd.codigo, cd.status, cd.tipo_acompanhamento, cd.nome_social, cd.whatsapp,
           (u.password_hash <> '') AS tem_acesso,
           (SELECT m2.name FROM client_professionals cp JOIN org_members om ON om.id=cp.member_id
              JOIN users m2 ON m2.id=om.user_id WHERE cp.client_user_id=u.id AND cp.principal=true LIMIT 1) AS profissional
    FROM users u LEFT JOIN client_details cd ON cd.user_id=u.id
    WHERE u.role='paciente' AND ($1::bigint IS NULL OR u.org_id=$1) AND cd.deleted_at IS NULL
      AND ($2::text IS NULL OR $2='' OR lower(u.name) LIKE '%'||lower($2)||'%' OR cd.codigo ILIKE '%'||$2||'%' OR u.email ILIKE '%'||$2||'%')
      AND ($3::text IS NULL OR $3='' OR cd.status=$3)
    ORDER BY u.name LIMIT $4`, [orgId, q || null, status || null, limit]);
  return r.rows;
}

export async function getClientFull(userId) {
  if (!pool || !userId) return null;
  const [basic, det, prof, emerg, guard] = await Promise.all([
    pool.query(`SELECT id, name, email, phone, birth_date, marital_status, city, address, emergency_name, emergency_phone, photo,
       date_part('year', age(birth_date))::int AS idade, org_id, (password_hash <> '') AS tem_acesso FROM users WHERE id=$1`, [userId]),
    pool.query('SELECT * FROM client_details WHERE user_id=$1', [userId]),
    pool.query(`SELECT cp.id, cp.principal, om.role, u.name FROM client_professionals cp
       JOIN org_members om ON om.id=cp.member_id JOIN users u ON u.id=om.user_id WHERE cp.client_user_id=$1`, [userId]),
    pool.query('SELECT * FROM client_emergency_contacts WHERE client_user_id=$1 AND deleted_at IS NULL ORDER BY id', [userId]),
    pool.query('SELECT * FROM client_legal_guardians WHERE client_user_id=$1 AND deleted_at IS NULL ORDER BY id', [userId])
  ]);
  if (!basic.rows[0]) return null;
  return { basico: basic.rows[0], detalhes: det.rows[0] || null, profissionais: prof.rows, emergencia: emerg.rows, responsaveis: guard.rows };
}

export async function updateClientDetails(userId, orgId, updaterUid, d = {}) {
  if (!pool || !userId) throw new Error('banco não configurado');
  await pool.query(`UPDATE users SET name=COALESCE($2,name), phone=COALESCE($3,phone), birth_date=COALESCE($4,birth_date),
     marital_status=COALESCE($5,marital_status), city=COALESCE($6,city), address=COALESCE($7,address) WHERE id=$1 AND role='paciente'`,
    [userId, d.name || null, d.phone != null ? String(d.phone).replace(/\D/g, '') : null,
     /^\d{4}-\d{2}-\d{2}$/.test(String(d.birth || '')) ? d.birth : null, d.marital_status || null, d.city || null, d.address || null]);
  await pool.query(`INSERT INTO client_details (user_id, org_id, created_by, updated_by) VALUES ($1,$2,$3,$3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, orgId, updaterUid || null]);
  const cols = ['nome_social','sexo','genero','cpf','rg','profissao','empresa','escolaridade','idioma','whatsapp','cep','estado','pais','com_quem_reside','info_familiar','acessibilidade','obs','tipo_acompanhamento','origem','status','canal_preferencial'];
  const sets = [], vals = [userId]; let i = 2;
  for (const c of cols) if (d[c] !== undefined) { sets.push(`${c}=$${i++}`); vals.push(d[c] === '' ? null : d[c]); }
  if (d.possui_filhos !== undefined) { sets.push(`possui_filhos=$${i++}`); vals.push(!!d.possui_filhos); }
  if (d.qtd_filhos !== undefined) { sets.push(`qtd_filhos=$${i++}`); vals.push(Number(d.qtd_filhos) || null); }
  sets.push(`updated_by=$${i++}`); vals.push(updaterUid || null);
  sets.push('updated_at=now()');
  await pool.query(`UPDATE client_details SET ${sets.join(', ')} WHERE user_id=$1`, vals);
  await registrarAuditoria({ orgId, userId: updaterUid, clientId: userId, acao: 'cadastro_alterado', entidade: 'client', entidadeId: userId, ip: d.ip });
  return { ok: true };
}

// ---- helpers ----
const dateOrNull = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
const numOrNull = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);

// ---- SAÚDE (JSONB, sensível) ----
export async function getHealthProfile(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT dados, updated_at FROM client_health_profiles WHERE user_id=$1', [userId]);
  return r.rows[0] || null;
}
export async function saveHealthProfile(userId, orgId, dados, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  await pool.query(`INSERT INTO client_health_profiles (user_id, org_id, dados, updated_by, updated_at)
    VALUES ($1,$2,$3,$4,now()) ON CONFLICT (user_id) DO UPDATE SET dados=$3, updated_by=$4, updated_at=now()`,
    [userId, orgId, JSON.stringify(dados || {}), uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'saude_atualizada', entidade: 'client_health', entidadeId: userId });
  return { ok: true };
}
// ---- ESPIRITUAL (JSONB + opt-in) ----
export async function getSpiritualProfile(userId) {
  if (!pool || !userId) return null;
  const r = await pool.query('SELECT id, ativo, dados FROM client_spiritual_profiles WHERE client_user_id=$1 ORDER BY id LIMIT 1', [userId]);
  return r.rows[0] || null;
}
export async function saveSpiritualProfile(userId, orgId, ativo, dados, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const ex = await pool.query('SELECT id FROM client_spiritual_profiles WHERE client_user_id=$1 ORDER BY id LIMIT 1', [userId]);
  if (ex.rows[0]) await pool.query('UPDATE client_spiritual_profiles SET ativo=$2, dados=$3 WHERE id=$1', [ex.rows[0].id, !!ativo, JSON.stringify(dados || {})]);
  else await pool.query('INSERT INTO client_spiritual_profiles (org_id, client_user_id, ativo, dados, created_by) VALUES ($1,$2,$3,$4,$5)', [orgId, userId, !!ativo, JSON.stringify(dados || {}), uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'espiritual_atualizado', entidade: 'client_spiritual', entidadeId: userId });
  return { ok: true };
}
// ---- EMOCIONAL (avaliações ao longo do tempo; 1ª = linha de base) ----
export async function addEmotionalAssessment(userId, orgId, escalas, campos, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  await pool.query('INSERT INTO client_emotional_profiles (org_id, client_user_id, escalas, campos, created_by) VALUES ($1,$2,$3,$4,$5)',
    [orgId, userId, JSON.stringify(escalas || {}), JSON.stringify(campos || {}), uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'emocional_registrado', entidade: 'client_emotional', entidadeId: userId });
  return { ok: true };
}
export async function listEmotionalAssessments(userId, limit = 24) {
  if (!pool || !userId) return [];
  const r = await pool.query('SELECT id, escalas, campos, created_at FROM client_emotional_profiles WHERE client_user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
  return r.rows;
}
// ---- MEDICAMENTOS (estruturado; nunca apaga — suspende) ----
export async function listMedications(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query('SELECT * FROM client_medications WHERE client_user_id=$1 ORDER BY status, created_at DESC', [userId]);
  return r.rows;
}
export async function addMedication(userId, orgId, m, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  if (!String(m.nome || '').trim()) throw new Error('Informe o nome do medicamento.');
  const r = await pool.query(`INSERT INTO client_medications
    (org_id, client_user_id, nome, principio_ativo, dosagem, unidade, forma, frequencia, horarios, via, motivo, prescrito_por, especialidade,
     data_inicio, data_fim_prevista, uso_continuo, usando_atualmente, adesao, efeitos_positivos, efeitos_adversos, obs, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22) RETURNING id`,
    [orgId, userId, String(m.nome).trim(), m.principio_ativo || null, m.dosagem || null, m.unidade || null, m.forma || null, m.frequencia || null, m.horarios || null, m.via || null,
     m.motivo || null, m.prescrito_por || null, m.especialidade || null, dateOrNull(m.data_inicio), dateOrNull(m.data_fim_prevista), !!m.uso_continuo, m.usando_atualmente !== false,
     m.adesao || null, m.efeitos_positivos || null, m.efeitos_adversos || null, m.obs || null, uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'medicamento_criado', entidade: 'medication', entidadeId: r.rows[0].id, dados: { nome: m.nome } });
  return { id: r.rows[0].id };
}
export async function suspendMedication(id, orgId, clientId, motivo, dataSusp, uid) {
  if (!pool) throw new Error('banco não configurado');
  await pool.query(`UPDATE client_medications SET status='suspenso', usando_atualmente=false,
    data_suspensao=$3, motivo_suspensao=$4, updated_by=$5, updated_at=now() WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)`,
    [id, orgId, dateOrNull(dataSusp) || new Date().toISOString().slice(0, 10), motivo || null, uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId: clientId || null, acao: 'medicamento_suspenso', entidade: 'medication', entidadeId: id, dados: { motivo } });
  return { ok: true };
}
// ---- OBJETIVOS ----
export async function listGoals(userId) {
  if (!pool || !userId) return [];
  const r = await pool.query('SELECT * FROM client_goals WHERE client_user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC', [userId]);
  return r.rows;
}
export async function addGoal(userId, orgId, g, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  if (!String(g.titulo || '').trim()) throw new Error('Informe o título do objetivo.');
  const r = await pool.query(`INSERT INTO client_goals
    (org_id, client_user_id, titulo, descricao, categoria, prioridade, nota_inicial, meta, prazo, indicador, obstaculos, recursos, apoio, status, progresso, data_revisao, obs, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [orgId, userId, String(g.titulo).trim(), g.descricao || null, g.categoria || null, g.prioridade || null, numOrNull(g.nota_inicial), numOrNull(g.meta), dateOrNull(g.prazo),
     g.indicador || null, g.obstaculos || null, g.recursos || null, g.apoio || null, g.status || 'planejado', numOrNull(g.progresso) || 0, dateOrNull(g.data_revisao), g.obs || null, uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'objetivo_criado', entidade: 'goal', entidadeId: r.rows[0].id });
  return { id: r.rows[0].id };
}
export async function updateGoal(id, orgId, g, uid) {
  if (!pool) throw new Error('banco não configurado');
  await pool.query(`UPDATE client_goals SET status=COALESCE($3,status), progresso=COALESCE($4,progresso), obs=COALESCE($5,obs), data_revisao=COALESCE($6,data_revisao), updated_at=now()
    WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)`, [id, orgId, g.status || null, g.progresso != null ? numOrNull(g.progresso) : null, g.obs || null, dateOrNull(g.data_revisao)]);
  await registrarAuditoria({ orgId, userId: uid, clientId: null, acao: 'objetivo_alterado', entidade: 'goal', entidadeId: id });
  return { ok: true };
}
export async function deleteGoal(id, orgId) {
  if (!pool) return;
  await pool.query('UPDATE client_goals SET deleted_at=now() WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)', [id, orgId]);
  return { ok: true };
}

// ---- SESSÕES + PRONTUÁRIO (privado) + RESUMO (compartilhável) + TAREFAS ----
export async function listSessions(userId, { limit = 100 } = {}) {
  if (!pool || !userId) return [];
  const r = await pool.query(`
    SELECT s.id, s.quando, s.duracao_min, s.modalidade, s.tipo, s.status, s.created_at,
           u.name AS profissional,
           (sr.session_id IS NOT NULL) AS tem_prontuario,
           COALESCE(ss.compartilhado,false) AS resumo_compartilhado,
           (SELECT count(*)::int FROM session_tasks t WHERE t.session_id=s.id) AS tarefas
    FROM sessions s
    LEFT JOIN org_members om ON om.id=s.member_id
    LEFT JOIN users u ON u.id=om.user_id
    LEFT JOIN session_records sr ON sr.session_id=s.id
    LEFT JOIN session_shared_summaries ss ON ss.session_id=s.id
    WHERE s.client_user_id=$1 AND s.deleted_at IS NULL
    ORDER BY s.quando DESC NULLS LAST, s.id DESC LIMIT $2`, [userId, limit]);
  return r.rows;
}
export async function createSession(userId, orgId, s = {}, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  const quando = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s.quando || '')) ? s.quando : null;
  const r = await pool.query(`INSERT INTO sessions
    (org_id, client_user_id, member_id, quando, duracao_min, modalidade, tipo, status)
    VALUES ($1,$2,$3,
      CASE WHEN $4::text IS NULL THEN now() ELSE ($4::timestamp AT TIME ZONE 'America/Sao_Paulo') END,
      $5,$6,$7,$8) RETURNING id`,
    [orgId, userId, s.member_id ? Number(s.member_id) : null, quando, numOrNull(s.duracao_min) || 50,
     s.modalidade || null, s.tipo || null, s.status || 'realizada']);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'sessao_criada', entidade: 'session', entidadeId: r.rows[0].id });
  return { id: r.rows[0].id };
}
export async function getSessionFull(sessionId, orgId) {
  if (!pool || !sessionId) return null;
  const s = await pool.query(`SELECT s.*, u.name AS profissional FROM sessions s
     LEFT JOIN org_members om ON om.id=s.member_id LEFT JOIN users u ON u.id=om.user_id
     WHERE s.id=$1 AND ($2::bigint IS NULL OR s.org_id=$2) AND s.deleted_at IS NULL`, [sessionId, orgId]);
  if (!s.rows[0]) return null;
  const [rec, sum, tasks] = await Promise.all([
    pool.query('SELECT * FROM session_records WHERE session_id=$1', [sessionId]),
    pool.query('SELECT * FROM session_shared_summaries WHERE session_id=$1', [sessionId]),
    pool.query('SELECT * FROM session_tasks WHERE session_id=$1 ORDER BY created_at', [sessionId])
  ]);
  return { sessao: s.rows[0], prontuario: rec.rows[0] || null, resumo: sum.rows[0] || null, tarefas: tasks.rows };
}
export async function updateSession(id, orgId, clientId, s = {}, uid) {
  if (!pool) throw new Error('banco não configurado');
  const quando = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s.quando || '')) ? s.quando : null;
  await pool.query(`UPDATE sessions SET
     status=COALESCE($3,status), modalidade=COALESCE($4,modalidade), tipo=COALESCE($5,tipo),
     duracao_min=COALESCE($6,duracao_min),
     quando=CASE WHEN $7::text IS NULL THEN quando ELSE ($7::timestamp AT TIME ZONE 'America/Sao_Paulo') END,
     updated_at=now()
     WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)`,
    [id, orgId, s.status || null, s.modalidade || null, s.tipo || null, numOrNull(s.duracao_min), quando]);
  await registrarAuditoria({ orgId, userId: uid, clientId: clientId || null, acao: 'sessao_alterada', entidade: 'session', entidadeId: id });
  return { ok: true };
}
export async function deleteSession(id, orgId, clientId, uid) {
  if (!pool) return;
  await pool.query('UPDATE sessions SET deleted_at=now() WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)', [id, orgId]);
  await registrarAuditoria({ orgId, userId: uid, clientId: clientId || null, acao: 'sessao_excluida', entidade: 'session', entidadeId: id });
  return { ok: true };
}
const REC_COLS = ['demanda','estado_emocional_inicial','temas','intervencoes','percepcoes','evolucao','condutas','encaminhamentos','riscos','proximos_passos','obs_privadas'];
export async function saveSessionRecord(sessionId, orgId, clientId, d = {}, uid) {
  if (!pool || !sessionId) throw new Error('banco não configurado');
  const vals = REC_COLS.map(c => (d[c] != null && d[c] !== '') ? String(d[c]) : null);
  const ph = REC_COLS.map((_, i) => '$' + (i + 3));
  await pool.query(`INSERT INTO session_records (session_id, org_id, ${REC_COLS.join(', ')}, updated_at)
    VALUES ($1,$2, ${ph.join(', ')}, now())
    ON CONFLICT (session_id) DO UPDATE SET ${REC_COLS.map((c, i) => `${c}=$${i + 3}`).join(', ')}, updated_at=now()`,
    [sessionId, orgId, ...vals]);
  await registrarAuditoria({ orgId, userId: uid, clientId, acao: 'prontuario_salvo', entidade: 'session_record', entidadeId: sessionId });
  return { ok: true };
}
export async function saveSharedSummary(sessionId, orgId, clientId, d = {}, uid) {
  if (!pool || !sessionId) throw new Error('banco não configurado');
  const compart = !!d.compartilhado;
  await pool.query(`INSERT INTO session_shared_summaries
    (session_id, org_id, resumo, compartilhado, incluir_relatorio, permite_download, permite_impressao, compartilha_tarefas, shared_by, shared_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $4 THEN $9::int ELSE NULL END, CASE WHEN $4 THEN now() ELSE NULL END)
    ON CONFLICT (session_id) DO UPDATE SET resumo=$3, compartilhado=$4, incluir_relatorio=$5, permite_download=$6,
      permite_impressao=$7, compartilha_tarefas=$8,
      shared_by=CASE WHEN $4 THEN $9::int ELSE NULL END,
      shared_at=CASE WHEN $4 THEN COALESCE(session_shared_summaries.shared_at, now()) ELSE NULL END`,
    [sessionId, orgId, d.resumo || null, compart, !!d.incluir_relatorio, !!d.permite_download, !!d.permite_impressao, !!d.compartilha_tarefas, uid || null]);
  await registrarAuditoria({ orgId, userId: uid, clientId, acao: compart ? 'resumo_compartilhado' : 'resumo_salvo', entidade: 'session_summary', entidadeId: sessionId });
  return { ok: true };
}
export async function listSessionTasks(userId, { sessionId } = {}) {
  if (!pool || !userId) return [];
  const r = await pool.query(`SELECT * FROM session_tasks WHERE client_user_id=$1 AND ($2::bigint IS NULL OR session_id=$2)
    ORDER BY (status='concluida'), prazo NULLS LAST, created_at DESC`, [userId, sessionId || null]);
  return r.rows;
}
export async function addSessionTask(userId, orgId, sessionId, t = {}, uid) {
  if (!pool || !userId) throw new Error('banco não configurado');
  if (!String(t.titulo || '').trim()) throw new Error('Informe o título da tarefa.');
  const r = await pool.query(`INSERT INTO session_tasks (org_id, session_id, client_user_id, titulo, descricao, status, prazo, compartilhada)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [orgId, sessionId || null, userId, String(t.titulo).trim(), t.descricao || null, t.status || 'pendente', dateOrNull(t.prazo), t.compartilhada !== false]);
  await registrarAuditoria({ orgId, userId: uid, clientId: userId, acao: 'tarefa_criada', entidade: 'task', entidadeId: r.rows[0].id });
  return { id: r.rows[0].id };
}
export async function updateSessionTask(id, orgId, clientId, t = {}, uid) {
  if (!pool) throw new Error('banco não configurado');
  await pool.query(`UPDATE session_tasks SET titulo=COALESCE($3,titulo), descricao=COALESCE($4,descricao),
     status=COALESCE($5,status), prazo=COALESCE($6,prazo), compartilhada=COALESCE($7,compartilhada)
     WHERE id=$1 AND ($2::bigint IS NULL OR org_id=$2)`,
    [id, orgId, t.titulo || null, t.descricao || null, t.status || null, dateOrNull(t.prazo), t.compartilhada == null ? null : !!t.compartilhada]);
  await registrarAuditoria({ orgId, userId: uid, clientId: clientId || null, acao: 'tarefa_alterada', entidade: 'task', entidadeId: id });
  return { ok: true };
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
