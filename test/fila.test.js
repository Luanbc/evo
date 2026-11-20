import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { criarCliente, normalizarNumero, criarValidador, cacheSql, criarFila, armazenamentoMemoria, armazenamentoSql, deNodeSqlite } from '../lib/index.js';
import { evolutionFalsa } from './evolution-falsa.js';

const semEspera = async () => {};
function montar({ sql = false, opcoes = {}, ...falsa } = {}) {
    const evo = evolutionFalsa(falsa);
    const cliente = criarCliente({ url: 'http://evo.teste', apiKey: 'chave-teste', instancia: 'Teste', fetch: evo.fetch });
    let armazenamento, cache;
    if (sql) {
        const db = deNodeSqlite(new DatabaseSync(':memory:'));
        armazenamento = armazenamentoSql(db);
        cache = cacheSql(db);
    } else armazenamento = armazenamentoMemoria();
    const validador = criarValidador(cliente, cache);
    const fila = criarFila({ armazenamento, cliente, validador, esperar: semEspera, opcoes });
    return { evo, cliente, armazenamento, fila };
}

test('normaliza números brasileiros', () => {
    assert.equal(normalizarNumero('(98) 98888-7777'), '5598988887777');
    assert.equal(normalizarNumero('98 8888-7777'), '559888887777');
    assert.equal(normalizarNumero('5598988887777'), '5598988887777');
    assert.equal(normalizarNumero('8888-7777'), '');
});

