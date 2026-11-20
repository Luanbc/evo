/** Evolution API de mentira, em memória, para testar sem WhatsApp de verdade. */
export function evolutionFalsa({ estado = 'open', semWhatsapp = [], ...outros } = {}) {
    const s = {
        estado, semWhatsapp: new Set(semWhatsapp), enviadas: [], chamadas: [],
        falharEnvio: null,           // { status, mensagem } para simular erro no próximo envio
        cairDepoisDe: null,          // número de envios até a conexão "cair"
        verificacaoMuda: false,      // whatsappNumbers sem resposta
        ...outros
    };
    async function fetch(url, init = {}) {
        const u = new URL(url);
        const corpo = init.body ? JSON.parse(init.body) : null;
        const [, grupo, acao] = u.pathname.split('/');
        s.chamadas.push(`${init.method || 'GET'} /${grupo}/${acao}`);
        const resp = (st, d) => ({ ok: st < 400, status: st, json: async () => d });
        if (init.headers?.apikey !== 'chave-teste') return resp(401, { message: 'Unauthorized' });
        if (grupo === 'instance' && acao === 'connectionState') return resp(200, { instance: { instanceName: 'Teste', state: s.estado } });
        if (grupo === 'chat' && acao === 'whatsappNumbers') {
            if (s.verificacaoMuda) return resp(500, { response: { message: ['timeout'] } });
            return resp(200, corpo.numbers.map(n => ({ number: n, exists: !s.semWhatsapp.has(n), jid: `${n}@s.whatsapp.net` })));
        }
        if (grupo === 'message' && (acao === 'sendText' || acao === 'sendMedia')) {
            if (s.estado !== 'open') return resp(500, { status: 500, error: 'Internal Server Error', response: { message: ['Error: Connection Closed'] } });
            if (s.falharEnvio) { const f = s.falharEnvio; s.falharEnvio = null; return resp(f.status, { response: { message: [f.mensagem] } }); }
            const id = 'MSG' + (s.enviadas.length + 1);
            s.enviadas.push({ id, numero: corpo.number, tipo: acao === 'sendText' ? 'conversation' : 'documentMessage', texto: corpo.text || '', arquivo: corpo.fileName || '', ts: Math.floor(Date.now() / 1000) });
            if (s.cairDepoisDe !== null && s.enviadas.length >= s.cairDepoisDe) s.estado = 'close';
            return resp(201, { key: { id, fromMe: true, remoteJid: `${corpo.number}@s.whatsapp.net` } });
        }
        if (grupo === 'chat' && acao === 'findMessages') {
            const jid = corpo.where.key.remoteJid;
            const recs = s.enviadas.filter(m => `${m.numero}@s.whatsapp.net` === jid).reverse().map(m => ({
                key: { id: m.id, fromMe: true, remoteJid: jid }, messageTimestamp: m.ts, messageType: m.tipo,
                message: m.tipo === 'conversation' ? { conversation: m.texto } : { documentMessage: { fileName: m.arquivo } }
            }));
            return resp(200, { messages: { total: recs.length, pages: 1, currentPage: 1, records: recs } });
        }
        return resp(404, { message: 'rota desconhecida ' + u.pathname });
    }
    return { s, fetch };
}
