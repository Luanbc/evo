/**
 * Servidor de exemplo que recebe o webhook da Evolution (Node 18+, sem dependências).
 *
 *   WEBHOOK_TOKEN=<segredo de 32+ caracteres> PORTA=3333 node exemplos/webhook.mjs
 *   scripts/evo.sh webhook MeuProjeto "http://172.17.0.1:3333/webhook/whatsapp?token=<segredo>"
 *
 * (172.17.0.1 é o endereço do servidor visto de dentro do Docker. Em outro servidor, use o endereço público com HTTPS.)
 */
import http from 'node:http';
import { lerEvento, tokenConfere } from '../lib/webhook.js';

const TOKEN = process.env.WEBHOOK_TOKEN || '';
const PORTA = +(process.env.PORTA || 3333);
if (TOKEN.length < 16) { console.error('Defina WEBHOOK_TOKEN com pelo menos 16 caracteres.'); process.exit(1); }

http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (req.method !== 'POST' || url.pathname !== '/webhook/whatsapp') { res.writeHead(404).end(); return; }
    if (!tokenConfere(url.searchParams.get('token'), TOKEN)) { res.writeHead(401).end(); return; }
    let bruto = '';
    for await (const parte of req) { bruto += parte; if (bruto.length > 5e6) { res.writeHead(413).end(); return; } }
    res.writeHead(200).end('ok');                      // responde logo: a Evolution não deve esperar o processamento

    let ev;
    try { ev = lerEvento(JSON.parse(bruto)); } catch (e) { return; }
    switch (ev.tipo) {
        case 'conexao':
            console.log(`[${ev.instancia}] conexão: ${ev.estado}`);
            // ex.: avisar a equipe quando cair (ev.estado === 'close')
            break;
        case 'mensagem_recebida':
            if (ev.ehGrupo) break;
            console.log(`[${ev.instancia}] de ${ev.numero || ev.jid} (${ev.nome || '-'}): ${ev.texto || '[' + ev.tipoMensagem + ']'}`);
            // ex.: registrar a resposta "1 = recebi" no seu sistema
            break;
        case 'mensagem_enviada':
            console.log(`[${ev.instancia}] enviada para ${ev.numero || ev.jid}: ${ev.id}`);
            break;
        default:
            break;
    }
}).listen(PORTA, () => console.log(`webhook ouvindo na porta ${PORTA}`));
