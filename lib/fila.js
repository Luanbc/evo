/**
 * Fila de envio pelo WhatsApp com as proteções que funcionaram em produção:
 *
 *  - nunca envia com a conexão fora do ar: confere o estado antes do lote e antes de CADA mensagem;
 *    se a conexão cai no meio, o item volta para PENDENTE (não vira "para verificar" nem erro);
 *  - intervalo aleatório entre mensagens (padrão 60–180 s) e no máximo 1 mensagem a cada 10 min para o mesmo telefone;
 *  - confere o número antes de enviar (número sem WhatsApp vira SEM_WHATSAPP e não é tentado de novo);
 *  - proteção contra envio em dobro por "chave" (ex.: id do documento): não enfileira de novo o que já saiu ou já está na fila;
 *  - item travado (o processo caiu no meio) só volta para a fila depois de perguntar ao WhatsApp se a mensagem já saiu.
 *
 * Situações: PENDENTE → PROCESSANDO → ENVIADO | ERRO | SEM_WHATSAPP | VERIFICAR (não deu para confirmar) | CANCELADO
 *
 *   const fila = criarFila({ armazenamento: armazenamentoSql(db), cliente, validador });
 *   await fila.adicionar({ numero: '98988887777', texto: 'Olá!', chave: 'certidao-123' });
 *   await fila.rodada();   // chame a cada X minutos (cron, setInterval, n8n...)
 */
import { normalizarNumero, chaveTelefone, ehErroDeConexao } from './evolution.js';

export const SITUACOES = ['PENDENTE', 'PROCESSANDO', 'ENVIADO', 'ERRO', 'SEM_WHATSAPP', 'VERIFICAR', 'CANCELADO'];

const PADRAO = {
    loteMax: 10,                    // mensagens por rodada
    intervaloMinSeg: 60,            // espera entre uma mensagem e outra
    intervaloMaxSeg: 180,
    intervaloMesmoNumeroMin: 10,    // mesmo telefone: no máximo 1 mensagem nesse intervalo
    tentativasMax: 3,               // falhas (que não sejam queda de conexão) até virar ERRO
    minutosTrava: 45,               // PROCESSANDO há mais que isso = processo caiu no meio
    horasParaVerificar: 6,          // travado e sem como conferir por tanto tempo → VERIFICAR
    validarAntes: true
};

const esperarPadrao = ms => new Promise(r => setTimeout(r, ms));
const novoId = () => (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));

