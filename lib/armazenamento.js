/**
 * Onde a fila guarda os itens. Dois prontos:
 *   armazenamentoMemoria()   — testes e protótipos (some ao reiniciar)
 *   armazenamentoSql(db)     — SQLite/D1. `db` no formato do Cloudflare D1 (prepare().bind().all/first/run);
 *                              para node:sqlite use deNodeSqlite(new DatabaseSync('fila.db')).
 * Para outro banco (Postgres, Mongo...), implemente os mesmos métodos.
 */

export const ESQUEMA_SQL = `
CREATE TABLE IF NOT EXISTS fila_whatsapp (
    id               TEXT PRIMARY KEY,
    chave            TEXT,              -- anti-dobro: o mesmo documento/aviso não entra duas vezes
    referencia       TEXT,              -- livre: id do registro no seu sistema
    numero           TEXT NOT NULL,     -- 55 + DDD + número
    numero_whatsapp  TEXT,              -- como o WhatsApp reconhece (resolve o 9º dígito)
    texto            TEXT,
    documento        TEXT,              -- JSON: { media, nomeArquivo, mimetype, legenda }
    status           TEXT NOT NULL DEFAULT 'PENDENTE',
    tentativas       INTEGER NOT NULL DEFAULT 0,
    criado_em        TEXT NOT NULL,
    processando_desde TEXT,
    enviado_em       TEXT,
    id_mensagem      TEXT,              -- key.id da mensagem no WhatsApp
    erro             TEXT
);
CREATE INDEX IF NOT EXISTS ix_fila_status ON fila_whatsapp (status, criado_em);
CREATE INDEX IF NOT EXISTS ix_fila_chave  ON fila_whatsapp (chave);
CREATE TABLE IF NOT EXISTS whatsapp_numeros (
    numero        TEXT PRIMARY KEY,
    existe        INTEGER,
    jid           TEXT,
    verificado_em TEXT
);`;

const CAMPOS = ['chave', 'referencia', 'numero', 'numero_whatsapp', 'texto', 'documento', 'status', 'tentativas',
    'criado_em', 'processando_desde', 'enviado_em', 'id_mensagem', 'erro'];

export function armazenamentoMemoria() {
    const itens = new Map();
    const copia = x => (x ? { ...x } : null);
    return {
        itens,
        async inserir(it) { itens.set(it.id, { ...it }); },
        async buscarPorChave(chave, situacoes) {
            return copia([...itens.values()].filter(i => i.chave === chave && situacoes.includes(i.status)).sort((a, b) => b.criado_em.localeCompare(a.criado_em))[0]);
        },
        async pendentes(limite) {
            return [...itens.values()].filter(i => i.status === 'PENDENTE').sort((a, b) => a.criado_em.localeCompare(b.criado_em)).slice(0, limite).map(copia);
        },
        async telefonesRecentes(desde) {
            return [...itens.values()].filter(i => i.status === 'PROCESSANDO' || (i.status === 'ENVIADO' && (i.enviado_em || '') >= desde)).map(i => i.numero);
        },
        async travar(ids, agora) {
            const ok = [];
            for (const id of ids) { const i = itens.get(id); if (i && i.status === 'PENDENTE') { Object.assign(i, { status: 'PROCESSANDO', processando_desde: agora, tentativas: (i.tentativas || 0) + 1 }); ok.push(id); } }
            return ok;
        },
        async atualizar(id, campos, statusEsperado) {
            const i = itens.get(id);
            if (!i || (statusEsperado && i.status !== statusEsperado)) return false;
            Object.assign(i, campos); return true;
        },
        async travadosAntes(limiteIso, limite) {
            return [...itens.values()].filter(i => i.status === 'PROCESSANDO' && (i.processando_desde || i.criado_em) < limiteIso).slice(0, limite).map(copia);
        },
        async cancelar(situacoes, agora) {
            let n = 0;
            for (const i of itens.values()) if (situacoes.includes(i.status)) { Object.assign(i, { status: 'CANCELADO', erro: 'cancelado em ' + agora, processando_desde: null }); n++; }
            return n;
        },
        async listar({ status, limite = 100 } = {}) {
            return [...itens.values()].filter(i => !status || i.status === status).sort((a, b) => b.criado_em.localeCompare(a.criado_em)).slice(0, limite).map(copia);
        }
    };
}

