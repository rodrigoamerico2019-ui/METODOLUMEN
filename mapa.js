// =========================================================
//  MAPA INICIAL — Método Lúmen
//  Questionário obrigatório no 1º acesso (múltipla escolha, em blocos:
//  emoções, história, corpo e vida espiritual).
//  Vira uma "bússola" que direciona a IA desde a primeira mensagem,
//  semeia o prontuário e aparece na ficha do mentor.
//  NÃO é diagnóstico — é ponto de partida, confirmado na conversa.
// =========================================================

export const MAPA = [
  // ---------- ALMA: como a pessoa está e como reage ----------
  { id: 'presente', tema: 'Alma · Hoje', pergunta: 'Hoje, na maior parte do tempo, eu me sinto:',
    opcoes: [
      { txt: 'Em paz, mesmo com os desafios', sinal: 'estabilidade emocional' },
      { txt: 'Ansioso(a) e acelerado(a)', sinal: 'ansiedade no presente' },
      { txt: 'Triste ou desanimado(a)', sinal: 'tristeza / desânimo' },
      { txt: 'No automático, anestesiado(a)', sinal: 'entorpecimento / desconexão' }
    ] },
  { id: 'peso', tema: 'Alma · O que pesa', pergunta: 'O que mais tem tirado a sua paz ultimamente?',
    opcoes: [
      { txt: 'Família, casamento ou relacionamento', sinal: 'principal fonte de dor: relações familiares/afetivas' },
      { txt: 'Dinheiro, trabalho ou falta de rumo profissional', sinal: 'principal fonte de dor: finanças/trabalho' },
      { txt: 'Saúde (minha ou de alguém que amo)', sinal: 'principal fonte de dor: saúde' },
      { txt: 'Um vazio que eu não sei explicar', sinal: 'vazio existencial / falta de sentido' }
    ] },
  { id: 'autoestima', tema: 'Alma · Autoestima', pergunta: 'Na maioria dos dias, eu me vejo como:',
    opcoes: [
      { txt: 'Alguém de valor, com meus altos e baixos', sinal: 'autoestima saudável' },
      { txt: 'Nunca bom(boa) o bastante', sinal: 'autocrítica / perfeccionismo' },
      { txt: 'Um peso, que decepciona os outros', sinal: 'autoimagem ferida / culpa' },
      { txt: 'Não sei bem quem eu sou', sinal: 'identidade difusa' }
    ] },
  { id: 'raiva', tema: 'Alma · Emoções', pergunta: 'Quando algo me irrita ou me machuca, eu costumo:',
    opcoes: [
      { txt: 'Falar com calma sobre o que senti', sinal: 'expressão emocional saudável' },
      { txt: 'Engolir e guardar só pra mim', sinal: 'repressão emocional' },
      { txt: 'Explodir e depois me arrepender', sinal: 'impulsividade / raiva reativa' },
      { txt: 'Ficar remoendo por dias', sinal: 'ruminação / mágoa acumulada' }
    ] },
  { id: 'culpa', tema: 'Alma · Culpa', pergunta: 'Sobre culpa, eu me identifico com:',
    opcoes: [
      { txt: 'Reconheço meus erros e sigo em frente', sinal: 'culpa saudável / responsabilidade' },
      { txt: 'Me cobro por tudo, até pelo que não é meu', sinal: 'culpa excessiva / hiper-responsabilidade' },
      { txt: 'Carrego algo que não consigo me perdoar', sinal: 'culpa não resolvida' },
      { txt: 'Sinto que mereço sofrer', sinal: 'autopunição', risco: true }
    ] },
  { id: 'crise', tema: 'Alma · Crises', pergunta: 'Quando chega um problema grande, eu:',
    opcoes: [
      { txt: 'Peço ajuda e enfrento', sinal: 'enfrentamento saudável' },
      { txt: 'Travo e não consigo agir', sinal: 'paralisia diante da crise' },
      { txt: 'Finjo que não está acontecendo', sinal: 'evitação / negação' },
      { txt: 'Desmorono e acho que não vou aguentar', sinal: 'colapso emocional nas crises', risco: true }
    ] },
  { id: 'aprovacao', tema: 'Alma · Aprovação', pergunta: 'Quando preciso decidir algo importante:',
    opcoes: [
      { txt: 'Escuto os outros, mas decido por mim', sinal: 'autonomia saudável' },
      { txt: 'Fico muito preso(a) ao que vão pensar', sinal: 'necessidade de aprovação' },
      { txt: 'Faço de tudo pra não decepcionar ninguém', sinal: 'padrão de agradar (people-pleasing)' },
      { txt: 'Me isolo pra ninguém interferir', sinal: 'evitação / autossuficiência ferida' }
    ] },
  { id: 'relacionamento', tema: 'Alma · Relacionamentos', pergunta: 'Nos meus relacionamentos mais próximos, eu costumo:',
    opcoes: [
      { txt: 'Me abrir e confiar com equilíbrio', sinal: 'vínculo seguro' },
      { txt: 'Ter medo de ser abandonado(a)', sinal: 'ferida de abandono / apego ansioso' },
      { txt: 'Me afastar quando chegam perto demais', sinal: 'evitação / muro afetivo' },
      { txt: 'Me anular pra manter a paz', sinal: 'submissão / perda de si' }
    ] },
  // ---------- HISTÓRIA: raízes e horizonte ----------
  { id: 'paternidade', tema: 'História · Pai', pergunta: 'Quando penso no meu pai (ou em quem fez esse papel):',
    opcoes: [
      { txt: 'Foi presente e me senti amado(a)', sinal: 'base paterna segura' },
      { txt: 'Esteve por perto, mas faltou afeto ou aprovação', sinal: 'carência de validação paterna' },
      { txt: 'Foi ausente, distante ou me machucou', sinal: 'ferida paterna / orfandade' },
      { txt: 'Prefiro não falar dele agora', sinal: 'ferida paterna sensível' }
    ] },
  { id: 'maternidade', tema: 'História · Mãe', pergunta: 'Quando penso na minha mãe (ou em quem fez esse papel):',
    opcoes: [
      { txt: 'Me senti acolhido(a) e cuidado(a)', sinal: 'base materna segura' },
      { txt: 'Cuidou, mas com cobrança ou controle', sinal: 'padrão de cobrança / perfeccionismo' },
      { txt: 'Foi ausente, distante ou me machucou', sinal: 'ferida materna / carência' },
      { txt: 'É uma relação difícil até hoje', sinal: 'conflito materno ativo' }
    ] },
  { id: 'passado', tema: 'História · Passado', pergunta: 'Quando olho para o meu passado, sinto:',
    opcoes: [
      { txt: 'Gratidão pelo que aprendi', sinal: 'passado integrado' },
      { txt: 'Saudade de um tempo que não volta', sinal: 'apego ao passado' },
      { txt: 'Dor ou arrependimento que ainda pesam', sinal: 'feridas do passado não curadas' },
      { txt: 'Vontade de esquecer tudo', sinal: 'trauma / evitação do passado', risco: true }
    ] },
  { id: 'futuro', tema: 'História · Futuro', pergunta: 'Quando penso no futuro:',
    opcoes: [
      { txt: 'Tenho esperança e sonhos', sinal: 'esperança / direção' },
      { txt: 'Sinto medo do que pode acontecer', sinal: 'ansiedade antecipatória' },
      { txt: 'Não consigo enxergar nada à frente', sinal: 'desesperança', risco: true },
      { txt: 'Prefiro não pensar, um dia de cada vez', sinal: 'modo sobrevivência / evitação' }
    ] },
  // ---------- CORPO: movimento, sono, alimentação e escapes ----------
  { id: 'corpo', tema: 'Corpo · Movimento', pergunta: 'Como está o cuidado com o seu corpo hoje?',
    opcoes: [
      { txt: 'Me movimento e cuido com regularidade', sinal: 'corpo cuidado / ativo' },
      { txt: 'Sei que preciso, mas ando parado(a)', sinal: 'sedentarismo / negligência do corpo' },
      { txt: 'Vivo cansado(a), sem energia', sinal: 'exaustão / possível somatização' },
      { txt: 'Não faço nenhuma atividade física há muito tempo', sinal: 'sedentarismo prolongado' }
    ] },
  { id: 'sono', tema: 'Corpo · Sono', pergunta: 'Como anda o seu sono?',
    opcoes: [
      { txt: 'Durmo bem e acordo descansado(a)', sinal: 'sono reparador' },
      { txt: 'Demoro a dormir, a cabeça não desliga', sinal: 'insônia inicial / mente acelerada' },
      { txt: 'Acordo várias vezes ou cedo demais', sinal: 'sono fragmentado' },
      { txt: 'Durmo muito e mesmo assim vivo cansado(a)', sinal: 'sono excessivo / desânimo' }
    ] },
  { id: 'alimentacao', tema: 'Corpo · Alimentação', pergunta: 'E a sua alimentação?',
    opcoes: [
      { txt: 'Equilibrada, como nos horários', sinal: 'alimentação equilibrada' },
      { txt: 'Pulo refeições, como correndo', sinal: 'rotina desregulada / descuido de si' },
      { txt: 'Como demais quando estou ansioso(a) ou triste', sinal: 'fome emocional' },
      { txt: 'Perdi o apetite ultimamente', sinal: 'perda de apetite (observar humor)' }
    ] },
  { id: 'escape', tema: 'Corpo · Alívio', pergunta: 'Para aguentar os dias mais pesados, eu tenho recorrido a:',
    opcoes: [
      { txt: 'Oração, conversa, exercício ou descanso', sinal: 'estratégias saudáveis de alívio' },
      { txt: 'Comida, compras, celular ou séries em excesso', sinal: 'escape pelo consumo / telas' },
      { txt: 'Álcool, cigarro ou remédio sem orientação', sinal: 'uso de substâncias como escape', risco: true },
      { txt: 'Nada — só vou aguentando', sinal: 'sobrecarga sem válvula de escape' }
    ] },
  // ---------- ESPÍRITO: relação com Deus e práticas ----------
  { id: 'deus', tema: 'Espírito · Deus', pergunta: 'Hoje, a minha relação com Deus é:',
    opcoes: [
      { txt: 'Próxima — me sinto filho(a) amado(a)', sinal: 'filiação (identidade de filho)' },
      { txt: 'Existe, mas distante ou por obrigação', sinal: 'fé morna / religiosidade' },
      { txt: 'Sinto que Ele está longe ou me abandonou', sinal: 'orfandade espiritual' },
      { txt: 'Tenho dúvidas ou mágoas com Ele', sinal: 'ferida espiritual / questionamento' }
    ] },
  { id: 'oracao', tema: 'Espírito · Oração', pergunta: 'Minha vida de oração hoje:',
    opcoes: [
      { txt: 'Oro com frequência, é uma conversa de verdade', sinal: 'vida de oração ativa' },
      { txt: 'Oro mais quando estou apertado(a)', sinal: 'oração em crise / fé de emergência' },
      { txt: 'Quase não oro mais', sinal: 'oração esfriada' },
      { txt: 'Não sei orar ou sinto que não sou ouvido(a)', sinal: 'bloqueio na oração / sensação de não ser ouvido' }
    ] },
  { id: 'palavra', tema: 'Espírito · Palavra', pergunta: 'Sobre a leitura da Bíblia:',
    opcoes: [
      { txt: 'Leio com frequência e ela me alimenta', sinal: 'Palavra como alimento diário' },
      { txt: 'Leio às vezes, sem constância', sinal: 'leitura bíblica irregular' },
      { txt: 'Tenho dificuldade de entender ou me concentrar', sinal: 'dificuldade com a Palavra (precisa de caminho simples)' },
      { txt: 'Não tenho esse hábito', sinal: 'sem hábito de leitura bíblica' }
    ] },
  { id: 'comunidade', tema: 'Espírito · Comunidade', pergunta: 'Em relação a uma igreja ou comunidade de fé:',
    opcoes: [
      { txt: 'Participo e me sinto parte', sinal: 'pertencimento à comunidade de fé' },
      { txt: 'Frequento, mas me sinto sozinho(a) lá dentro', sinal: 'solidão dentro da igreja' },
      { txt: 'Me afastei depois de uma decepção', sinal: 'ferida com a igreja / afastamento' },
      { txt: 'Não participo de nenhuma', sinal: 'sem comunidade de fé' }
    ] },
  { id: 'perdao', tema: 'Espírito · Perdão', pergunta: 'Existe alguém que você ainda não conseguiu perdoar?',
    opcoes: [
      { txt: 'Não, estou em paz com isso', sinal: 'perdão liberado' },
      { txt: 'Estou no processo de perdoar', sinal: 'perdão em processo' },
      { txt: 'Sim, e isso ainda me consome', sinal: 'mágoa não perdoada (ponto de cura)' },
      { txt: 'Sim — a mim mesmo(a)', sinal: 'dificuldade de se perdoar' }
    ] }
];

