/**
 * Cliente mínimo da Evolution API v2 (WhatsApp via Baileys). Sem dependências: usa o fetch nativo
 * (Node 18+, Cloudflare Workers, Deno, navegador). Nunca lança erro por falha de rede: devolve { ok:false, erro }.
 *
 *   const evo = criarCliente({ url: 'http://127.0.0.1:8080', apiKey: process.env.EVO_KEY, instancia: 'MinhaInstancia' });
 *   await evo.estado();                         // 'open' | 'connecting' | 'close' | null (sem resposta)
 *   await evo.enviarTexto('98988887777', 'Olá!');
 */

/** "(98) 98888-7777" -> "5598988887777". Devolve "" quando não parece telefone brasileiro (DDD + 8 ou 9 dígitos). */
export function normalizarNumero(tel, ddi = '55') {
    let d = String(tel ?? '').replace(/\D/g, '');
    if (d.startsWith(ddi) && (d.length === ddi.length + 10 || d.length === ddi.length + 11)) return d;
    d = d.replace(/^0+/, '');
    if (d.length === 10 || d.length === 11) return ddi + d;
    return '';
}

/** Últimos 8 dígitos: identifica o mesmo telefone com ou sem o 9º dígito / DDI. */
export const chaveTelefone = tel => String(tel ?? '').replace(/\D/g, '').slice(-8);

