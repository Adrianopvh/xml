require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { gerarPDF } = require('nfe-danfe-pdf');
const { Parser, Builder } = require('xml2js');

const downloadDir = path.join(__dirname, 'nfe-download');
const danfeDir = path.join(__dirname, 'danfe-download');
const DANFE_LOGO_PATH = process.env.DANFE_LOGO_PATH;
const ORDENAR_ITENS = (process.env.ORDENAR_ITENS || 'xprod').toLowerCase();

if (!fs.existsSync(danfeDir)) fs.mkdirSync(danfeDir);

const arquivos = fs.readdirSync(downloadDir).filter(f => f.toLowerCase().endsWith('.xml'));
console.log(`📄 Encontrados ${arquivos.length} XMLs em ${downloadDir}`);
console.log(`🧮 Modo de ordenação de itens: ${ORDENAR_ITENS}`);

let ok = 0, erros = 0;

const xmlParser = new Parser({ mergeAttrs: true, ignoreAttrs: true, explicitArray: false });
const xmlBuilder = new Builder({ headless: true, renderOpts: { pretty: false, indent: '', newline: '' } });

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
    if (!modo || modo === 'none' || modo === 'original' || modo === 'nitem') return xmlConteudo;
    try {
        const parsed = await new Promise((res, rej) => xmlParser.parseString(xmlConteudo, (e, r) => (e ? rej(e) : res(r))));
        const root = parsed.nfeProc || parsed;
        const infNFe = root?.NFe?.infNFe;
        if (!infNFe || !Array.isArray(infNFe.det)) return xmlConteudo;
        infNFe.det.sort((a, b) => compararItens(a, b, modo));
        return xmlBuilder.buildObject(parsed);
    } catch {
        return xmlConteudo;
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
            const xmlProcessado = await ordenarItensXML(xml, ORDENAR_ITENS);
            const opcoes = {};
            if (DANFE_LOGO_PATH && fs.existsSync(DANFE_LOGO_PATH)) opcoes.pathLogo = DANFE_LOGO_PATH;
            const result = await gerarPDF(xmlProcessado, opcoes);
            const buf = await extrairBuffer(result);
            const pdfNome = path.basename(arq, '.xml') + '.pdf';
            fs.writeFileSync(path.join(danfeDir, pdfNome), buf);
            ok++;
            process.stdout.write(`\r✅ ${ok}/${arquivos.length} concluídos (${erros} erros)`);
        } catch (e) {
            erros++;
            console.error(`\n❌ ${arq}: ${e.message}`);
        }
    }
    console.log(`\n\n🎉 Fim! ${ok} PDFs gerados, ${erros} erros. Pasta: ${danfeDir}`);
})();