export function armazenamentoSql(db) {
    const marcas = n => Array(n).fill('?').join(',');
    return {
        async criarTabelas() { for (const s of ESQUEMA_SQL.split(';').map(x => x.trim()).filter(Boolean)) await db.prepare(s).run(); },
        async inserir(it) {
            const cols = ['id', ...CAMPOS.filter(c => it[c] !== undefined)];
            await db.prepare(`INSERT INTO fila_whatsapp (${cols.join(',')}) VALUES (${marcas(cols.length)})`).bind(...cols.map(c => it[c] ?? null)).run();
        },
        async buscarPorChave(chave, situacoes) {
            return (await db.prepare(`SELECT * FROM fila_whatsapp WHERE chave = ? AND status IN (${marcas(situacoes.length)}) ORDER BY criado_em DESC LIMIT 1`)
                .bind(chave, ...situacoes).first()) || null;
        },
        async pendentes(limite) {
            return ((await db.prepare(`SELECT * FROM fila_whatsapp WHERE status = 'PENDENTE' ORDER BY criado_em ASC LIMIT ?`).bind(limite).all()).results) || [];
        },
        async telefonesRecentes(desde) {
            const r = (await db.prepare(`SELECT numero FROM fila_whatsapp WHERE status = 'PROCESSANDO' OR (status = 'ENVIADO' AND enviado_em >= ?)`).bind(desde).all()).results || [];
            return r.map(x => x.numero);
        },
        async travar(ids, agora) {
            const ok = [];
            for (const id of ids) {   // um por um: o "AND status = 'PENDENTE'" impede dois processos de pegarem o mesmo item
                const r = await db.prepare(`UPDATE fila_whatsapp SET status = 'PROCESSANDO', processando_desde = ?, tentativas = tentativas + 1 WHERE id = ? AND status = 'PENDENTE'`).bind(agora, id).run();
                if (mudou(r)) ok.push(id);
            }
            return ok;
        },
        async atualizar(id, campos, statusEsperado) {
            const cols = Object.keys(campos).filter(c => CAMPOS.includes(c));
            if (!cols.length) return false;
            const r = await db.prepare(`UPDATE fila_whatsapp SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?${statusEsperado ? ' AND status = ?' : ''}`)
                .bind(...cols.map(c => campos[c] ?? null), id, ...(statusEsperado ? [statusEsperado] : [])).run();
            return mudou(r);
        },
        async travadosAntes(limiteIso, limite) {
            return ((await db.prepare(`SELECT * FROM fila_whatsapp WHERE status = 'PROCESSANDO' AND COALESCE(processando_desde, criado_em) < ? LIMIT ?`).bind(limiteIso, limite).all()).results) || [];
        },
        async cancelar(situacoes, agora) {
            const r = await db.prepare(`UPDATE fila_whatsapp SET status = 'CANCELADO', erro = ?, processando_desde = NULL WHERE status IN (${marcas(situacoes.length)})`)
                .bind('cancelado em ' + agora, ...situacoes).run();
            return (r && r.meta && r.meta.changes) || 0;
        },
        async listar({ status, limite = 100 } = {}) {
            const q = status ? db.prepare(`SELECT * FROM fila_whatsapp WHERE status = ? ORDER BY criado_em DESC LIMIT ?`).bind(status, limite)
                             : db.prepare(`SELECT * FROM fila_whatsapp ORDER BY criado_em DESC LIMIT ?`).bind(limite);
            return ((await q.all()).results) || [];
        }
    };
}

const mudou = r => Number((r && r.meta && r.meta.changes) ?? (r && r.changes) ?? 0) > 0;

/** Faz um DatabaseSync do node:sqlite (Node 22+) falar como o D1. */
export function deNodeSqlite(dbSync) {
    return {
        prepare(sql) {
            let params = [];
            const st = () => dbSync.prepare(sql);
            const api = {
                bind(...p) { params = p.map(v => (v === undefined ? null : v)); return api; },
                async all() { return { results: st().all(...params) }; },
                async first() { return st().get(...params) ?? null; },
                async run() { const r = st().run(...params); return { meta: { changes: Number(r.changes) } }; }
            };
            return api;
        }
    };
}