export function criarCliente({ url, apiKey, instancia, timeoutMs = 15000, fetch: f = globalThis.fetch } = {}) {
    if (!url || !apiKey || !instancia) throw new Error('criarCliente: informe url, apiKey e instancia');
    const base = String(url).replace(/\/+$/, '');
    const inst = encodeURIComponent(instancia);

    async function chamar(metodo, caminho, corpo, tempo = timeoutMs) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), tempo);
        try {
            const r = await f(base + caminho, {
                method: metodo, signal: ctrl.signal,
                headers: { apikey: apiKey, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
                body: corpo ? JSON.stringify(corpo) : undefined
            });
            let dados = null;
            try { dados = await r.json(); } catch (e) { /* corpo vazio ou não-JSON */ }
            if (!r.ok) return { ok: false, status: r.status, dados, erro: mensagemDeErro(dados) || ('HTTP ' + r.status) };
            return { ok: true, status: r.status, dados };
        } catch (e) {
            return { ok: false, status: 0, erro: e.name === 'AbortError' ? 'tempo esgotado' : String(e.message || e) };
        } finally { clearTimeout(t); }
    }

    return {
        instancia,
        chamar,

        /** 'open' | 'connecting' | 'close' | null quando a API não respondeu */
        async estado() {
            const r = await chamar('GET', `/instance/connectionState/${inst}`, null, 8000);
            if (!r.ok) return null;
            const d = r.dados || {};
            return (d.instance && d.instance.state) || d.state || null;
        },

        /** Gera o QR Code. { ok, base64 (data URL png), pairingCode, count } */
        async conectar(numeroParaPareamento) {
            const q = numeroParaPareamento ? `?number=${normalizarNumero(numeroParaPareamento)}` : '';
            const r = await chamar('GET', `/instance/connect/${inst}${q}`, null, 30000);
            if (!r.ok) return r;
            const d = r.dados || {};
            return { ok: true, base64: d.base64 || null, pairingCode: d.pairingCode || null, count: d.count ?? null };
        },

        logout: () => chamar('DELETE', `/instance/logout/${inst}`),
        reiniciar: () => chamar('POST', `/instance/restart/${inst}`),

        /** { status: 'valido'|'invalido'|'formato_invalido'|'nao_verificado', numero, jid, numeroWhatsapp, motivo } */
        async verificarNumero(tel) {
            const numero = normalizarNumero(tel);
            if (!numero) return { status: 'formato_invalido', numero: '', motivo: 'O telefone precisa de DDD + 8 ou 9 dígitos.' };
            const r = await chamar('POST', `/chat/whatsappNumbers/${inst}`, { numbers: [numero] });
            const item = r.ok && Array.isArray(r.dados) ? r.dados[0] : null;
            if (item && item.exists === true) {
                const jid = item.jid || `${numero}@s.whatsapp.net`;
                // o WhatsApp devolve o número "real" (resolve o 9º dígito de números antigos)
                return { status: 'valido', numero, jid, numeroWhatsapp: String(jid).split('@')[0], motivo: 'WhatsApp ativo' };
            }
            if (item && item.exists === false) return { status: 'invalido', numero, motivo: 'Este número não tem conta no WhatsApp.' };
            return { status: 'nao_verificado', numero, motivo: 'A verificação não respondeu (' + (r.erro || 'resposta inesperada') + ').' };
        },

        /** { ok, id } — id é o key.id da mensagem no WhatsApp */
        async enviarTexto(tel, texto, { atrasoMs = 1200, digitando = true } = {}) {
            const numero = normalizarNumero(tel) || String(tel).replace(/\D/g, '');
            const r = await chamar('POST', `/message/sendText/${inst}`, {
                // "delay" no topo é o formato da v2; "options" é o formato antigo (o robô em produção usa este). Os dois juntos funcionam.
                number: numero, text: String(texto), delay: atrasoMs,
                options: { delay: atrasoMs, ...(digitando ? { presence: 'composing' } : {}) }
            }, 60000);
            return r.ok ? { ok: true, id: r.dados && r.dados.key && r.dados.key.id } : r;
        },

        /**
         * Documento (PDF etc.). Passe base64 (com ou sem "data:...;base64,") ou uma URL pública em `media`.
         * { ok, id }
         */
        async enviarDocumento(tel, { media, nomeArquivo = 'documento.pdf', mimetype = 'application/pdf', legenda } = {}) {
            const numero = normalizarNumero(tel) || String(tel).replace(/\D/g, '');
            const conteudo = String(media || '').replace(/^data:[^;]+;base64,/, '');
            const r = await chamar('POST', `/message/sendMedia/${inst}`, {
                number: numero, mediatype: 'document', mimetype, fileName: nomeArquivo, media: conteudo,
                ...(legenda ? { caption: legenda } : {})
            }, 120000);
            return r.ok ? { ok: true, id: r.dados && r.dados.key && r.dados.key.id } : r;
        },

        /**
         * Mensagens ENVIADAS por esta instância para o jid desde `desdeSeg` (epoch em segundos), mais recentes primeiro.
         * Serve para conferir se algo realmente saiu. { ok, msgs: [{ id, ts, tipo, arquivo, texto }] }
         */
        async mensagensEnviadasPara(jid, desdeSeg, quantidade = 40) {
            const porPagina = Math.min(quantidade, 50);
            const paginas = Math.max(1, Math.ceil(quantidade / porPagina));
            const msgs = [];
            for (let pagina = 1; pagina <= paginas; pagina++) {
                const r = await chamar('POST', `/chat/findMessages/${inst}`, { where: { key: { remoteJid: jid } }, page: pagina, offset: porPagina }, 12000);
                const d = r.dados;
                const lista = r.ok ? ((d && d.messages && d.messages.records) || (d && d.records) || (Array.isArray(d) ? d : null)) : null;
                if (!Array.isArray(lista)) return pagina === 1 ? { ok: false, erro: r.erro || 'resposta inesperada' } : { ok: true, msgs };
                let maisAntiga = Infinity;
                for (const m of lista) {
                    const ts = Number(m && m.messageTimestamp) || 0;
                    maisAntiga = Math.min(maisAntiga, ts);
                    if (!m || !m.key || !(m.key.fromMe === true || m.key.fromMe === 'true') || ts < desdeSeg) continue;
                    const msg = m.message || {};
                    const doc = msg.documentMessage || msg.documentWithCaptionMessage?.message?.documentMessage || {};
                    const texto = msg.conversation || msg.extendedTextMessage?.text || '';
                    msgs.push({ id: m.key.id, ts, tipo: String(m.messageType || ''), arquivo: String(doc.fileName || doc.title || ''), texto: String(texto) });
                }
                if (lista.length < porPagina || maisAntiga < desdeSeg) break;
            }
            return { ok: true, msgs };
        },

        /** Baixa a mídia de uma mensagem (pelo key.id). { ok, base64, mimetype, nomeArquivo } */
        async baixarMidia(idMensagem) {
            const r = await chamar('POST', `/chat/getBase64FromMediaMessage/${inst}`, { message: { key: { id: idMensagem } }, convertToMp4: false }, 60000);
            if (!r.ok) return r;
            const d = r.dados || {};
            return { ok: true, base64: d.base64 || null, mimetype: d.mimetype || null, nomeArquivo: d.fileName || null };
        }
    };
}

function mensagemDeErro(d) {
    if (!d) return '';
    const m = d.response && d.response.message;
    if (Array.isArray(m)) return m.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');
    return String(m || d.message || d.error || '');
}

/** Erros que indicam que a conexão com o WhatsApp caiu (não é culpa do número nem da mensagem). */
export function ehErroDeConexao(r) {
    if (!r || r.ok) return false;
    if (r.status === 0) return true;                                   // API não respondeu
    return /connection closed|not connected|connection.*(lost|failure)|precondition required|socket|timed? ?out|tempo esgotado/i
        .test(String(r.erro || '')) || r.status === 428 || r.status >= 502;
}