for (const sql of [false, true]) {
    const nome = sql ? '[SQLite]' : '[memória]';

    test(`${nome} envia o lote e marca ENVIADO`, async () => {
        const { evo, armazenamento, fila } = montar({ sql });
        if (sql) await armazenamento.criarTabelas();
        await fila.adicionar({ numero: '98988880001', texto: 'Olá 1' });
        await fila.adicionar({ numero: '98988880002', texto: 'Olá 2', documento: { media: 'QUJD', nomeArquivo: 'doc.pdf' } });
        const r = await fila.rodada();
        assert.equal(r.enviados, 2);
        assert.equal(evo.s.enviadas.length, 3);                      // 1 texto + (texto + documento)
        const itens = await armazenamento.listar();
        assert.ok(itens.every(i => i.status === 'ENVIADO' && i.id_mensagem));
    });

    test(`${nome} não enfileira de novo a mesma chave (anti-dobro)`, async () => {
        const { armazenamento, fila } = montar({ sql });
        if (sql) await armazenamento.criarTabelas();
        assert.equal((await fila.adicionar({ numero: '98988880001', texto: 'a', chave: 'doc-1' })).ok, true);
        const dup = await fila.adicionar({ numero: '98988880001', texto: 'a', chave: 'doc-1' });
        assert.equal(dup.ok, false); assert.equal(dup.motivo, 'ja_na_fila');
        await fila.rodada();
        const dup2 = await fila.adicionar({ numero: '98988880001', texto: 'a', chave: 'doc-1' });
        assert.equal(dup2.motivo, 'ja_enviado');
        assert.equal((await fila.adicionar({ numero: '98988880001', texto: 'a', chave: 'doc-1', reenviar: true })).ok, true);
    });

    test(`${nome} mesmo telefone: só 1 por rodada (intervalo de 10 min)`, async () => {
        const { evo, armazenamento, fila } = montar({ sql });
        if (sql) await armazenamento.criarTabelas();
        await fila.adicionar({ numero: '98988880001', texto: 'filho 1' });
        await fila.adicionar({ numero: '(98) 98888-0001', texto: 'filho 2' });
        const r = await fila.rodada();
        assert.equal(r.enviados, 1); assert.equal(r.adiados, 1);
        assert.equal(evo.s.enviadas.length, 1);
    });

    test(`${nome} WhatsApp desconectado: não pega nada nem gasta tentativa`, async () => {
        const { evo, armazenamento, fila } = montar({ sql, estado: 'close' });
        if (sql) await armazenamento.criarTabelas();
        await fila.adicionar({ numero: '98988880001', texto: 'x' });
        const r = await fila.rodada();
        assert.equal(r.lote, 0); assert.match(r.motivo, /close/);
        const [it] = await armazenamento.listar();
        assert.equal(it.status, 'PENDENTE'); assert.equal(Number(it.tentativas), 0);
        assert.equal(evo.s.enviadas.length, 0);
    });

    test(`${nome} conexão cai no meio do lote: o resto volta para PENDENTE (não vira VERIFICAR)`, async () => {
        const { evo, armazenamento, fila } = montar({ sql, cairDepoisDe: 1 });
        if (sql) await armazenamento.criarTabelas();
        for (let i = 1; i <= 4; i++) await fila.adicionar({ numero: `9898888000${i}`, texto: 'aviso ' + i });
        const r = await fila.rodada();
        assert.equal(r.enviados, 1); assert.equal(r.parouPorConexao, true);
        const itens = await armazenamento.listar();
        assert.equal(itens.filter(i => i.status === 'ENVIADO').length, 1);
        assert.equal(itens.filter(i => i.status === 'PENDENTE').length, 3);
        assert.ok(itens.filter(i => i.status === 'PENDENTE').every(i => Number(i.tentativas) === 0));
        // voltou a conexão: a próxima rodada manda o resto
        evo.s.estado = 'open'; evo.s.cairDepoisDe = null;
        const r2 = await fila.rodada();
        assert.equal(r2.enviados, 3);
    });

    test(`${nome} número sem WhatsApp vira SEM_WHATSAPP e não é enviado`, async () => {
        const { evo, armazenamento, fila } = montar({ sql, semWhatsapp: ['5598988880009'] });
        if (sql) await armazenamento.criarTabelas();
        await fila.adicionar({ numero: '98988880009', texto: 'x' });
        await fila.adicionar({ numero: '98988880001', texto: 'y' });
        const r = await fila.rodada();
        assert.equal(r.semWhatsapp, 1); assert.equal(r.enviados, 1);
        assert.equal((await armazenamento.listar({ status: 'SEM_WHATSAPP' })).length, 1);
        assert.equal(evo.s.enviadas.length, 1);
    });

    test(`${nome} erro que não é de conexão: tenta de novo e vira ERRO na 3ª`, async () => {
        const { evo, armazenamento, fila } = montar({ sql });
        if (sql) await armazenamento.criarTabelas();
        await fila.adicionar({ numero: '98988880001', texto: 'x' });
        for (let i = 0; i < 3; i++) { evo.s.falharEnvio = { status: 400, mensagem: 'Bad Request' }; await fila.rodada(); }
        const [it] = await armazenamento.listar();
        assert.equal(it.status, 'ERRO'); assert.equal(Number(it.tentativas), 3); assert.match(it.erro, /Bad Request/);
    });

    test(`${nome} item travado: confere no WhatsApp antes de devolver`, async () => {
        let relogio = Date.parse('2026-11-20T12:00:00Z');
        const { evo, armazenamento } = montar({ sql });
        if (sql) await armazenamento.criarTabelas();
        const cliente = criarCliente({ url: 'http://evo.teste', apiKey: 'chave-teste', instancia: 'Teste', fetch: evo.fetch });
        const fila = criarFila({ armazenamento, cliente, esperar: semEspera, agora: () => relogio });
        await fila.adicionar({ numero: '98988880001', texto: 'já saiu' });
        await fila.adicionar({ numero: '98988880002', texto: 'não saiu' });
        const lote = await fila.pegarLote();
        assert.equal(lote.itens.length, 2);
        // o processo "caiu" depois de mandar só a primeira
        await cliente.enviarTexto('5598988880001', 'já saiu');
        relogio += 60 * 60000;                                        // 1 hora depois
        const r = await fila.recuperarTravados();
        assert.deepEqual([r.entregues, r.devolvidos], [1, 1]);
        const itens = await armazenamento.listar();
        assert.equal(itens.find(i => i.texto === 'já saiu').status, 'ENVIADO');
        assert.equal(itens.find(i => i.texto === 'não saiu').status, 'PENDENTE');
    });
}

test('validador usa o cache (não pergunta de novo ao WhatsApp)', async () => {
    const evo = evolutionFalsa();
    const cliente = criarCliente({ url: 'http://evo.teste', apiKey: 'chave-teste', instancia: 'Teste', fetch: evo.fetch });
    const validar = criarValidador(cliente);
    assert.equal((await validar('98988880001')).status, 'valido');
    assert.equal((await validar('98988880001')).doCache, true);
    assert.equal(evo.s.chamadas.filter(c => c.includes('whatsappNumbers')).length, 1);
});

test('cliente: chave errada e API fora do ar não lançam erro', async () => {
    const evo = evolutionFalsa();
    const errado = criarCliente({ url: 'http://evo.teste', apiKey: 'outra', instancia: 'Teste', fetch: evo.fetch });
    assert.equal((await errado.enviarTexto('98988880001', 'x')).ok, false);
    const fora = criarCliente({ url: 'http://evo.teste', apiKey: 'x', instancia: 'T', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(await fora.estado(), null);
    const r = await fora.enviarTexto('98988880001', 'x');
    assert.equal(r.ok, false); assert.equal(r.status, 0);
});
