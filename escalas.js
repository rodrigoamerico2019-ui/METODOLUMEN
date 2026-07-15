// =========================================================
//  ESCALAS DE ACOMPANHAMENTO — Método Lúmen
//  Inspirado no que há de melhor em softwares clínicos (medir evolução
//  por dados), mas com a alma do Método: dimensões emocional E espiritual.
//  As escalas são respondidas pelo paciente com recorrência; o sistema
//  calcula a pontuação (0–100) no servidor e guarda a evolução.
//  NÃO são diagnóstico clínico — são um espelho da caminhada.
// =========================================================

// Opções Likert padrão (0 a 4). O índice é a pontuação bruta de cada resposta.
const FREQ = ['Nunca', 'Raramente', 'Às vezes', 'Frequentemente', 'Quase sempre'];

// direcao:
//   'maior_melhor' → pontuação alta = mais saúde/luz (bem-estar, autoconsciência, conexão)
//   'menor_melhor' → pontuação alta = mais sofrimento (ansiedade) — cair é evoluir
export const ESCALAS = [
  {
    key: 'bem-estar',
    titulo: 'Bem-Estar Emocional',
    descricao: 'Como sua alma tem se sentido nos últimos dias.',
    cor: '#7fb069',
    cadencia_dias: 7,
    direcao: 'maior_melhor',
    opcoes: FREQ,
    perguntas: [
      'Senti paz interior, mesmo diante das dificuldades.',
      'Acordei com esperança e vontade de viver o dia.',
      'Consegui sentir alegria em coisas simples.',
      'Me senti conectado(a) com as pessoas que amo.',
      'Percebi que estou no caminho certo da minha vida.'
    ],
    faixas: [
      { max: 39, rotulo: 'Precisa de cuidado', nota: 'A luz está encontrando resistência. Momento de acolhimento próximo.' },
      { max: 69, rotulo: 'Em travessia', nota: 'Há avanço, mas ainda com oscilações. Constância vai firmar.' },
      { max: 100, rotulo: 'Florescendo', nota: 'Sinais claros de bem-estar. Celebre e ancore o que está funcionando.' }
    ]
  },
  {
    key: 'ansiedade',
    titulo: 'Ansiedade e Inquietação',
    descricao: 'O quanto a inquietação tem pesado sobre você.',
    cor: '#d98b5f',
    cadencia_dias: 7,
    direcao: 'menor_melhor',
    opcoes: FREQ,
    perguntas: [
      'Senti o coração acelerado ou uma tensão no corpo sem motivo claro.',
      'Fiquei preocupado(a) com coisas que talvez nem aconteçam.',
      'Tive dificuldade para relaxar ou desligar a mente.',
      'O sono foi atrapalhado por pensamentos ou aflição.',
      'Senti um medo ou aperto no peito difícil de explicar.'
    ],
    faixas: [
      { max: 33, rotulo: 'Serenidade', nota: 'A ansiedade está sob cuidado. Bom sinal de regulação.' },
      { max: 66, rotulo: 'Alerta moderado', nota: 'A inquietação aparece. Vale trabalhar respiração, oração e rotina.' },
      { max: 100, rotulo: 'Inquietação alta', nota: 'O corpo está em alerta constante. Priorizar acolhimento e, se persistir, apoio profissional.' }
    ]
  },
  {
    key: 'autoconsciencia',
    titulo: 'Autoconsciência',
    descricao: 'O quanto você tem enxergado a si mesmo com clareza.',
    cor: '#c9a227',
    cadencia_dias: 14,
    direcao: 'maior_melhor',
    opcoes: FREQ,
    perguntas: [
      'Consegui nomear o que eu estava sentindo no momento em que sentia.',
      'Reconheci o que disparou minhas reações (meus gatilhos).',
      'Percebi padrões que se repetem na minha forma de reagir.',
      'Assumi minha parte no que aconteceu, sem me culpar nem culpar só os outros.',
      'Entendi do que eu realmente precisava por baixo da emoção.'
    ],
    faixas: [
      { max: 39, rotulo: 'Despertando', nota: 'A consciência ainda está se abrindo. Cada nomeação é um passo.' },
      { max: 69, rotulo: 'Enxergando', nota: 'Já há leitura de si. A pessoa começa a ser autora da própria história.' },
      { max: 100, rotulo: 'Lúcido(a)', nota: 'Alta clareza sobre si. Base sólida para escolhas livres.' }
    ]
  },
  {
    key: 'conexao-espiritual',
    titulo: 'Conexão com Deus',
    descricao: 'Da orfandade à filiação — como está sua relação com o Pai.',
    cor: '#8a7fd9',
    cadencia_dias: 14,
    direcao: 'maior_melhor',
    opcoes: FREQ,
    perguntas: [
      'Senti que sou amado(a) por Deus como filho(a), não pelo que faço.',
      'Percebi a presença de Deus no meu dia, mesmo nas horas difíceis.',
      'Confiei que posso entregar meus medos nas mãos de Deus.',
      'Me relacionei com Deus com intimidade (oração, gratidão, conversa).',
      'Minha identidade se firmou mais em ser filho(a) do que em ser órfão(ã).'
    ],
    faixas: [
      { max: 39, rotulo: 'Coração órfão', nota: 'A sensação de distância ainda fala alto. Terreno para reconstruir a filiação.' },
      { max: 69, rotulo: 'Reaproximando', nota: 'A confiança está sendo remendada. A filiação começa a brotar.' },
      { max: 100, rotulo: 'Coração de filho(a)', nota: 'Forte senso de pertencer ao Pai. Raiz de segurança e paz.' }
    ]
  }
];

const porChave = Object.fromEntries(ESCALAS.map(e => [e.key, e]));

// versão "pública" para o paciente/mentor (sem lógica interna, com o nº de opções)
export function catalogoEscalas() {
  return ESCALAS.map(e => ({
    key: e.key, titulo: e.titulo, descricao: e.descricao, cor: e.cor,
    cadencia_dias: e.cadencia_dias, direcao: e.direcao,
    opcoes: e.opcoes, perguntas: e.perguntas
  }));
}

export function escalaByKey(key) { return porChave[key] || null; }

// calcula a pontuação NO SERVIDOR (nunca confia no cliente)
// answers: array de índices (0..opcoes-1), um por pergunta
export function pontuar(key, answers) {
  const e = porChave[key];
  if (!e) throw new Error('escala desconhecida');
  if (!Array.isArray(answers) || answers.length !== e.perguntas.length)
    throw new Error('respostas incompletas');
  const maxOp = e.opcoes.length - 1;
  let raw = 0;
  const norm = answers.map(a => {
    const n = Math.max(0, Math.min(maxOp, Math.round(Number(a))));
    if (!Number.isFinite(Number(a))) throw new Error('resposta inválida');
    raw += n; return n;
  });
  const max = maxOp * e.perguntas.length;
  const score = Math.round((raw / max) * 100);
  return { answers: norm, raw, max, score, faixa: faixaDe(e, score) };
}

export function faixaDe(e, score) {
  const f = (e.faixas || []).find(x => score <= x.max) || (e.faixas || []).slice(-1)[0];
  return f ? { rotulo: f.rotulo, nota: f.nota } : null;
}

// rótulo/nota a partir da chave (para o painel do mentor)
export function faixaPorChave(key, score) {
  const e = porChave[key];
  return e ? faixaDe(e, score) : null;
}
