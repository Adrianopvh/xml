require('dotenv').config();
const oracledb = require('oracledb');
const fs = require('fs');

const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectString: process.env.DB_CONNECTION_STRING
};

const clientDir = process.env.ORACLE_CLIENT_DIR;

async function testarConexao() {
    console.log('\n=========================================');
    console.log('🧪 TESTE DE CONEXÃO ORACLE 12C');
    console.log('=========================================\n');

    console.log(`[1] Verificando Instant Client em: ${clientDir}`);
    if (clientDir && fs.existsSync(clientDir)) {
        console.log('    ✅ Pasta do Instant Client encontrada.');
        try {
            oracledb.initOracleClient({ libDir: clientDir });
            console.log('    ✅ Oracle Client inicializado em modo Thick.');
        } catch (err) {
            console.error('    ❌ Falha ao inicializar o Oracle Client:', err.message);
            process.exit(1);
        }
    } else {
        console.log('    ⚠️ Pasta não encontrada ou não configurada. O Node tentará usar o modo Thin (nativo).');
        console.log('    ⚠️ Nota: O modo Thin pode não suportar todas as features do Oracle 12c remoto.');
    }

    console.log(`\n[2] Tentando conectar no banco: ${dbConfig.connectString}`);
    console.log(`    👤 Usuário: ${dbConfig.user}`);

    let connection;

    try {
        connection = await oracledb.getConnection(dbConfig);
        console.log('\n🎉 PARABÉNS! Conexão estabelecida com sucesso com o banco de dados Oracle!');

        // Vamos rodar um "ping" simples
        const result = await connection.execute(`SELECT TO_CHAR(SYSDATE, 'DD/MM/YYYY HH24:MI:SS') AS DATA_HORA FROM DUAL`, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
        console.log(`\n⏰ Data e Hora no Servidor Oracle: ${result.rows[0].DATA_HORA}`);

    } catch (err) {
        console.error('\n❌ ERRO DE CONEXÃO:');
        console.error(err.message);

        if (err.message.includes('ORA-12541')) {
            console.log('\n💡 DICA: OListener do banco não está respondendo. Verifique IP e a Porta (geralmente 1521).');
        } else if (err.message.includes('ORA-01017')) {
            console.log('\n💡 DICA: Usuário ou senha inválidos.');
        } else if (err.message.includes('ORA-12154') || err.message.includes('ORA-12514')) {
            console.log('\n💡 DICA: O "Service Name" ou "SID" (parte final da string de conexão) está incorreto ou não existe.');
        } else if (err.message.includes('NJS-045') || err.message.includes('DPI-1047')) {
            console.log('\n💡 DICA: Problema com o Instant Client (arquivos faltando, dll incompatível com a arquitetura do Node 64bits/32bits ou caminho errado).');
        }
    } finally {
        if (connection) {
            try {
                await connection.close();
                console.log('\n🔌 Conexão encerrada com segurança.\n');
            } catch (err) {
                console.error('Erro ao fechar a conexão', err);
            }
        }
    }
}

testarConexao();
