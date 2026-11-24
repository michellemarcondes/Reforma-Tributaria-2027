// Teste ponta a ponta no navegador (Playwright/Chromium): as 3 funcionalidades + premissas.
// Uso: node tests/e2e.js [http://localhost:8765/] [pasta_screenshots]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8765/';
const SHOTS = process.argv[3] || '/tmp';
const nt = s => String(s).replace(/\u00a0/g, ' ');
const assert = (c, m) => { if (!c) throw new Error('FALHOU: ' + m); console.log('ok -', m); };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', m => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', e => erros.push(String(e)));
  await page.goto(BASE);
  await page.waitForSelector('#v-sim:not([hidden])');
  assert(await page.$eval('img[alt^="Consulcamp"]', i => i.naturalWidth === 269 && i.naturalHeight === 151), 'logo Consulcamp carregado (269x151)');
  assert((nt(await page.textContent('#meta-base'))).includes('V0073'), 'versão da base oficial exibida');

  // ---------- 1. Simulador - Lucro Presumido
  await page.fill('#s-nome', 'Comercial Exemplo Ltda.');
  await page.selectOption('#s-regime', 'LP');
  await page.fill('#s-bruto', '100.000,00');
  await page.fill('#s-desc', '2.000,00');
  await page.fill('#s-icms', '18.000,00');
  await page.fill('#s-cr', '50.000,00');
  await page.click('#f-sim button[type=submit]');
  await page.waitForSelector('#s-res:not([hidden])');
  let txt = nt(await page.textContent('#s-res'));
  // base = 100000-2000-18000 = 80000; debito CBS 9040,00 IBS 80,00; credito CBS 5650,00 IBS 50,00 -> CBS 3390, IBS 30
  assert(txt.includes('R$ 3.390,00'), 'LP: CBS a recolher = R$ 3.390,00');
  assert(txt.includes('R$ 30,00'), 'LP: IBS a recolher = R$ 30,00');
  assert(txt.includes('R$ 3.420,00'), 'LP: total = R$ 3.420,00');
  assert(txt.includes('R$ 80.000,00'), 'LP: base (receita líquida) = R$ 80.000,00');
  assert(txt.includes('Comparativo com 2026'), 'LP: comparativo PIS/Cofins exibido');
  await page.screenshot({ path: SHOTS + '/1-simulador-lp.png', fullPage: true });

  // composição com redução de 60%
  await page.fill('#s-c-integral', '50'); await page.fill('#s-c-red60', '50');
  await page.click('#f-sim button[type=submit]');
  txt = nt(await page.textContent('#s-res'));
  // 40000 integral: CBS 4520 IBS 40; 40000 red60: CBS 40000*4.52%=1808, IBS 40000*0.02%*2=16 -> deb CBS 6328 IBS 56; cred 5650/50 -> 678 / 6
  assert(txt.includes('R$ 678,00') && txt.includes('R$ 6,00'), 'LP com 50% redução 60%: CBS R$ 678,00 e IBS R$ 6,00');
  await page.fill('#s-c-integral', ''); await page.fill('#s-c-red60', '');

  // Simples Nacional padrão
  await page.selectOption('#s-regime', 'SN');
  assert(await page.isHidden('#s-icms'), 'SN: campo ICMS oculto');
  await page.selectOption('#s-anexo', 'I');
  await page.fill('#s-rbt12', '150.000,00');
  await page.fill('#s-bruto', '12.500,00'); await page.fill('#s-desc', '');
  await page.click('#f-sim button[type=submit]');
  txt = nt(await page.textContent('#s-res'));
  // Anexo I faixa 1: efetiva 4%; DAS = 500,00; CBS = 12500*0.6132% = 76,65 ; IBS = 12500*0.0068% = 0,85
  assert(txt.includes('R$ 500,00'), 'SN: DAS total = R$ 500,00');
  assert(txt.includes('R$ 76,65') && txt.includes('R$ 0,85'), 'SN: CBS R$ 76,65 e IBS R$ 0,85 no DAS');
  await page.screenshot({ path: SHOTS + '/2-simulador-sn.png', fullPage: true });

  // validação de entrada inválida
  await page.fill('#s-bruto', 'abc');
  await page.click('#f-sim button[type=submit]');
  assert((nt(await page.textContent('#s-msg'))).includes('inválido'), 'mensagem de valor inválido');
  await page.fill('#s-bruto', '12.500,00');

  // ---------- 2. Painel do contador
  await page.click('#t-painel');
  await page.click('#p-clear').catch(() => {});
  await page.click('#p-exemplo');
  await page.waitForSelector('#p-tab tbody tr');
  assert((await page.$$('#p-tab tbody tr')).length === 4, 'painel: 4 clientes de exemplo');
  const tot1 = nt(await page.textContent('#p-tab tfoot'));
  assert(/Total \(4 calculados\)/.test(tot1), 'painel: totais calculados para 4 clientes');
  // editar faturamento do primeiro cliente e conferir recálculo
  await page.fill('#p-tab tbody tr:nth-child(1) input[data-k=fat]', '100.000,00');
  await page.fill('#p-tab tbody tr:nth-child(1) input[data-k=ded]', '20.000,00');
  await page.fill('#p-tab tbody tr:nth-child(1) input[data-k=compras]', '50.000,00');
  const r1 = await page.$$eval('#p-tab tbody tr:nth-child(1) td.res', t => t.map(x => x.textContent.replace(/\u00a0/g, ' ')));
  assert(r1[0] === 'R$ 3.390,00' && r1[1] === 'R$ 30,00', 'painel: recálculo da linha (CBS R$ 3.390,00 / IBS R$ 30,00)');
  // importar CSV
  const csv = 'nome;regime;faturamento;deducoes;compras;anexo;rbt12\nCliente CSV A;LR;200000,00;36000,00;100000,00;;\nCliente CSV B;Simples;30000,00;0;;III;360000,00\n';
  await page.setInputFiles('#p-file', { name: 'clientes.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForFunction(() => document.querySelectorAll('#p-tab tbody tr').length === 6);
  assert((nt(await page.textContent('#p-msg'))).includes('2 cliente(s) importado(s)'), 'painel: importação de CSV (2 clientes)');
  const regB = await page.$eval('#p-tab tbody tr:nth-child(6) select[data-k=regime]', s => s.value);
  assert(regB === 'SN', 'painel: regime "Simples" do CSV mapeado para SN');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#p-export')]);
  const p = await dl.path(); const conteudo = require('fs').readFileSync(p, 'utf8');
  assert(conteudo.split('\n').length >= 7 && conteudo.includes('Cliente CSV A'), 'painel: exportação CSV com resultados');
  await page.screenshot({ path: SHOTS + '/3-painel.png', fullPage: true });
  // persistência após recarregar
  await page.reload(); await page.click('#t-painel');
  assert((await page.$$('#p-tab tbody tr')).length === 6, 'painel: dados persistem após recarregar');

  // ---------- 3. Simulador de nota - NCM arroz (cesta básica)
  await page.click('#t-nota');
  await page.selectOption('#n-regime', 'LP');
  assert(await page.isHidden('#n-vserv') && await page.isHidden('#n-rbt12'), 'nota LP/NF-e: campos de NFS-e e do Simples ocultos');
  await page.fill('#n-cod', 'arroz polido');
  await page.waitForSelector('#n-sugg:not([hidden]) button[data-c]');
  assert((nt(await page.textContent('#n-sugg'))).includes('1006.30.21'), 'nota: busca por descrição encontra 1006.30.21');
  await page.fill('#n-cod', '10063021');
  await page.waitForFunction(() => document.querySelector('#n-class').options.length > 3);
  const opts = await page.$$eval('#n-class option', o => o.map(x => x.value));
  assert(opts.includes('200003'), 'nota: NCM 10063021 lista 200003 (cesta básica, redução 100%)');
  await page.fill('#n-vprod', '1.000,00'); await page.fill('#n-vicms', '70,00');
  await page.selectOption('#n-class', '000001');
  await page.click('#f-nota button[type=submit]');
  await page.waitForSelector('#n-res:not([hidden])');
  txt = nt(await page.textContent('#n-res'));
  // base 930 -> CBS 105,09 ; IBS UF 0,47 (0.465 -> half-even 0,46?) conferido contra o motor
  const RTC = require('../assets/js/engine.js');
  const ref = RTC.calcularItemRegular('930', null, RTC.PREMISSAS_PADRAO);
  const brl = v => 'R$ ' + Number(RTC.toStr(v, 2)).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  assert(txt.includes(brl(ref.vCBS)) && txt.includes(brl(ref.total)), 'nota NF-e integral: CBS ' + brl(ref.vCBS) + ' total ' + brl(ref.total));
  await page.selectOption('#n-class', '200003');
  await page.click('#f-nota button[type=submit]');
  txt = nt(await page.textContent('#n-res'));
  assert(nt(await page.textContent('#n-res tr.tot td.v')) === 'R$ 0,00', 'nota cesta básica (200003): total de CBS + IBS = R$ 0,00');
  await page.screenshot({ path: SHOTS + '/4-nota-ncm.png', fullPage: true });

  // NFS-e serviço de educação (redução 60%)
  await page.selectOption('#n-tipo', 'nbs');
  await page.fill('#n-cod', '17.19');
  await page.waitForSelector('#n-sugg:not([hidden]) button[data-c]');
  assert((await page.$$('#n-sugg button[data-c]')).length > 0, 'nota: busca por item da LC 116 (17.19) retorna NBS');
  await page.fill('#n-cod', '122011200');
  await page.waitForFunction(() => [...document.querySelectorAll('#n-class option')].some(o => o.value === '200028'));
  await page.selectOption('#n-class', '200028');
  await page.fill('#n-vserv', '1.200,00');
  await page.click('#f-nota button[type=submit]');
  txt = nt(await page.textContent('#n-res'));
  // Receita (doc): base 1200, red 60% -> CBS 11.3*0.4=4.52% -> 54,24 ; IBS 0.02% -> 0,24 + 0,24
  assert(txt.includes('R$ 54,24') && txt.includes('R$ 0,24'), 'nota NFS-e educação (200028): CBS R$ 54,24 / IBS UF R$ 0,24');
  await page.screenshot({ path: SHOTS + '/5-nota-nbs.png', fullPage: true });

  // Emitente do Simples
  await page.selectOption('#n-regime', 'SN');
  await page.selectOption('#n-anexo', 'III');
  await page.fill('#n-rbt12', '100.000,00');
  await page.click('#f-nota button[type=submit]');
  txt = nt(await page.textContent('#n-res'));
  // III faixa 1: pCBS 0.9258 -> 1200*0.9258% = 11,1096 -> NFS-e 2 casas: 0.93% -> 11,16 ; pIBS 0.01 -> 0,12
  assert(txt.includes('R$ 11,16') && txt.includes('R$ 0,12'), 'nota Simples NFS-e: CBS R$ 11,16 / IBS R$ 0,12 (alíquotas com 2 casas)');

  // NCM sujeito ao IS (cerveja)
  await page.selectOption('#n-regime', 'LR');
  await page.selectOption('#n-tipo', 'ncm');
  await page.fill('#n-cod', '22030000');
  await page.waitForSelector('#n-is-f:not([hidden])');
  assert(true, 'nota: NCM 22030000 (cerveja) exibe campo do Imposto Seletivo');

  // ---------- Premissas
  await page.click('#t-prem');
  await page.fill('#pr-cbs', '8,8'); await page.click('#f-prem button[type=submit]');
  assert((nt(await page.textContent('#meta-aliq'))).includes('8,8'), 'premissas: CBS alterada para 8,8% reflete no cabeçalho');
  await page.click('#pr-reset');
  assert((nt(await page.textContent('#meta-aliq'))).includes('11,3'), 'premissas: padrão 11,3% restaurado');

  // ---------- Celular
  const m = await browser.newContext({ ...require('playwright').devices['iPhone 13'] });
  const mp = await m.newPage(); mp.on('pageerror', e => erros.push(String(e)));
  await mp.goto(BASE); await mp.waitForSelector('#v-sim:not([hidden])');
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  assert(sw, 'celular: sem rolagem horizontal');
  await mp.screenshot({ path: SHOTS + '/6-celular.png', fullPage: false });

  assert(erros.length === 0, 'console sem erros de JS ' + (erros.length ? JSON.stringify(erros) : ''));
  await browser.close();
  console.log('\nTODOS OS TESTES PASSARAM');
})().catch(e => { console.error(e.message || e); process.exit(1); });
