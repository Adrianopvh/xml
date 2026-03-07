# Script de Download - NFeDistribuicaoDFe

Este documento descreve a estratégia final para o processo de download massivo (ex: 248 mil notas) de XMLs da SEFAZ (Receita Federal) através do serviço oficial `distDFeInt`.

## Problema Enfrentado
Baixar milhares de notas sem controle resultaria no bloqueio temporário (cStat 656 - Consumo Indevido) ou banimento de IP/Certificado Digital, pois a SEFAZ aplica limites (Rate Limit) contra abuso de seus servidores web.

## Estratégia Adotada e Implementada

Para resolver esse problema, adaptamos a arquitetura do projeto (`index.js`) para suportar um mecanismo de **Lote e Controle de Estado (Checkpoint)**:

1. **Rate Limit e Delay:**
   - Entre cada requisição SOAP à SEFAZ, o script agora inclui um intervalo dinâmico (por padrão, **1,5 segundos** - configurável). Isso mantém uma frequência muito segura (abaixo de 1 requisição por segundo na prática, considerando o tempo de resposta da rede).

2. **Checkpoint (Controle de Progresso):**
   - O sistema cria e gerencia o arquivo `dados/controle.json`.
   - Se o script baixar as primeiras 1.500 chaves de um total de 248.000 e por algum motivo (queda de energia, pausa manual, reinício) for interrompido, ao rodar novamente ele **vai ignorar** as 1.500 já baixadas e continuará a partir da chave 1.501.
   - Isso garante eficiência, pois nunca tenta baixar a mesma nota duas vezes de forma redundante (o que poderia causar cStat 656).

3. **Tratamento de Consumo Indevido Inteligente:**
   - Se, porventura, a SEFAZ ainda assim aplicar um bloqueio (Rejeição: Consumo Indevido), o script intercepta a resposta, pausa sua própria execução por um tempo maior (exemplo: **5 minutos** - configurável) e então tenta retomar o fluxo automaticamente.

## Arquivos e Pastas

- `/downloads/` -> Onde os arquivos XML extraídos do GZIP da SEFAZ são salvos de fato (nome_arquivo: `chave.xml`).
- `/dados/controle.json` -> O banco de dados simples (JSON) que armazena os arrays de chaves `sucesso` e `erro`.
- `chaves.json` -> O array base fornecido por você com as 248 mil chaves.
- `index.js` -> O motor do script contendo a lógica iterativa das Promises e Delays.

## Utilização

Basta garantir que as chaves estejam mapeadas em `chaves.json` (como um array de strings de 44 dígitos) e rodar o script no terminal:

```bash
node index.js
```

Pode rodar continuamente em qualquer servidor (incluindo PM2 ou Docker).
