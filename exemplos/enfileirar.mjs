/**
 * Coloca uma mensagem na fila do robô (exemplos/robo.mjs usa o mesmo fila.db).
 *
 *   node exemplos/enfileirar.mjs 98988887777 "Olá! Sua certidão está pronta."
 *   node exemplos/enfileirar.mjs 98988887777 "Segue o documento." --pdf caminho/arquivo.pdf --chave certidao-123
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { criarCliente, criarFila, armazenamentoSql, deNodeSqlite } from '../lib/index.js';

const [numero, texto = ''] = process.argv.slice(2);
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
if (!numero) { console.error('uso: node exemplos/enfileirar.mjs <numero> "texto" [--pdf arquivo.pdf] [--chave x] [--reenviar]'); process.exit(1); }

const db = deNodeSqlite(new DatabaseSync(process.env.FILA_DB || 'fila.db'));
const armazenamento = armazenamentoSql(db);
await armazenamento.criarTabelas();
// enfileirar não fala com o WhatsApp; o cliente só é exigido pela fila
const cliente = criarCliente({ url: process.env.EVO_URL || 'http://127.0.0.1:8080', apiKey: process.env.EVO_KEY || '-', instancia: process.env.EVO_INSTANCIA || '-' });
const fila = criarFila({ armazenamento, cliente });

const pdf = arg('--pdf');
const documento = pdf ? { media: readFileSync(pdf).toString('base64'), nomeArquivo: basename(pdf), mimetype: 'application/pdf' } : null;
const r = await fila.adicionar({ numero, texto, documento, chave: arg('--chave'), reenviar: process.argv.includes('--reenviar') });
console.log(r.ok ? `na fila (id ${r.id})` : `não enfileirado: ${r.mensagem}`);
