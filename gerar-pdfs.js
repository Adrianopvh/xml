require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gerarPDF } = require('nfe-danfe-pdf');
const { Parser, Builder } = require('xml2js');

const downloadDir = path.join(__dirname, 'nfe-download');
const danfeDir = path.join(__dirname, 'danfe-download');
const DANFE_LOGO_PATH = process.env.DANFE_LOGO_PATH;
const ORDENAR_ITENS = (process.env.ORDENAR_ITENS || 'xprod').toLowerCase();
const ARQUIVO_SEPARADOR = process.env.ARQUIVO_SEPARADOR || '0';

if (!fs.existsSync(danfeDir)) fs.mkdirSync(danfeDir);

const arquivos = fs.readdirSync(downloadDir).filter(f => f.toLowerCase().endsWith('.xml'));
console.log(`📄 Encontrados ${arquivos.length} XMLs em ${downloadDir}`);
console.log(`🧮 Modo de ordenação de itens: ${ORDENAR_ITENS}`);
console.log(`🔖 Separador de nome de arquivo: "${ARQUIVO_SEPARADOR}"`);

let ok = 0, erros = 0;

const xmlParser = new Parser({ mergeAttrs: true, ignoreAttrs: true, explicitArray: false });
const xmlBuilder = new Builder({ headless: true, renderOpts: { pretty: false, indent: '', newline: '' } });

// ==========================================================
// FORMATAÇÃO DE NOME (igual a do index.js, mas lê do XML)
// ==========================================================
function formatarDataDDMMYYYY(valorData) {
    if (valorData === null || valorData === undefined || valorData === '') return '00000000';
    try {
        let dt;
        if (valorData instanceof Date) {
            dt = valorData;
        } else {
            const s = String(valorData).trim();
            if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
                const [d, m, y] = s.split('/');
                dt = new Date(`${y}-${m}-${d}T00:00:00`);
            } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
                dt = new Date(s);
            } else {
                dt = new Date(s);
            }
        }
        if (isNaN(dt.getTime())) return '00000000';
        const dd = String(dt.getDate()).padStart(2, '0');
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        const yyyy = dt.getFullYear();
        return `${dd}${mm}${yyyy}`;
    } catch {
        return '00000000';
    }
}

function formatarCGC14Digitos(valorCgc) {
    if (valorCgc === null || valorCgc === undefined) return '0'.repeat(14);
    let limpo = String(valorCgc).replace(/[^0-9]/g, '');
    if (limpo.length === 0) return '0'.repeat(14);
    if (limpo.length >= 14) return limpo.slice(-14);
    return limpo.padStart(14, '0');
}

function extrairDadosParaNomeFromParsed(parsedXml) {
    try {
        const root = parsedXml?.nfeProc || parsedXml;
        const infNFe = root?.NFe?.infNFe;
        const ide = infNFe?.ide || {};
        const dest = infNFe?.dest || {};

        // CHAVENFE: tag <infNFe Id="NFe44digitos" />  => extrai os 44 digitos
        let chave = '';
        const idAttr = infNFe?.Id || infNFe?.$?.Id || infNFe?.['@Id'] || infNFe?.['$']?.Id;
        if (idAttr) {
            chave = String(idAttr).replace(/[^0-9]/g, '').slice(0, 44);
        }
        if (chave.length < 44) {
            const prot = parsedXml?.nfeProc?.protNFe?.infProt || root?.protNFe?.infProt;
            if (prot?.chNFe) chave = String(prot.chNFe).replace(/[^0-9]/g, '');
        }

        // DTSAIDA: prefiro dSaiEnt (saída/entrada), fallback dEmi (emissão)
        const dataRaw = ide.dSaiEnt || ide.dEmi || ide.dhEmi || ide.dhSaiEnt;
        const dtsaida = formatarDataDDMMYYYY(dataRaw);

        // CGC: CNPJ ou CPF do destinatário
        const cgc = formatarCGC14Digitos(dest.CNPJ || dest.CPF);

        return { chave, dtsaida, cgc };
    } catch {
        return { chave: '', dtsaida: '00000000', cgc: '0'.repeat(14) };
    }
}