export function criarFila({ armazenamento, cliente, validador = null, opcoes = {}, agora = () => Date.now(), esperar = esperarPadrao, log = () => {} }) {
    if (!armazenamento || !cliente) throw new Error('criarFila: informe armazenamento e cliente');
    const o = { ...PADRAO, ...opcoes };
    const iso = ms => new Date(ms ?? agora()).toISOString();
    const validar = validador || (async tel => ({ ...(await cliente.verificarNumero(tel)), doCache: false }));

    async function adicionar({ numero, texto = '', documento = null, chave = null, referencia = null, reenviar = false }) {
        const n = normalizarNumero(numero);
        if (!n) return { ok: false, motivo: 'numero_invalido', mensagem: 'O telefone precisa de DDD + 8 ou 9 dígitos.' };
        if (!String(texto).trim() && !documento) return { ok: false, motivo: 'vazio', mensagem: 'Informe o texto ou o documento.' };
        if (chave && !reenviar) {
            const ja = await armazenamento.buscarPorChave(chave, ['PENDENTE', 'PROCESSANDO', 'ENVIADO', 'VERIFICAR']);
            if (ja) return { ok: false, motivo: ja.status === 'ENVIADO' ? 'ja_enviado' : 'ja_na_fila', item: ja,
                mensagem: ja.status === 'ENVIADO' ? `Já enviado em ${ja.enviado_em}.` : 'Já está na fila.' };
        }
        const item = { id: novoId(), chave, referencia, numero: n, texto: String(texto), documento: documento ? JSON.stringify(documento) : null,
            status: 'PENDENTE', tentativas: 0, criado_em: iso() };
        await armazenamento.inserir(item);
        return { ok: true, id: item.id };
    }

    /** Separa o próximo lote e trava como PROCESSANDO. Não pega nada se a conexão não estiver aberta. */
    async function pegarLote(limite = o.loteMax) {
        const estado = await cliente.estado();
        if (estado !== 'open') return { itens: [], motivo: `WhatsApp ${estado || 'sem resposta'}` };
        const candidatos = await armazenamento.pendentes(limite + 30);
        const recentes = new Set((await armazenamento.telefonesRecentes(iso(agora() - o.intervaloMesmoNumeroMin * 60000))).map(chaveTelefone));
        const itens = [];
        const resumo = { semWhatsapp: 0, adiados: 0 };
        for (const it of candidatos) {
            if (itens.length >= limite) break;
            const k = chaveTelefone(it.numero);
            if (recentes.has(k)) { resumo.adiados++; continue; }
            if (o.validarAntes) {
                const v = await validar(it.numero);
                if (v.status === 'invalido' || v.status === 'formato_invalido') {
                    await armazenamento.atualizar(it.id, { status: 'SEM_WHATSAPP', erro: v.motivo, enviado_em: iso() }, 'PENDENTE');
                    resumo.semWhatsapp++;
                    continue;
                }
                if (v.status !== 'valido') break;                  // validação sem resposta: não insiste nesta rodada
                it.numero_whatsapp = v.numeroWhatsapp;
            }
            recentes.add(k);
            itens.push(it);
        }
        const travados = await armazenamento.travar(itens.map(i => i.id), iso());   // só trava o que ainda estava PENDENTE
        const ok = itens.filter(i => travados.includes(i.id));
        for (const i of ok) {
            i.status = 'PROCESSANDO'; i.tentativas = Number(i.tentativas || 0) + 1;   // o mesmo que travar() gravou
            if (i.numero_whatsapp) await armazenamento.atualizar(i.id, { numero_whatsapp: i.numero_whatsapp });
        }
        return { itens: ok, ...resumo };
    }

    /** Envia um item já travado. { ok } | { ok:false, conexao:true } (parar a rodada) | { ok:false } */
    async function enviarItem(it) {
        if (await cliente.estado() !== 'open') {
            await armazenamento.atualizar(it.id, { status: 'PENDENTE', processando_desde: null, tentativas: Math.max(0, (it.tentativas || 1) - 1) }, 'PROCESSANDO');
            return { ok: false, conexao: true };
        }
        const destino = it.numero_whatsapp || it.numero;
        let r = { ok: true }, idMsg = null;
        if (String(it.texto || '').trim()) { r = await cliente.enviarTexto(destino, it.texto); idMsg = r.id || null; }
        if (r.ok && it.documento) {
            const doc = typeof it.documento === 'string' ? JSON.parse(it.documento) : it.documento;
            if (it.texto) await esperar(6000);                    // texto e documento não chegam colados
            r = await cliente.enviarDocumento(destino, doc); idMsg = r.id || idMsg;
        }
        if (r.ok) {
            await armazenamento.atualizar(it.id, { status: 'ENVIADO', enviado_em: iso(), id_mensagem: idMsg, processando_desde: null, erro: null }, 'PROCESSANDO');
            return { ok: true };
        }
        if (ehErroDeConexao(r)) {
            // a conexão caiu: a mensagem não saiu; volta para a fila sem gastar tentativa
            await armazenamento.atualizar(it.id, { status: 'PENDENTE', processando_desde: null, tentativas: Math.max(0, (it.tentativas || 1) - 1), erro: r.erro }, 'PROCESSANDO');
            return { ok: false, conexao: true };
        }
        const tent = Number(it.tentativas || 1);
        await armazenamento.atualizar(it.id, { status: tent >= o.tentativasMax ? 'ERRO' : 'PENDENTE', processando_desde: null, erro: r.erro }, 'PROCESSANDO');
        return { ok: false };
    }

    /** Itens presos em PROCESSANDO: pergunta ao WhatsApp se saíram antes de devolver para a fila. */
    async function recuperarTravados() {
        const presos = await armazenamento.travadosAntes(iso(agora() - o.minutosTrava * 60000), 15);
        const r = { entregues: 0, devolvidos: 0, aguardando: 0, verificar: 0 };
        for (const it of presos) {
            const inicio = Date.parse(it.processando_desde || it.criado_em) || agora();
            const numero = it.numero_whatsapp || normalizarNumero(it.numero);
            const resp = await cliente.mensagensEnviadasPara(`${numero}@s.whatsapp.net`, Math.floor(inicio / 1000) - 120);
            if (!resp.ok) {
                if (agora() - inicio > o.horasParaVerificar * 3600000) { await armazenamento.atualizar(it.id, { status: 'VERIFICAR', processando_desde: null }, 'PROCESSANDO'); r.verificar++; }
                else r.aguardando++;
                continue;
            }
            const achou = resp.msgs.find(m => mesmaMensagem(it, m));
            if (achou) {
                await armazenamento.atualizar(it.id, { status: 'ENVIADO', enviado_em: iso(achou.ts * 1000), id_mensagem: achou.id || null, processando_desde: null }, 'PROCESSANDO');
                r.entregues++;
            } else {
                await armazenamento.atualizar(it.id, { status: Number(it.tentativas || 0) >= o.tentativasMax ? 'VERIFICAR' : 'PENDENTE', processando_desde: null }, 'PROCESSANDO');
                r.devolvidos++;
            }
        }
        return r;
    }

    /** Uma rodada completa: recupera travados, pega o lote e envia com intervalo. */
    async function rodada() {
        const resumo = { travados: await recuperarTravados(), enviados: 0, falhas: 0, parouPorConexao: false };
        const lote = await pegarLote();
        Object.assign(resumo, { semWhatsapp: lote.semWhatsapp || 0, adiados: lote.adiados || 0, motivo: lote.motivo || null, lote: lote.itens.length });
        for (let i = 0; i < lote.itens.length; i++) {
            const r = await enviarItem(lote.itens[i]);
            if (r.ok) resumo.enviados++; else resumo.falhas++;
            if (r.conexao) {
                resumo.parouPorConexao = true;
                for (const resto of lote.itens.slice(i + 1))      // devolve o resto do lote sem gastar tentativa
                    await armazenamento.atualizar(resto.id, { status: 'PENDENTE', processando_desde: null, tentativas: Math.max(0, (resto.tentativas || 1) - 1) }, 'PROCESSANDO');
                break;
            }
            if (i < lote.itens.length - 1) {
                const seg = o.intervaloMinSeg + Math.random() * Math.max(0, o.intervaloMaxSeg - o.intervaloMinSeg);
                await esperar(Math.round(seg * 1000));
            }
        }
        log('[fila] rodada', JSON.stringify(resumo));
        return resumo;
    }

    /** Tira da fila o que ainda não saiu (PENDENTE e, com incluirProcessando, o lote em andamento). */
    async function cancelarPendentes({ incluirProcessando = false } = {}) {
        return armazenamento.cancelar(incluirProcessando ? ['PENDENTE', 'PROCESSANDO'] : ['PENDENTE'], iso());
    }

    return { adicionar, pegarLote, enviarItem, recuperarTravados, rodada, cancelarPendentes, opcoes: o };
}

/** A mensagem encontrada no WhatsApp é a deste item? (documento pelo nome do arquivo; texto pelo começo) */
function mesmaMensagem(it, m) {
    const doc = it.documento ? (typeof it.documento === 'string' ? JSON.parse(it.documento) : it.documento) : null;
    if (doc && /document/i.test(m.tipo)) return !doc.nomeArquivo || m.arquivo === doc.nomeArquivo;
    if (!doc && /conversation|extendedText/i.test(m.tipo)) {
        const a = String(it.texto || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const b = String(m.texto || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        return !!a && a === b;
    }
    return false;
}
