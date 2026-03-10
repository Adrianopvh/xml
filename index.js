require('dotenv').config();
const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');
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

// Configurações de Lote
const BATCH_SIZE = 500; // Define o tamanho do lote para consultas no Oracle

// Garante que a pasta de destino existe
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

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

// ==========================================
// LÓGICA PRINCIPAL
// ==========================================
async function extrairXMLs() {
    console.log('🚀 Iniciando Extração de XML do Oracle 12c');

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
                    } catch (errWrite) {
                        console.error(`  ❌ Erro ao salvar transação ${numTransacao}:`, errWrite.message);
                        errosTotal++;
                    }
                }

                console.log(`  📊 Progresso: ${salvos} salvos | ${naoEncontradosTotal} não encontrados | ${errosTotal} erros.`);

            } catch (errBatch) {
                console.error(`  ❌ Erro crítico ao processar Lote ${i + 1}:`, errBatch.message);
                errosTotal += loteAtual.length;
            }
        }

        console.log(`\n🎉 Processo Finalizado!`);
        console.log(`- Total Solicitado: ${listaTransacoes.length}`);
        console.log(`- Registros Salvos (${downloadDir}): ${salvos}`);
        console.log(`- Não Encontrados: ${naoEncontradosTotal}`);
        console.log(`- Falhas/Vazios: ${errosTotal}`);

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