function montarNomeArquivoFromParsed(parsedXml, separador = ARQUIVO_SEPARADOR) {
    const { chave, dtsaida, cgc } = extrairDadosParaNomeFromParsed(parsedXml);
    const nomeSafe = chave && chave.length >= 40 ? chave : path.basename('fallback', '.xml');
    return `${nomeSafe}${separador}${dtsaida}${separador}${cgc}`;
}

// ==========================================================
// RESTANTE (ordenação + geração de PDF, igual antes)
// ==========================================================

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
    if (!modo || modo === 'none' || modo === 'original' || modo === 'nitem') return { xml: xmlConteudo, parsed: null };
    try {
        const parsed = await new Promise((res, rej) => xmlParser.parseString(xmlConteudo, (e, r) => (e ? rej(e) : res(r))));
        const root = parsed.nfeProc || parsed;
        const infNFe = root?.NFe?.infNFe;
        if (!infNFe || !Array.isArray(infNFe.det)) return { xml: xmlConteudo, parsed };
        infNFe.det.sort((a, b) => compararItens(a, b, modo));
        return { xml: xmlBuilder.buildObject(parsed), parsed };
    } catch {
        return { xml: xmlConteudo, parsed: null };
    }
}

async function extrairBuffer(result) {
    if (Buffer.isBuffer(result)) return result;
    if (result && typeof result.pipe === 'function') {
        return new Promise((resolve, reject) => {
            const chunks = [];
            result.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            result.on('end', () => resolve(Buffer.concat(chunks)));
            result.on('error', reject);
        });
    }
    throw new Error(`Tipo ${result?.constructor?.name || typeof result} não suportado`);
}

(async () => {
    for (let i = 0; i < arquivos.length; i++) {
        const arq = arquivos[i];
        try {
            const xml = fs.readFileSync(path.join(downloadDir, arq), 'utf8');
            let parsedXmlAux = null;
            let xmlProcessado = xml;
            if (ORDENAR_ITENS && ORDENAR_ITENS !== 'none' && ORDENAR_ITENS !== 'original' && ORDENAR_ITENS !== 'nitem') {
                const { xml: xmlOrd, parsed } = await ordenarItensXML(xml, ORDENAR_ITENS);
                xmlProcessado = xmlOrd;
                parsedXmlAux = parsed;
            }
            if (!parsedXmlAux) {
                parsedXmlAux = await new Promise((res, rej) => xmlParser.parseString(xml, (e, r) => (e ? rej(e) : res(r))));
            }
            const nomeArquivo = montarNomeArquivoFromParsed(parsedXmlAux);

            const opcoes = {};
            if (DANFE_LOGO_PATH && fs.existsSync(DANFE_LOGO_PATH)) opcoes.pathLogo = DANFE_LOGO_PATH;
            const result = await gerarPDF(xmlProcessado, opcoes);
            const buf = await extrairBuffer(result);
            const pdfNome = nomeArquivo + '.pdf';
            fs.writeFileSync(path.join(danfeDir, pdfNome), buf);
            ok++;
            process.stdout.write(`\r✅ ${ok}/${arquivos.length} concluídos (${erros} erros)`);
        } catch (e) {
            erros++;
            console.error(`\n❌ ${arq}: ${e.message}`);
        }
    }
    console.log(`\n\n🎉 Fim! ${ok} PDFs gerados, ${erros} erros. Pasta: ${danfeDir}`);
    console.log(`📝 Padrão de nome: CHAVENFE${ARQUIVO_SEPARADOR}DTSAIDA(DDMMYYYY)${ARQUIVO_SEPARADOR}CGC(14digitos)`);
})();
