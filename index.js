require('dotenv').config();
const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');
const { gerarPDF } = require('nfe-danfe-pdf');
const { Parser, Builder } = require('xml2js');
// ==========================================
// CONFIGURAÇÕES GERAIS
// ==========================================
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectString: process.env.DB_CONNECTION_STRING
};

const clientDir = process.env.ORACLE_CLIENT_DIR;
const downloadDir = path.join(__dirname, 'nfe-download');
const danfeDir = path.join(__dirname, 'danfe-download');

// Configurações de Lote
const BATCH_SIZE = 500; // Define o tamanho do lote para consultas no Oracle

// DANFE / PDF
const GERAR_PDF = process.env.GERAR_PDF !== 'false'; // default true
const DANFE_LOGO_PATH = process.env.DANFE_LOGO_PATH;
const ORDENAR_ITENS = (process.env.ORDENAR_ITENS || 'xprod').toLowerCase();

const xmlParser = new Parser({ mergeAttrs: true, ignoreAttrs: true, explicitArray: false });
const xmlBuilder = new Builder({ headless: true, renderOpts: { pretty: false, indent: '', newline: '' } });

// Garante que as pastas de destino existem
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);
if (GERAR_PDF && !fs.existsSync(danfeDir)) fs.mkdirSync(danfeDir);

// ==========================================
// FUNÇÕES AUXILIARES
// ==========================================

