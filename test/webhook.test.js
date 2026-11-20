import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lerEvento, tokenConfere } from '../lib/index.js';

test('lê mensagem recebida', () => {
    const ev = lerEvento({ event: 'messages.upsert', instance: 'T', data: {
        key: { remoteJid: '5598988887777@s.whatsapp.net', fromMe: false, id: 'ABC' }, pushName: 'Maria',
        message: { conversation: '1' }, messageType: 'conversation', messageTimestamp: 1795000000 } });
    assert.equal(ev.tipo, 'mensagem_recebida'); assert.equal(ev.numero, '5598988887777'); assert.equal(ev.texto, '1'); assert.equal(ev.nome, 'Maria');
});
test('lê legenda de documento, @lid sem número e evento em maiúsculas', () => {
    const ev = lerEvento({ event: 'MESSAGES_UPSERT', instance: 'T', data: {
        key: { remoteJid: '123456789@lid', fromMe: false, id: 'X' }, message: { documentMessage: { caption: 'segue' } } } });
    assert.equal(ev.texto, 'segue'); assert.equal(ev.numero, null); assert.equal(ev.temMidia, true);
});
test('lê conexão e status', () => {
    assert.deepEqual(lerEvento({ event: 'connection.update', instance: 'T', data: { state: 'close', statusReason: 401 } }),
        { tipo: 'conexao', instancia: 'T', estado: 'close', motivo: 401 });
    assert.equal(lerEvento({ event: 'messages.update', instance: 'T', data: { keyId: 'A', status: 'READ' } }).status, 'READ');
});
test('token do webhook', () => {
    assert.equal(tokenConfere('a'.repeat(32), 'a'.repeat(32)), true);
    assert.equal(tokenConfere('b'.repeat(32), 'a'.repeat(32)), false);
    assert.equal(tokenConfere('', ''), false);
});
