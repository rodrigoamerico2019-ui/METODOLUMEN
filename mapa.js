// =========================================================
//  MAPA INICIAL — Método Lúmen
//  Questionário obrigatório no 1º acesso (10 perguntas de múltipla escolha).
//  Vira uma "bússola" que direciona a IA desde a primeira mensagem,
//  semeia o prontuário e aparece na ficha do mentor.
//  NÃO é diagnóstico — é ponto de partida, confirmado na conversa.
// =========================================================

export const MAPA = [
  { id: 'paternidade', tema: 'Paternidade', pergunta: 'Quando penso no meu pai (ou em quem fez esse papel):',
    opcoes: [
      { txt: 'Foi presente e me senti amado(a)', sinal: 'base paterna segura' },
      { txt: 'Esteve por perto, mas faltou afeto ou aprovação', sinal: 'carência de validação paterna' },
      { txt: 'Foi ausente, distante ou me machucou', sinal: 'ferida paterna / orfandade' },
      { txt: 'Prefiro não falar dele agora', sinal: 'ferida paterna sensível' }
    ] },
  { id: 'maternidade', tema: 'Maternidade', pergunta: 'Quando penso na minha mãe (ou em quem fez esse papel):',
    opcoes: [
      { txt: 'Me senti acolhido(a) e cuidado(a)', sinal: 'base materna segura' },
      { txt: 'Cuidou, mas com cobrança ou controle', sinal: 'padrão de cobrança / perfeccionismo' },
      { txt: 'Foi ausente, distante ou me machucou', sinal: 'ferida materna / carência' },
      { txt: 'É uma relação difícil até hoje', sinal: 'conflito materno ativo' }
    ] },
  { id: 'autoestima', tema: 'Autoestima', pergunta: 'Na maioria dos dias, eu me vejo como:',
    opcoes: [
      { txt: 'Alguém de valor, com meus altos e baixos', sinal: 'autoestima saudável' },
      { txt: 'Nunca bom(boa) o bastante', sinal: 'autocrítica / perfeccionismo' },
      { txt: 'Um peso, que decepciona os outros', sinal: 'autoimagem ferida / culpa' },
      { txt: 'Não sei bem quem eu sou', sinal: 'identidade difusa' }
    ] },
  { id: 'corpo', tema: 'Corpo', pergunta: 'Como está o cuidado com o seu corpo hoje?',
    opcoes: [
      { txt: 'Me movimento e cuido com regularidade', sinal: 'corpo cuidado' },
      { txt: 'Sei que preciso, mas ando parado(a)', sinal: 'sedentarismo / negligência do corpo' },
      { txt: 'Vivo cansado(a), sem energia', sinal: 'exaustão / possível somatização' },
      { txt: 'Uso comida, tela ou sono pra fugir do que sinto', sinal: 'escape pelo corpo' }
    ] },
  { id: 'deus', tema: 'Deus', pergunta: 'Hoje, a minha relação com Deus é:',
    opcoes: [
      { txt: 'Próxima — me sinto filho(a) amado(a)', sinal: 'filiação (identidade de filho)' },
      { txt: 'Existe, mas distante ou por obrigação', sinal: 'fé morna / religiosidade' },
      { txt: 'Sinto que Ele está longe ou me abandonou', sinal: 'orfandade espiritual' },
      { txt: 'Tenho dúvidas ou mágoas com Ele', sinal: 'ferida espiritual / questionamento' }
    ] },
  { id: 'aprovacao', tema: 'Necessidade de aprovação', pergunta: 'Quando preciso decidir algo importante:',
    opcoes: [
      { txt: 'Escuto os outros, mas decido por mim', sinal: 'autonomia saudável' },
      { txt: 'Fico muito preso(a) ao que vão pensar', sinal: 'necessidade de aprovação' },
      { txt: 'Faço de tudo pra não decepcionar ninguém', sinal: 'padrão de agradar (people-pleasing)' },
      { txt: 'Me isolo pra ninguém interferir', sinal: 'evitação / autossuficiência ferida' }
    ] },
  { id: 'passado', tema: 'Passado', pergunta: 'Quando olho para o meu passado, sinto:',
    opcoes: [
      { txt: 'Gratidão pelo que aprendi', sinal: 'passado integrado' },
      { txt: 'Saudade de um tempo que não volta', sinal: 'apego ao passado' },
      { txt: 'Dor ou arrependimento que ainda pesam', sinal: 'feridas do passado não curadas' },
      { txt: 'Vontade de esquecer tudo', sinal: 'trauma / evitação do passado', risco: true }
    ] },
  { id: 'presente', tema: 'Presente', pergunta: 'Hoje, na maior parte do tempo, eu me sinto:',
    opcoes: [
      { txt: 'Em paz, mesmo com os desafios', sinal: 'estabilidade emocional' },
      { txt: 'Ansioso(a) e acelerado(a)', sinal: 'ansiedade no presente' },
      { txt: 'Triste ou desanimado(a)', sinal: 'tristeza / desânimo' },
      { txt: 'No automático, anestesiado(a)', sinal: 'entorpecimento / desconexão' }
    ] },
  { id: 'futuro', tema: 'Futuro', pergunta: 'Quando penso no futuro:',
    opcoes: [
      { txt: 'Tenho esperança e sonhos', sinal: 'esperança / direção' },
      { txt: 'Sinto medo do que pode acontecer', sinal: 'ansiedade antecipatória' },
      { txt: 'Não consigo enxergar nada à frente', sinal: 'desesperança', risco: true },
      { txt: 'Prefiro não pensar, um dia de cada vez', sinal: 'modo sobrevivência / evitação' }
    ] },
  { id: 'relacionamento', tema: 'Relacionamentos', pergunta: 'Nos meus relacionamentos mais próximos, eu costumo:',
    opcoes: [
      { txt: 'Me abrir e confiar com equilíbrio', sinal: 'vínculo seguro' },
      { txt: 'Ter medo de ser abandonado(a)', sinal: 'ferida de abandono / apego ansioso' },
      { txt: 'Me afastar quando chegam perto demais', sinal: 'evitação / muro afetivo' },
      { txt: 'Me anular pra manter a paz', sinal: 'submissão / perda de si' }
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