// catálogo para o app do paciente (sem os sinais internos)
export function catalogoMapa() {
  return MAPA.map(q => ({ id: q.id, tema: q.tema, pergunta: q.pergunta, opcoes: q.opcoes.map(o => o.txt) }));
}

// processa as respostas (array de índices) → sinais, risco e "bússola" para a IA
export function processarMapa(respostas) {
  if (!Array.isArray(respostas) || respostas.length !== MAPA.length)
    throw new Error('responda todas as perguntas do mapa inicial');
  const temasRisco = [];
  const escolhidas = MAPA.map((q, i) => {
    const idx = Math.round(Number(respostas[i]));
    if (!(idx >= 0 && idx < q.opcoes.length)) throw new Error('resposta inválida');
    const op = q.opcoes[idx];
    if (op.risco) temasRisco.push(q.tema);
    return { tema: q.tema, pergunta: q.pergunta, resposta: op.txt, sinal: op.sinal, idx };
  });
  const bussola =
`MAPA INICIAL DA PESSOA (bússola de partida que ela mesma respondeu no 1º acesso — use para DIRECIONAR a jornada com sensibilidade, confirmando com delicadeza na conversa; é ponto de partida, NUNCA um rótulo, e jamais leia isto em voz alta):
${escolhidas.map(e => `• ${e.tema}: ${e.sinal}`).join('\n')}
${temasRisco.length ? `\nATENÇÃO especial e acolhimento redobrado em: ${temasRisco.join(', ')}.` : ''}`;
  return { escolhidas, sinais: escolhidas.map(e => e.sinal), risco: temasRisco.length > 0, temas_risco: temasRisco, bussola };
}
