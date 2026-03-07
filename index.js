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

// Garante que a pasta de destino existe
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// ==========================================
// FUNÇÃO PARA LER CLOB (Se o XML for longo)
// ==========================================
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

    console.log(`📋 Lista carregada: ${listaTransacoes.length} transações (NUMTRANSACAO) a processar.`);

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
    let erros = 0;
    let naoEncontrados = 0;

    try {
        console.log(`- Conectando ao banco de dados...`);
        connection = await oracledb.getConnection(dbConfig);
        console.log('✅ Conexão estabelecida com sucesso!\n');

        // Itera sobre cada NUMTRANSACAO informada no TXT
        for (let i = 0; i < listaTransacoes.length; i++) {
            const numTransacao = listaTransacoes[i];
            console.log(`[${i + 1}/${listaTransacoes.length}] Consultando NUMTRANSACAO: ${numTransacao}...`);

            const sql = `
                SELECT 
                    D.NUMTRANSACAO, 
                    D.XMLNFE,
                    S.CHAVENFE
                FROM PCDOCELETRONICO D
                LEFT JOIN PCNFSAID S ON D.NUMTRANSACAO = S.NUMTRANSVENDA
                WHERE D.NUMTRANSACAO = :numTransacao
            `;

            try {
                // Executa a Query com o bind parameter (proteção contra injeção e mais performance)
                const result = await connection.execute(sql, { numTransacao: numTransacao }, {
                    outFormat: oracledb.OUT_FORMAT_OBJECT,
                    fetchInfo: { "XMLNFE": { type: oracledb.STRING } } // Tenta forçar como string
                });

                if (result.rows && result.rows.length > 0) {
                    const row = result.rows[0];
                    const xmlPayload = row.XMLNFE;

                    // Prioriza a chave de acesso da NFe. Caso falhe/não exista, usa o NUMTRANSACAO como fallback
                    const nomeArquivo = row.CHAVENFE || row.NUMTRANSACAO;

                    if (!xmlPayload) {
                        console.log(`  ⚠️ Aviso: A transação ${numTransacao} existe na tabela, mas o campo XMLNFE está vazio.`);
                        erros++;
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
                    console.log(`  💾 [SUCESSO] Salvo arquivo: ${nomeArquivo}.xml`);
                    salvos++;

                } else {
                    console.log(`  ⚠️ Aviso: NUMTRANSACAO ${numTransacao} não encontrada na tabela PCDOCELETRONICO.`);
                    naoEncontrados++;
                }

            } catch (errSelect) {
                console.error(`  ❌ Erro ao consultar/salvar a transação ${numTransacao}:`, errSelect.message);
                erros++;
            }
        }

        console.log(`\n🎉 Processo Finalizado!`);
        console.log(`- Total Solicitado: ${listaTransacoes.length}`);
        console.log(`- Registros Salvos (${downloadDir}): ${salvos}`);
        console.log(`- Não Encontrados: ${naoEncontrados}`);
        console.log(`- Com Erro (Falha/Vazio): ${erros}`);

    } catch (err) {
        console.error('\n❌ Erro durante a comunicação principal com o Banco de Dados:', err.stack);
    } finally {
        if (connection) {
            try {
                // FECHAMENTO SEGURO DA SESSÃO AO FINAL DO LOOP MESTRE
                await connection.close();
                console.log('\n🔌 Conexão com o Oracle encerrada com segurança.');
            } catch (err) {
                console.error('\n❌ Erro ao fechar a conexão', err.message);
            }
        }
    }
}

// Executa e trata promessa principal
extrairXMLs().catch(err => {
    console.error(err);
});
