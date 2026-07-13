# TRILUMEN — Plano de Implementação do Gêmeo Digital Emocional
> ETAPA ZERO da especificação `material/Raciocinio/atualizacao.txt`. Documento vivo. Última revisão: 2026-07-13.

## 1. Arquitetura ATUAL (auditoria do que existe)

| Camada | Hoje |
|---|---|
| **Frontend** | `public/index.html` (app do paciente, PWA) + `public/painel.html` (dashboard do mentor). HTML/CSS/JS puro, sem build. Marca preto+dourado (Cinzel/Montserrat). |
| **Backend** | `server.js` — Express (ESM), Node 24. Rotas REST. |
| **Banco** | `db.js` — Neon Postgres (sa-east-1). Tabelas: `users, invite_codes, messages, profiles, checkins, push_subs, mentor_messages, reminders_sent`. |
| **Auth** | JWT (30d) + bcrypt; convite obrigatório; `requireAuth` (paciente) e `requireAdmin` via `ADMIN_KEY` (mentor). |
| **IA** | Anthropic Opus 4.8 (chat) + Haiku (prontuário). Base de conhecimento em `knowledge/*.md` com prompt caching (~18k tokens). META por resposta (emoção/risco/status/tríade). |
| **Notificações** | Web Push (VAPID) + service worker `sw.js`. Lembretes automáticos (setInterval). |
| **Hospedagem** | Render (Starter). Deploy por `git push` (auto). Domínios: `metodolumen.onrender.com`, `painel.trilumen.com.br`. |
| **Arquivos** | Nenhum upload ainda (sem áudio/anexos). |

**Padrões atuais:** um único tenant implícito (o Método Lúmen). Sem RBAC granular (só paciente/admin). Sem organizações. Sem versionamento de IA/prompt. Sem audit log. Sem consentimento granular (só 1 checkbox no cadastro).

## 2. Distância até a especificação (gaps principais)
1. **Multi-tenant / organizações** — hoje tenant único. Falta `organizations`, `organization_settings`, `care_relationships`, `tenant_id` nas entidades.
2. **RBAC** — hoje 2 papéis. Faltam os 10 papéis e permissões por escopo.
3. **Gêmeo Digital** — hoje há `profiles.prontuario` (texto) + `checkins` + META. Falta a estrutura de 5 camadas, snapshots, baseline, dimensões, evidências rastreáveis.
4. **Áudio/voz** — inexistente. Pipeline completo a construir (upload, transcrição, indicadores acústicos).
5. **Consentimento granular + auditoria + rastreabilidade de IA** — parcial. Falta `consents`, `audit_logs`, `ai_runs`, saídas por schema.
6. **Tarefas / adesão / plano de jornada** — inexistente.
7. **Eventos idempotentes + jobs** — hoje há jobs simples (lembretes/prontuário). Falta o barramento de eventos.
8. **Aprendizado coletivo** — inexistente (é a 1ª fatia deste plano, ver §4).

## 3. Princípios inegociáveis (da spec) que guiam TODA entrega
- **Preservar o que funciona:** auth, rotas, identidade visual, Neon, deploy, features atuais. Nada de mudança visual arbitrária.
- **IA nunca diagnostica.** Linguagem de *indicador/tendência/hipótese/evidência insuficiente*. Sempre separar dado original × interpretação da IA. Nunca sobrescrever o original.
- **Privacidade primeiro (LGPD):** minimização, pseudonimização, consentimento, dados sensíveis nunca para treino sem base legal. **Nunca cruzar conteúdo identificável de uma pessoa no diálogo de outra.**
- **Entregas pequenas, reversíveis, testadas.** Migrations idempotentes (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`).

## 4. FATIA 1 (entregue agora) — Aprendizado Coletivo Anônimo
**Objetivo (pedido do Rodrigo):** a IA aprende diariamente com todas as jornadas e cada história soma na cura de todos — **preservando a memória individual** de cada pessoa no diálogo.

**Como (privacidade-safe):**
- Um job diário destila, de forma **anônima e agregada**, padrões de "o que costuma ajudar" a partir de: emoções predominantes, tendência coletiva das esferas, e o **acervo de vitórias/gratidões sem vínculo a pessoa** (nomes e identificadores removidos).
- Resultado = documento **SABEDORIA COLETIVA** (curto, temático, sem ninguém identificável), guardado em `collective_wisdom` (linha única).
- Esse documento entra como uma camada extra do system prompt de **todas** as conversas.
- **Garantia de memória individual:** cada diálogo continua vendo APENAS o prontuário e o histórico da própria pessoa. A IA é instruída a nunca revelar, citar ou trazer a história de terceiros. O coletivo entra como *intuição* ("o que tende a curar"), não como dado de outra pessoa.
- **Reversível:** flag `COLETIVO=on|off`. Tabela nova, nenhuma alteração destrutiva.

**Aceite:** (a) `collective_wisdom` populado sem nomes; (b) chat de um paciente nunca menciona outro; (c) desligar `COLETIVO` volta ao comportamento anterior.

## 5. Fases seguintes (ordem proposta — NÃO implementadas ainda)
- **F2 — Fundação multi-tenant + RBAC + consentimento granular + audit_log** (migrations aditivas; tenant default = "Método Lúmen").
- **F3 — Gêmeo Digital v1:** snapshots diários, baseline individual (7/14/30/60d), dimensões + evidências (`evidence_ids`), feedback profissional.
- **F4 — Tarefas & Plano de Jornada** (proposta→aceitar/adaptar/recusar→feedback).
- **F5 — Áudio/voz** (upload seguro, transcrição, resumo estruturado, indicadores acústicos — nunca "detecção de emoção").
- **F6 — Inteligência longitudinal** (heatmaps, ciclos, tempo de recuperação, mudança de baseline).
- **F7 — Wearables** (só a interface `WearableProvider`, sem inferência isolada).

Cada fase: anunciar mudança/arquivos/migrations/riscos/aceite → implementar → testar → mostrar → registrar.

## 6. Riscos & mitigação
- **Escopo enorme:** mitigar com fatias verticais reversíveis (esta é a primeira).
- **Privacidade no aprendizado coletivo:** só agregado/anônimo; nunca conteúdo identificável entre pessoas.
- **Custo de IA:** destilação coletiva com Haiku, 1×/dia, cacheada.
- **Regressão:** cada entrega roda `node --check`, testes manuais dos fluxos, e é reversível por flag/commit.

## 7. Rollback
Cada fatia é um commit isolado + flag de ambiente. Reverter = desligar a flag ou `git revert`. Migrations são aditivas (colunas/tabelas novas), sem drop de dado existente.