/**
 * Divide um array em sub-arrays (lotes) de tamanho fixo.
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

async function readClob(clob) {
    return new Promise((resolve, reject) => {
        if (typeof clob === 'string') {
            return resolve(clob);
        }

        let clobData = '';
        clob.setEncoding('utf8');
        clob.on('data', chunk => {
            clobData += chunk;
        });
        clob.on('end', () => {
            resolve(clobData);
        });
        clob.on('error', err => {
            reject(err);
        });
    });
}

function compararItens(a, b, modo) {
    const sa = String((a.prod?.xProd) || '').trim().toLowerCase();
    const sb = String((b.prod?.xProd) || '').trim().toLowerCase();
    if (modo === 'xprod' || modo === 'xprod_desc' || modo === 'desc') {
        return sa.localeCompare(sb, 'pt-BR', { sensitivity: 'base', numeric: true });
    }
    if (modo === 'xprod_z' || modo === 'za') {
        return sb.localeCompare(sa, 'pt-BR', { sensitivity: 'base', numeric: true });
    }
    const ca = String((a.prod?.cProd) || '').trim();
    const cb = String((b.prod?.cProd) || '').trim();
    return ca.localeCompare(cb, 'pt-BR', { numeric: true });
}

async function ordenarItensXML(xmlConteudo, modo) {
    if (!modo || modo === 'none' || modo === 'original' || modo === 'nitem') {
        return xmlConteudo;
    }
    try {
        const parsed = await new Promise((resolve, reject) => {
            xmlParser.parseString(xmlConteudo, (err, r) => (err ? reject(err) : resolve(r)));
        });
        const root = parsed.nfeProc || parsed;
        const infNFe = root?.NFe?.infNFe;
        if (!infNFe || !Array.isArray(infNFe.det)) return xmlConteudo;
        infNFe.det.sort((a, b) => compararItens(a, b, modo));
        return xmlBuilder.buildObject(parsed);
    } catch (e) {
        return xmlConteudo;
    }
}

async function gerarDANFE(xmlConteudo, nomeArquivo) {
    if (!GERAR_PDF) return { ok: false, skipped: true };

    try {
        const opcoes = {};
        if (DANFE_LOGO_PATH && fs.existsSync(DANFE_LOGO_PATH)) {
            opcoes.pathLogo = DANFE_LOGO_PATH;
        }

        const xmlProcessado = await ordenarItensXML(xmlConteudo, ORDENAR_ITENS);
        const result = await gerarPDF(xmlProcessado, opcoes);

        let pdfBuffer;
        if (Buffer.isBuffer(result)) {
            pdfBuffer = result;
        } else if (result && typeof result.pipe === 'function') {
            pdfBuffer = await new Promise((resolve, reject) => {
                const chunks = [];
                result.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                result.on('end', () => resolve(Buffer.concat(chunks)));
                result.on('error', reject);
            });
        } else {
            throw new Error(`Tipo inesperado retornado por gerarPDF: ${result?.constructor?.name || typeof result}`);
        }

        const pdfPath = path.join(danfeDir, `${nomeArquivo}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuffer);
        return { ok: true, pdfPath };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ==========================================
// LÓGICA PRINCIPAL
// ==========================================
async function extrairXMLs() {
    console.log('🚀 Iniciando Extração de XML do Oracle 12c');
    if (GERAR_PDF) {
        console.log('📄 Geração de DANFE PDF ATIVADA');
        if (DANFE_LOGO_PATH) console.log(`🖼️  Logo customizado: ${DANFE_LOGO_PATH}`);
    } else {
        console.log('📄 Geração de DANFE PDF DESATIVADA (GERAR_PDF=false)');
    }
    console.log();

    // MODO LEITURA DA LISTA DE TRANSAÇÕES
    const transacoesFile = path.join(__dirname, 'transacoes.txt');
    if (!fs.existsSync(transacoesFile)) {
        console.error(`❌ ERRO: O arquivo ${transacoesFile} não foi encontrado.`);
        console.log('Crie um arquivo transacoes.txt na raiz do projeto contendo um NUMTRANSACAO por linha.');
        process.exit(1);
    }

    const dataTransacoes = fs.readFileSync(transacoesFile, 'utf8');
    const listaTransacoes = dataTransacoes.split(/\r?\n/)
        .map(linha => linha.trim())
        .filter(linha => linha.length > 0);

    console.log(`📋 Lista carregada: ${listaTransacoes.length} transações a processar.`);
    console.log(`📦 Processamento configurado em lotes de ${BATCH_SIZE} registros.\n`);

    // 1. Inicializa o Instant Client (Modo Thick)
    try {
        if (clientDir && fs.existsSync(clientDir)) {
            console.log(`- Carregando Oracle Instant Client de: ${clientDir}`);
            oracledb.initOracleClient({ libDir: clientDir });
        } else {
            console.warn('⚠️ ORACLE_CLIENT_DIR não definido ou pasta não encontrada. Usando Thin mode.');
        }
    } catch (err) {
        console.error('❌ Erro ao inicializar o Oracle Client:', err.message);
        process.exit(1);
    }

    let connection;
    let salvos = 0;
    let errosTotal = 0;
    let naoEncontradosTotal = 0;
    let danfesGerados = 0;
    let danfesErros = 0;

    try {
        console.log(`- Conectando ao banco de dados...`);
        connection = await oracledb.getConnection(dbConfig);
        console.log('✅ Conexão estabelecida com sucesso!\n');

        // Divide a lista total em lotes
        const lotes = chunkArray(listaTransacoes, BATCH_SIZE);

        for (let i = 0; i < lotes.length; i++) {
            const loteAtual = lotes[i];
            const inicio = i * BATCH_SIZE + 1;
            const fim = Math.min((i + 1) * BATCH_SIZE, listaTransacoes.length);

            console.log(`🔄 Processando Lote ${i + 1}/${lotes.length} (Registros ${inicio} a ${fim})...`);

            // Constrói os bind parameters dinamicamente: :v0, :v1, :v2...
            const binds = {};
            const bindNames = loteAtual.map((val, idx) => {
                const key = `v${idx}`;
                binds[key] = val;
                return `:${key}`;
            }).join(', ');

            const sql = `
                SELECT 
                    D.NUMTRANSACAO, 
                    D.XMLNFE,
                    S.CHAVENFE
                FROM PCDOCELETRONICO D
                LEFT JOIN PCNFSAID S ON D.NUMTRANSACAO = S.NUMTRANSVENDA
                WHERE D.NUMTRANSACAO IN (${bindNames})
            `;

            try {
                const result = await connection.execute(sql, binds, {
                    outFormat: oracledb.OUT_FORMAT_OBJECT,
                    fetchInfo: { "XMLNFE": { type: oracledb.STRING } }
                });

                // Cria um mapa dos resultados para fácil verificação de quais transações voltaram
                const resultadosMap = {};
                if (result.rows) {
                    for (const row of result.rows) {
                        resultadosMap[row.NUMTRANSACAO] = row;
                    }
                }

                // Processa cada transação do lote original
                for (const numTransacao of loteAtual) {
                    const row = resultadosMap[numTransacao];

                    if (!row) {
                        // console.log(`  ⚠️ NUMTRANSACAO ${numTransacao} não encontrada.`); // Log omitido para evitar flood em grandes volumes
                        naoEncontradosTotal++;
                        continue;
                    }

                    try {
                        const xmlPayload = row.XMLNFE;
                        const nomeArquivo = row.CHAVENFE || row.NUMTRANSACAO;

                        if (!xmlPayload) {
                            errosTotal++;
                            continue;
                        }

                        const filePath = path.join(downloadDir, `${nomeArquivo}.xml`);
                        
                        let xmlConteudo = '';
                        if (typeof xmlPayload === 'object' && xmlPayload !== null) {
                            xmlConteudo = await readClob(xmlPayload);
                        } else {
                            xmlConteudo = xmlPayload;
                        }

                        fs.writeFileSync(filePath, xmlConteudo, 'utf8');
                        salvos++;

                        if (GERAR_PDF) {
                            const danfeResult = await gerarDANFE(xmlConteudo, nomeArquivo);
                            if (danfeResult.ok) {
                                danfesGerados++;
                            } else if (!danfeResult.skipped) {
                                console.error(`  ❌ Erro DANFE ${nomeArquivo}: ${danfeResult.error}`);
                                danfesErros++;
                            }
                        }
                    } catch (errWrite) {
                        console.error(`  ❌ Erro ao salvar transação ${numTransacao}:`, errWrite.message);
                        errosTotal++;
                    }
                }

                console.log(`  📊 Progresso: ${salvos} XML salvos | ${danfesGerados} DANFE PDF | ${naoEncontradosTotal} não encontrados | ${errosTotal + danfesErros} erros.`);

            } catch (errBatch) {
                console.error(`  ❌ Erro crítico ao processar Lote ${i + 1}:`, errBatch.message);
                errosTotal += loteAtual.length;
            }
        }

        console.log(`\n🎉 Processo Finalizado!`);
        console.log(`- Total Solicitado: ${listaTransacoes.length}`);
        console.log(`- XMLs Salvos (${downloadDir}): ${salvos}`);
        if (GERAR_PDF) {
            console.log(`- DANFE PDFs (${danfeDir}): ${danfesGerados} gerados | ${danfesErros} falhas`);
        }
        console.log(`- Não Encontrados: ${naoEncontradosTotal}`);
        console.log(`- Falhas/Vazios XML: ${errosTotal}`);

    } catch (err) {
        console.error('\n❌ Erro na comunicação com o Banco de Dados:', err.stack);
    } finally {
        if (connection) {
            try {
                await connection.close();
                console.log('\n🔌 Conexão com o Oracle encerrada.');
            } catch (err) {
                console.error('\n❌ Erro ao fechar a conexão', err.message);
            }
        }
    }
}

// Executa
extrairXMLs().catch(err => {
    console.error(err);
});
