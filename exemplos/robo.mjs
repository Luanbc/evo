/**
 * Robô de envio pronto para rodar: guarda a fila num SQLite local e envia em rodadas.
 *
 *   EVO_URL=http://127.0.0.1:8080 EVO_KEY=... EVO_INSTANCIA=MinhaInstancia node exemplos/robo.mjs
 *   ... node exemplos/robo.mjs --uma-vez        (uma rodada e sai: bom para cron)
 *
 * Variáveis: FILA_DB (padrão fila.db), RODADA_MIN (padrão 10), LOTE (10), INTERVALO_MIN_SEG (60), INTERVALO_MAX_SEG (180)
 * Requer Node 22+ (node:sqlite). Em outro banco, troque o armazenamento (veja lib/armazenamento.js).
 */
import { DatabaseSync } from 'node:sqlite';
import { criarCliente, criarValidador, cacheSql, criarFila, armazenamentoSql, deNodeSqlite } from '../lib/index.js';

const env = process.env;
for (const v of ['EVO_URL', 'EVO_KEY', 'EVO_INSTANCIA']) if (!env[v]) { console.error(`Defina ${v}.`); process.exit(1); }

const db = deNodeSqlite(new DatabaseSync(env.FILA_DB || 'fila.db'));
const armazenamento = armazenamentoSql(db);
await armazenamento.criarTabelas();
const cliente = criarCliente({ url: env.EVO_URL, apiKey: env.EVO_KEY, instancia: env.EVO_INSTANCIA });
const fila = criarFila({
    armazenamento, cliente, validador: criarValidador(cliente, cacheSql(db)),
    opcoes: { loteMax: +(env.LOTE || 10), intervaloMinSeg: +(env.INTERVALO_MIN_SEG || 60), intervaloMaxSeg: +(env.INTERVALO_MAX_SEG || 180) },
    log: (...a) => console.log(new Date().toLocaleString('pt-BR'), ...a)
});

let rodando = false;
async function umaRodada() {
    if (rodando) return;                    // nunca duas rodadas ao mesmo tempo no mesmo processo
    rodando = true;
    try { await fila.rodada(); } catch (e) { console.error('rodada falhou:', e); } finally { rodando = false; }
}

await umaRodada();
if (!process.argv.includes('--uma-vez')) setInterval(umaRodada, +(env.RODADA_MIN || 10) * 60000);
