/**
 * Leitura dos eventos que a Evolution manda para o webhook (POST com JSON).
 * Ligue o webhook com:  scripts/evo.sh webhook <inst> https://seu-sistema/webhook/whatsapp?token=<segredo>
 *
 *   const ev = lerEvento(corpoJson);
 *   if (ev.tipo === 'mensagem_recebida') ...   // ev.numero, ev.texto, ev.id, ev.nome, ev.temMidia
 *   if (ev.tipo === 'conexao') ...             // ev.estado: 'open' | 'connecting' | 'close'
 */

/** Normaliza o nome do evento: "MESSAGES_UPSERT" e "messages.upsert" viram "messages.upsert". */
export const nomeDoEvento = e => String(e || '').toLowerCase().replace(/_/g, '.');

/** Extrai o texto de qualquer tipo comum de mensagem. */
export function textoDaMensagem(message = {}) {
    return message.conversation
        || message.extendedTextMessage?.text
        || message.imageMessage?.caption
        || message.videoMessage?.caption
        || message.documentMessage?.caption
        || message.documentWithCaptionMessage?.message?.documentMessage?.caption
        || message.buttonsResponseMessage?.selectedDisplayText
        || message.listResponseMessage?.title
        || '';
}

/**
 * Transforma o corpo do webhook num objeto simples:
 *  { tipo: 'mensagem_recebida' | 'mensagem_enviada' | 'status_mensagem' | 'conexao' | 'qrcode' | 'outro', instancia, ... }
 */
export function lerEvento(corpo) {
    const evento = nomeDoEvento(corpo && corpo.event);
    const instancia = corpo && corpo.instance;
    const d = (corpo && corpo.data) || {};

    if (evento === 'connection.update') {
        return { tipo: 'conexao', instancia, estado: d.state || null, motivo: d.statusReason ?? null };
    }
    if (evento === 'qrcode.updated') {
        return { tipo: 'qrcode', instancia, base64: d.qrcode?.base64 || null, pairingCode: d.qrcode?.pairingCode || null };
    }
    if (evento === 'messages.upsert' || evento === 'send.message') {
        const m = Array.isArray(d) ? d[0] : d;                 // algumas versões mandam lista
        const key = m.key || {};
        const jid = String(key.remoteJidAlt || key.remoteJid || '');
        const ehGrupo = jid.endsWith('@g.us');
        const message = m.message || {};
        return {
            tipo: key.fromMe ? 'mensagem_enviada' : 'mensagem_recebida',
            instancia, id: key.id || null, jid, ehGrupo,
            numero: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : null,   // "@lid" não traz o número
            nome: m.pushName || null,
            texto: textoDaMensagem(message),
            tipoMensagem: m.messageType || Object.keys(message)[0] || null,
            temMidia: !!(message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage || message.documentWithCaptionMessage || message.stickerMessage),
            quando: m.messageTimestamp ? new Date(Number(m.messageTimestamp) * 1000).toISOString() : null
        };
    }
    if (evento === 'messages.update') {
        const u = Array.isArray(d) ? d[0] : d;
        return { tipo: 'status_mensagem', instancia, id: u.keyId || u.key?.id || null, status: u.status || null };   // ex.: DELIVERY_ACK, READ
    }
    return { tipo: 'outro', instancia, evento };
}

/** Comparação em tempo constante para o token do webhook. */
export function tokenConfere(recebido, esperado) {
    const a = String(recebido || ''), b = String(esperado || '');
    if (!b || b.length < 16) return false;                     // sem segredo configurado = recusa
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
}
