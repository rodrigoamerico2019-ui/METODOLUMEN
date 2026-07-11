# LÚMEN — Servidor

O servidor que torna a Lúmen real: conversa com o **Claude de verdade** (natural, profunda, sem roteiro), dispara o **alerta de WhatsApp** sozinho em sinais de risco, e envia o **relatório por e-mail** ao fim de cada atendimento — mesmo se a pessoa sair no meio.

O app (a tela do celular) já vem dentro, na pasta `public/`.

---

## Pré-requisito

Instalar o **Node.js 18 ou superior**: https://nodejs.org (baixe a versão LTS).
Para conferir, abra o terminal e digite: `node -v`

---

## Passo 1 — Instalar

No terminal, dentro desta pasta:

```
npm install
```

## Passo 2 — Configurar

Copie o arquivo `.env.example` para `.env` e preencha:

```
cp .env.example .env
```

### a) IA (obrigatório para a conversa real)
1. Entre em https://console.anthropic.com
2. Crie uma **API Key** (menu *API Keys*).
3. Cole em `ANTHROPIC_API_KEY` no `.env`.

> É o que dá o diálogo humano de verdade. Sem essa chave, o app funciona só no "modo local".

### b) WhatsApp de emergência (alerta automático)
Escolha **um** provedor e ajuste `WHATSAPP_PROVIDER`:

- **Z-API** (mais simples no Brasil): crie uma instância em https://z-api.io, conecte seu WhatsApp por QR code e copie `ZAPI_INSTANCE`, `ZAPI_TOKEN` e `ZAPI_CLIENT_TOKEN`. Defina `WHATSAPP_PROVIDER=zapi`.
- **Twilio**: https://twilio.com — copie `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` e o número `TWILIO_WHATSAPP_FROM`. Defina `WHATSAPP_PROVIDER=twilio`.

O número que recebe os alertas fica em `GUARDIAN_PHONE` (já vem `5512996531629`).

### c) E-mail dos relatórios (envio automático)
Usando Gmail:
1. Ative a verificação em duas etapas na sua conta Google.
2. Gere uma **Senha de app** (Google → Segurança → Senhas de app).
3. Preencha `SMTP_USER` (seu e-mail) e `SMTP_PASS` (a senha de app de 16 dígitos).

Os relatórios chegam em `REPORT_EMAIL_TO` (já vem seu e-mail).

## Passo 3 — Rodar

```
npm start
```

Abra no navegador: **http://localhost:8080**

Pronto. O app abre já falando com o servidor. Embaixo da caixa de texto vai aparecer **"IA ativa"** quando a conversa real estiver funcionando.

---

## Testar rápido

- `http://localhost:8080/api/health` mostra o que está configurado (IA, WhatsApp, e-mail).
- Escreva algo com sinal de risco na conversa: o alerta sai pelo WhatsApp na hora.
- Toque em *"Encerrar e enviar relatório"* na aba Relatório: o e-mail é enviado.

Enquanto um provedor não estiver configurado, o servidor **registra no terminal** o que enviaria (bom pra testar sem gastar nada).

---

## Colocar no ar (opcional)

Para funcionar fora do seu computador, publique em um serviço como **Render** (https://render.com) ou **Railway** (https://railway.app):
1. Suba esta pasta para um repositório no GitHub.
2. Crie um "Web Service" apontando pro repositório.
3. Comando de start: `npm start`.
4. Adicione as mesmas variáveis do `.env` no painel do serviço.

---

## Importante (segurança e cuidado)

- A chave da API e as senhas ficam **só no servidor**, nunca no app. Não compartilhe o arquivo `.env`.
- A detecção de risco é uma **rede a mais**, não infalível. Ela **não substitui** profissional de saúde mental nem serviço de emergência. O app mantém o **CVV 188** sempre à mão da própria pessoa.
- Trate os dados dos atendimentos com sigilo — são informações sensíveis de pessoas reais.
