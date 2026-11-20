# Histórico de mudanças

## 1.1.0 — 20/11/2026

- Novo capítulo [0. Preparar o servidor](docs/00-preparar-servidor.md): Ubuntu do zero com usuário, chave SSH e login por senha desligado, fuso horário, atualizações automáticas, swap, firewall, fail2ban, Docker oficial com limite de logs, DNS (Registro.br, Cloudflare, domínio institucional) e Cloudflare Tunnel.
- `scripts/preparar-servidor.sh`: faz a preparação automaticamente; `--fechar-ssh` desliga a senha só depois de conferir que há chave.

## 1.0.0 — 20/11/2026

Primeira versão, separada do Controle CRC-Jud (robô "Rôsinha", em produção desde 22/09/2026).

- Docker: Evolution API v2.3.7 (fixada por digest), Postgres 15 e Redis 7; API presa a `127.0.0.1`.
- `scripts/evo.sh`: instancias, estado, criar, conectar (QR e código de pareamento), logout, reiniciar, destravar, webhook, validar, teste.
- `scripts/monitor.sh`: aviso quando uma instância muda de estado.
- Biblioteca: cliente da API, validador com cache, fila com intervalo, limite por telefone, anti-dobro e conferência de travados, armazenamento em memória e SQLite/D1, leitura de eventos do webhook.
- Mudança em relação à Rôsinha: a fila confere a conexão antes de **cada** mensagem; com a conexão caída, o item volta para PENDENTE sem gastar tentativa (antes virava "para verificar").
- Documentação completa em `docs/` e 23 testes com Evolution falsa.
