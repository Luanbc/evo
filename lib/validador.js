/**
 * Validação de número com cache: evita perguntar ao WhatsApp toda vez (cada consulta conta como atividade do número).
 * Válido fica guardado 30 dias; "sem WhatsApp" 7 dias (a pessoa pode criar a conta depois).
 *
 *   const validar = criarValidador(cliente, cacheSql(db));
 *   const v = await validar('98988887777');   // { status, numero, jid, numeroWhatsapp, motivo, doCache }
 */
import { normalizarNumero } from './evolution.js';

export function criarValidador(cliente, cache = cacheMemoria(), { diasValido = 30, diasInvalido = 7, agora = () => Date.now() } = {}) {
    return async function validar(tel, { usarCache = true } = {}) {
        const numero = normalizarNumero(tel);
        if (!numero) return { status: 'formato_invalido', numero: '', motivo: 'O telefone precisa de DDD + 8 ou 9 dígitos.' };
        if (usarCache) {
            const c = await cache.get(numero).catch(() => null);
            if (c) {
                const dias = (agora() - Date.parse(c.verificadoEm)) / 86400000;
                if (c.existe && dias <= diasValido)
                    return { status: 'valido', numero, jid: c.jid, numeroWhatsapp: String(c.jid || '').split('@')[0] || numero, doCache: true, motivo: 'WhatsApp ativo (cache)' };
                if (!c.existe && dias <= diasInvalido)
                    return { status: 'invalido', numero, doCache: true, motivo: 'Número sem WhatsApp (cache)' };
            }
        }
        const v = await cliente.verificarNumero(numero);
        if (v.status === 'valido' || v.status === 'invalido') {
            await cache.set(numero, { existe: v.status === 'valido', jid: v.jid || null, verificadoEm: new Date(agora()).toISOString() }).catch(() => {});
        }
        return { ...v, doCache: false };
    };
}

export function cacheMemoria() {
    const m = new Map();
    return { get: async n => m.get(n) || null, set: async (n, v) => { m.set(n, v); }, apagar: async n => { m.delete(n); } };
}

/** Cache em tabela SQL (D1 ou o adaptador de node:sqlite em armazenamento-sql.js). */
export function cacheSql(db) {
    return {
        async get(numero) {
            const r = await db.prepare(`SELECT existe, jid, verificado_em FROM whatsapp_numeros WHERE numero = ?`).bind(numero).first();
            return r ? { existe: Number(r.existe) === 1, jid: r.jid, verificadoEm: r.verificado_em } : null;
        },
        async set(numero, v) {
            await db.prepare(`INSERT INTO whatsapp_numeros (numero, existe, jid, verificado_em) VALUES (?, ?, ?, ?)
                ON CONFLICT(numero) DO UPDATE SET existe = excluded.existe, jid = excluded.jid, verificado_em = excluded.verificado_em`)
                .bind(numero, v.existe ? 1 : 0, v.jid, v.verificadoEm).run();
        },
        async apagar(numero) { await db.prepare(`DELETE FROM whatsapp_numeros WHERE numero = ?`).bind(numero).run(); }
    };
}
