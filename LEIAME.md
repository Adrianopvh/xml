# Oracle XML Extractor - PCDOCELETRONICO

Este projeto automatiza a extração de arquivos XML de Notas Fiscais Eletrônicas (NFe) diretamente de um banco de dados Oracle 12c, utilizando o cruzamento de dados entre as tabelas do sistema Winthor.

## 🚀 Funcionalidades

- **Extração Direta**: Conecta ao Oracle e lê o campo `XMLNFE` da tabela `PCDOCELETRONICO`.
- **Cruzamento de Dados (JOIN)**: Realiza um `LEFT JOIN` com a tabela `PCNFSAID` usando o `NUMTRANSACAO` para obter a `CHAVENFE` (Chave de Acesso de 44 dígitos).
- **Nomeação Inteligente**: Salva os arquivos XML usando a `CHAVENFE` como nome do arquivo. Caso a chave não seja encontrada, utiliza o `NUMTRANSACAO` como fallback.
- **Processamento em Lote**: Lê uma lista de transações de um arquivo de texto simples (`transacoes.txt`).
- **Seguridade de Conexão**: Garante que a sessão do banco de dados seja aberta uma única vez por lote e encerrada com segurança ao final, evitando vazamento de processos no servidor.
- **Suporte a CLOB**: Tratamento completo para campos CLOB (Character Large Object) do Oracle.

## 📋 Pré-requisitos

1.  **Node.js**: Versão 16 ou superior recomendada.
2.  **Oracle Instant Client**: Necessário para a conexão em modo Thick com bancos Oracle 12c.
3.  **Dependências**:
    - `oracledb`: Driver oficial da Oracle para Node.js.
    - `dotenv`: Gerenciamento de variáveis de ambiente.

## ⚙️ Configuração

1.  Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:

    ```env
    DB_USER=seu_usuario
    DB_PASSWORD=sua_senha
    DB_CONNECTION_STRING=host:porta/servico
    ORACLE_CLIENT_DIR=C:\caminho\para\instantclient_19_25
    ```

2.  Instale as dependências:
    ```bash
    npm install
    ```

## 🛠️ Como Usar

1.  Liste os números de transação desejados no arquivo `transacoes.txt` (um por linha).
2.  Execute o script de extração:
    ```bash
    node index.js
    ```
3.  Os arquivos XML serão salvos automaticamente na pasta `nfe-download`.

## 🧪 Testes

Para validar a conectividade e configuração do ambiente sem processar dados, utilize o script de teste:
```bash
node test-connection.js
```

## 📄 Estrutura do Projeto

- `index.js`: Motor principal de extração e gravação de arquivos.
- `test-connection.js`: Script utilitário para validar o ambiente e Instant Client.
- `transacoes.txt`: Lista de entrada para o processamento.
- `nfe-download/`: Pasta destino dos XMLs extraídos.
- `.gitignore`: Configurado para não subir credenciais, XMLs ou drivers pesados para o repositório.
