// =========================================================
//  TERMO DE CONSENTIMENTO (LGPD — Lei 13.709/2018) do app do paciente.
//  Assinado na tela no 1º acesso. Ao mudar o texto, suba a VERSÃO:
//  quem assinou a versão anterior será convidado a assinar de novo.
//  Base redigida a partir do que o sistema realmente faz — revisar com
//  assessoria jurídica antes de considerar definitivo.
// =========================================================
export const TERMO_LGPD_VERSAO = '1.0';

export function textoTermoLGPD({ clinica, terapeuta } = {}) {
  const c = clinica || 'a clínica responsável pelo seu acompanhamento';
  const t = terapeuta ? ` (profissional responsável: ${terapeuta})` : '';
  return `TERMO DE CONSENTIMENTO PARA TRATAMENTO DE DADOS PESSOAIS E DADOS DE SAÚDE
Versão ${TERMO_LGPD_VERSAO} · Lei Geral de Proteção de Dados (Lei nº 13.709/2018)

1. QUEM CUIDA DOS SEUS DADOS
O responsável (controlador) pelos seus dados é ${c}${t}. O aplicativo é operado pela plataforma TRILUMEN, que trata os dados apenas para fazer o app funcionar, conforme as instruções da clínica.

2. QUAIS DADOS SÃO COLETADOS
• Dados de cadastro: nome, nome social, data de nascimento, telefone/WhatsApp, e-mail, cidade e foto (se você enviar).
• Dados do seu acompanhamento (dados sensíveis de saúde): conversas com a assistente Lúmen, mensagens de voz e suas transcrições, respostas do questionário inicial, check-ins, escalas, relatórios do seu dia, plano para dias difíceis e itens da sua caixa de esperança.
• Dados de pessoas da sua rede de apoio que você cadastrar: nome, relação com você e WhatsApp.
• Dados técnicos de uso: data e hora de acesso, endereço de internet (IP) e tipo de aparelho.

3. PARA QUE OS DADOS SÃO USADOS
• Apoiar o seu acompanhamento terapêutico e emocional, inclusive entre as sessões.
• Permitir que o seu terapeuta responsável acompanhe sua evolução, receba seus relatórios e uma pré-análise de apoio.
• Proteger a sua vida e a sua segurança: em sinais de risco, seu terapeuta é avisado e, em risco de vida, as pessoas da sua rede que você autorizou também podem ser avisadas.
• Enviar lembretes e mensagens do seu acompanhamento pelo app, WhatsApp ou e-mail.

4. INTELIGÊNCIA ARTIFICIAL
A assistente Lúmen usa inteligência artificial para conversar com você, organizar sua jornada, classificar como você está e gerar pré-análises para o terapeuta. A IA não faz diagnóstico e não substitui o profissional. Para funcionar, o conteúdo das conversas é processado por provedores de tecnologia de inteligência artificial e de envio de mensagens, que podem estar localizados fora do Brasil. Eles são contratados para processar os dados somente para essa finalidade.

5. QUEM PODE VER
Suas conversas e os dados do app são vistos apenas pelo seu terapeuta responsável. Outros profissionais da clínica não têm acesso a eles. Os dados não são vendidos. Aprendizados gerais da plataforma só podem usar informações anônimas, sem seu nome ou qualquer dado que identifique você.

6. POR QUANTO TEMPO
Os dados ficam guardados enquanto durar o seu acompanhamento e pelo prazo exigido pelas normas profissionais e legais. Depois disso são excluídos ou tornados anônimos.

7. SEUS DIREITOS
Você pode, a qualquer momento: confirmar se tratamos seus dados, acessá-los, corrigi-los, pedir uma cópia, pedir a exclusão, saber com quem foram compartilhados e revogar este consentimento. A revogação não afeta o que já foi feito antes dela e pode impedir o uso do app. Para exercer esses direitos, fale com o seu terapeuta ou com a clínica.

8. SEGURANÇA
Os dados são protegidos por senha individual, conexão segura e acesso restrito por perfil. Nenhum sistema é 100% imune a falhas; em caso de incidente relevante, você será informado.

9. IMPORTANTE
Este aplicativo é um apoio. Ele não substitui atendimento de urgência. Em risco imediato, ligue CVV 188 ou SAMU 192.

10. CONSENTIMENTO
Ao assinar abaixo, declaro que li e entendi este termo e autorizo, de forma livre, informada e específica, o tratamento dos meus dados pessoais e dos meus dados de saúde para as finalidades descritas acima, conforme os artigos 7º e 11 da LGPD.`;
}
