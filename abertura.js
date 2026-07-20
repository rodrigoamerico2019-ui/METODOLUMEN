// =========================================================
//  TRILÚMEN — abertura do dia
//  A IA abre a conversa citando o assunto REAL do último encontro
//  ("ontem a discussão com a sua irmã ainda estava entalada"),
//  nunca um vago "de onde paramos". E muda de jeito a cada dia.
// =========================================================

// Sete jeitos de abrir. A escolha gira pelo dia do ano, então a pessoa
// nunca recebe a mesma fórmula dois dias seguidos.
export const ABERTURAS = [
  'Pergunte o DESFECHO do que ficou pendente: ela conseguiu resolver? deu certo? o que aconteceu depois?',
  'Pergunte como foi o DIA dela desde então, ancorando na situação concreta que ela vivia.',
  'Comece afirmando o que você lembra do que ela viveu — sem pergunta nenhuma — e deixe o espaço aberto para ela continuar.',
  'Retome pelo SENTIMENTO: aquilo pesava de um jeito específico; pergunte como esse peso está hoje.',
  'Cheque o COMBINADO: se ela decidiu, prometeu ou pensou em fazer algo, pergunte diretamente se fez.',
  'Abra com uma observação sua sobre o padrão que apareceu da última vez, e convide-a a olhar junto.',
  'Se da última vez ela estava adiando, fugindo ou se enganando, retome com franqueza: cutuque de leve, sem acusar.'
];

export function comoFazTempo(dias) {
  const d = Number(dias);
  if (d === 0) return 'HOJE MAIS CEDO';
  if (d === 1) return 'ONTEM';
  if (d < 7) return `HÁ ${d} DIAS`;
  if (d < 14) return 'NA SEMANA PASSADA';
  if (d < 40) return `HÁ ${Math.round(d / 7)} SEMANAS`;
  return `HÁ ${Math.round(d / 30)} MESES`;
}

// devolve o texto do bloco, ou null quando não há encontro anterior
export function blocoAbertura(primeiroNome, periodo, ultimo, hoje = new Date()) {
  if (!ultimo || !ultimo.falas || !ultimo.falas.length) return null;
  const quando = comoFazTempo(ultimo.dias_atras);
  const diaDoAno = Math.floor((hoje.getTime() - Date.UTC(hoje.getUTCFullYear(), 0, 0)) / 864e5);
  const estilo = ABERTURAS[diaDoAno % ABERTURAS.length];
  return `ÚLTIMO ENCONTRO — foi ${quando}. Estas são as palavras da PRÓPRIA ${primeiroNome} naquele dia:
${ultimo.falas.map(f => '• "' + f + '"').join('\n')}
${ultimo.emocao ? `Como ela estava: ${ultimo.emocao}.` : ''}${ultimo.status ? ` Situação: ${ultimo.status}.` : ''}

COMO ABRIR ESTA CONVERSA (esta é a primeira mensagem de hoje):
1. Cumprimente: "Olá, ${primeiroNome}, ${periodo}."
2. Na MESMA abertura, retome o assunto CONCRETO acima — diga o que era, com as palavras do mundo real dela (o problema, a pessoa, a decisão, o lugar). Ela tem que sentir que você LEMBRA de verdade.
3. Jeito de hoje: ${estilo}

PROIBIDO na abertura: "de onde paramos", "continuando de onde você parou", "na nossa última conversa", "retomando o que conversamos", ou um "como você está se sentindo?" solto — tudo isso é VAGO e soa a robô. Nomeie o assunto.
  Errado: "Vamos continuar de onde paramos?"
  Certo:  "Olá, ${primeiroNome}, ${periodo}. Ontem a briga com a sua irmã ainda estava entalada. Conseguiu ligar pra ela?"
Não liste as falas nem diga que tem anotações — isso é a sua memória, não um documento. Continue CURTO (2 a 4 linhas).
Se o assunto era grave ou havia risco, abra com cuidado e acolhimento — nunca com leveza.`;
}
