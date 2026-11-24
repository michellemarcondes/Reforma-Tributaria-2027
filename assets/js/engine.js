/*
 * Motor de calculo da CBS e do IBS (Reforma Tributaria do Consumo - LC 214/2025),
 * portado da Calculadora RTC oficial da Receita Federal / Serpro:
 *   https://github.com/ReceitaFederal/calculadora-rtc-regime-regular
 *   https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional
 *
 * Regras replicadas (CalculoCbsIbsService / ArredondamentoUtils / ElementoBaseCalculo):
 *  - aritmetica decimal exata; cada numero publicado e arredondado uma vez, HALF_EVEN (ABNT NBR 5891);
 *  - aliquota e aliquota efetiva publicadas com 4 casas (pontos percentuais);
 *  - aliquotaEfetiva = aliquota x (1 - pRedAliq) x (1 - pRedutorCompraGov);
 *  - vBC arredondada a 2 casas antes de multiplicar; valor = arred2(vBC x aliquotaEfetiva / 100);
 *  - diferimento (CST 510/515): pDif 100%, valor devido zero;
 *  - CST sem grupo IBS/CBS (400, 410): sem destaque de tributo;
 *  - base 2027 da NF-e: vProd + vFrete + vSeg + vOutro + vII + vIS - vDesc - vICMS - vFCP - vICMSMono - vISSQN;
 *  - base 2027 da NFS-e: valor do servico - desconto incondicional - reembolsos - deducoes - ISS;
 *  - Simples Nacional: vCBS = arred2(receita x pCBSSN / 100), vIBS = arred2(receita x pIBSSN / 100).
 *
 * Funciona no navegador (window.RTC) e no Node (module.exports), sem dependencias.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- decimal exato
  var SCALE = 18;
  var ONE = 10n ** BigInt(SCALE);

  function D(x) {
    if (typeof x === 'bigint') return x;
    if (x === null || x === undefined || x === '') return 0n;
    var s = typeof x === 'number' ? numToStr(x) : String(x).trim().replace(',', '.');
    var neg = s[0] === '-';
    if (neg || s[0] === '+') s = s.slice(1);
    var p = s.split('.');
    var ip = p[0] || '0', fp = (p[1] || '').slice(0, SCALE);
    while (fp.length < SCALE) fp += '0';
    var v = BigInt(ip) * ONE + BigInt(fp || '0');
    return neg ? -v : v;
  }
  function numToStr(n) {
    if (!isFinite(n)) return '0';
    var s = String(n);
    if (s.indexOf('e') < 0) return s;
    return n.toFixed(SCALE);
  }
  function mul(a, b) { return (a * b) / ONE; } // operandos com poucas casas: exato ate SCALE
  function div(a, b) { return b === 0n ? 0n : (a * ONE) / b; }
  function roundHE(v, casas) {
    var f = 10n ** BigInt(SCALE - casas);
    var q = v / f, r = v % f;
    if (r < 0n) { r = -r; }
    var half = f / 2n;
    if (r > half || (r === half && (q % 2n !== 0n))) q += v < 0n ? -1n : 1n;
    return q * f;
  }
  function toNum(v) { return Number(v) / Number(ONE); }
  function toStr(v, casas) {
    var r = roundHE(v, casas);
    var neg = r < 0n; if (neg) r = -r;
    var ip = r / ONE, fp = (r % ONE).toString().padStart(SCALE, '0').slice(0, casas);
    return (neg ? '-' : '') + ip.toString() + (casas ? '.' + fp : '');
  }
  var CEM = D(100);
  var dec = { D: D, mul: mul, div: div, roundHE: roundHE, toNum: toNum, toStr: toStr };

  // ---------------------------------------------------------------- premissas 2027
  var PREMISSAS_PADRAO = {
    ano: 2027,
    cbs: 11.3,      // aliquota da CBS adotada no site (editavel)
    ibsUf: 0.05,    // IBS estadual 2027-2028
    ibsMun: 0.05    // IBS municipal 2027-2028
  };

  // ---------------------------------------------------------------- base de calculo
  function baseNFe(v) {
    v = v || {};
    var soma = ['vProd', 'vFrete', 'vSeg', 'vOutro', 'vII', 'vIS'];
    var sub = ['vDesc', 'vICMS', 'vICMSUFDest', 'vFCP', 'vFCPUFDest', 'vICMSMono', 'vISSQN'];
    var b = 0n;
    soma.forEach(function (k) { b += D(v[k]); });
    sub.forEach(function (k) { b -= D(v[k]); });
    return b < 0n ? 0n : b;
  }
  function baseNFSe(v) {
    v = v || {};
    var b = D(v.valorServico) - D(v.descontoIncondicional) - D(v.vCalcReeRepRes) - D(v.vCalcDedRedIBSCBS) - D(v.iss);
    return b < 0n ? 0n : b;
  }
  // base do Simples Nacional na NF-e (ICMS nao e deduzido)
  function baseSimplesNFe(v) {
    v = v || {};
    var b = D(v.vProd) + D(v.vFrete) + D(v.vSeg) + D(v.vOutro) + D(v.vIS) - D(v.vDesc);
    return b < 0n ? 0n : b;
  }

  // ---------------------------------------------------------------- regime regular
  var TRIBUTOS = [['cbs', 'CBS'], ['ibsUf', 'IBS UF'], ['ibsMun', 'IBS Mun']];

  /**
   * Calcula CBS, IBS UF e IBS Municipal de um item no regime regular.
   * @param base   valor da base (numero, string ou BigInt decimal)
   * @param cls    classificacao tributaria (objeto de data/rtc.json) ou null para 000001 integral
   * @param aliq   {cbs, ibsUf, ibsMun} em pontos percentuais
   * @param opts   {pRedutorCompraGov}
   */
  function calcularItemRegular(base, cls, aliq, opts) {
    opts = opts || {};
    cls = cls || { c: '000001', cst: '000', red: { cbs: 0, ibsUf: 0, ibsMun: 0 }, baseFator: 1, gIBSCBS: true, dif: false };
    aliq = aliq || PREMISSAS_PADRAO;
    var vBC = roundHE(mul(D(base), D(cls.baseFator === undefined ? 1 : cls.baseFator)), 2);
    if (vBC < 0n) vBC = 0n;
    var gov = D(opts.pRedutorCompraGov || 0);
    var out = { cClassTrib: cls.c, cst: cls.cst, vBC: vBC, semDestaque: !cls.gIBSCBS, diferido: !!cls.dif, tributos: {} };
    var totDevido = 0n;
    TRIBUTOS.forEach(function (t) {
      var k = t[0];
      var aliquota = roundHE(D(aliq[k]), 4);
      var pRed = D((cls.red && cls.red[k]) || 0);
      // aliquota x (1 - pRed/100) x (1 - gov/100), em pontos percentuais, publicada com 4 casas
      var efet = roundHE(div(mul(mul(aliquota, CEM - pRed), CEM - gov), mul(CEM, CEM)), 4);
      var exato = div(mul(vBC, efet), CEM);
      var calculado = roundHE(exato, 2);
      var vDif = 0n, devido = calculado;
      if (cls.dif) { vDif = roundHE(exato, 2); devido = calculado - vDif; if (devido < 0n) devido = 0n; }
      if (!cls.gIBSCBS) { calculado = 0n; devido = 0n; }
      out.tributos[k] = { nome: t[1], aliquota: aliquota, pRed: pRed, aliquotaEfetiva: efet, calculado: calculado, diferido: vDif, devido: devido };
      totDevido += devido;
    });
    out.vIBS = out.tributos.ibsUf.devido + out.tributos.ibsMun.devido;
    out.vCBS = out.tributos.cbs.devido;
    out.total = totDevido;
    return out;
  }

  // ---------------------------------------------------------------- vinculos NCM / NBS
  function prefixo(cod, p) { return cod.slice(0, p.length) === p; }

  function criarIndice(rtc) {
    var porCodigo = {};
    rtc.classes.forEach(function (c) { porCodigo[c.c] = c; });
    var ncmPorClasse = {};
    rtc.ncmA.forEach(function (r) { (ncmPorClasse[r[1]] = ncmPorClasse[r[1]] || []).push(r); });
    var nbsPorClasse = {};
    rtc.nbsA.forEach(function (r) { (nbsPorClasse[r[1]] = nbsPorClasse[r[1]] || []).push(r); });
    return { rtc: rtc, porCodigo: porCodigo, ncmPorClasse: ncmPorClasse, nbsPorClasse: nbsPorClasse };
  }

  // Tabela-verdade de NcmAplicavelService: rejeita quando !A ou (E e !S)
  function ncmNoAnexo(idx, ncm, cClassTrib) {
    var rows = idx.ncmPorClasse[cClassTrib] || [];
    var A = false, E = false, S = false;
    rows.forEach(function (r) {
      if (!prefixo(ncm, r[0])) return;
      A = true;
      var ex = r[2] || [];
      if (!ex.length) S = true;
      ex.forEach(function (e) { if (prefixo(ncm, e)) E = true; });
    });
    return A && (!E || S);
  }
  function nbsNoAnexo(idx, nbs, cClassTrib) {
    return (idx.nbsPorClasse[cClassTrib] || []).some(function (r) { return prefixo(nbs, r[0]); });
  }

  /** NCM sujeito ao Imposto Seletivo (o IS integra a base da CBS/IBS a partir de 2027) */
  function sujeitoIS(idx, ncm) {
    return (idx.rtc.isNcm || []).some(function (p) { return prefixo(ncm, p); });
  }

  /**
   * Classificacoes aplicaveis a um NCM (NF-e) ou NBS (NFS-e).
   * Retorna {especificas: [...], gerais: [...]} - especificas = beneficios cujo anexo cobre o codigo.
   */
  function classificacoesPara(idx, tipo, codigo) {
    var doc = tipo === 'nbs' ? 'NFS-e' : 'NF-e';
    var esp = [], ger = [];
    idx.rtc.classes.forEach(function (c) {
      if (c.docs.indexOf(doc) < 0) return;
      var aceitaNom = tipo === 'nbs' ? /NBS/.test(c.nom) : /NCM/.test(c.nom);
      if (tipo === 'ncm' && c.nom === 'NBS') return;
      if (tipo === 'nbs' && c.nom === 'NCM' && !(c.c === '200038' || c.c === '515001')) return;
      var temAnexo = tipo === 'nbs' ? c.anexoNbs : c.anexoNcm;
      if (tipo === 'nbs' && !c.anexoNbs && c.anexoNcm && c.nom === 'NBS ou NCM') temAnexo = false;
      if (temAnexo) {
        var ok = tipo === 'nbs' ? nbsNoAnexo(idx, codigo, c.c) : ncmNoAnexo(idx, codigo, c.c);
        if (ok) esp.push(c);
      } else if (aceitaNom || c.nom === 'NBS ou NCM') {
        ger.push(c);
      }
    });
    return { especificas: esp, gerais: ger };
  }

  // ---------------------------------------------------------------- Simples Nacional (LC 123/2006)
  // Faixas, aliquotas nominais, parcelas a deduzir e reparticao vigentes da LC 123/2006.
  // A partir de 2027 (LC 214/2025), o percentual antes destinado ao PIS/Pasep + Cofins passa a ser
  // destinado a CBS e ao IBS. A divisao CBS x IBS e estimada (IBS = percentual PIS+Cofins / 91,
  // arredondado a 2 casas), o que reproduz as tabelas de 2027 divulgadas (ex.: Anexo I, 1a faixa:
  // CBS 15,33% / IBS 0,17%; Anexo III, 1a faixa: CBS 15,43% / IBS 0,17%; Anexo III, 5a faixa
  // excedente: CBS 23,20% / IBS 0,26%). O usuario pode informar o par pCBSSN/pIBSSN do PGDAS.
  var FAIXAS_RBT12 = [180000, 360000, 720000, 1800000, 3600000, 4800000];
  var ANEXOS = {
    I: { nome: 'Anexo I - Comércio', nom: [4, 7.3, 9.5, 10.7, 14.3, 19], ded: [0, 5940, 13860, 22500, 87300, 378000],
      cols: ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ICMS'],
      rep: [[5.5, 3.5, 12.74, 2.76, 41.5, 34], [5.5, 3.5, 12.74, 2.76, 41.5, 34], [5.5, 3.5, 12.74, 2.76, 42, 33.5],
            [5.5, 3.5, 12.74, 2.76, 42, 33.5], [5.5, 3.5, 12.74, 2.76, 42, 33.5], [13.5, 10, 28.27, 6.13, 42.1, 0]] },
    II: { nome: 'Anexo II - Indústria', nom: [4.5, 7.8, 10, 11.2, 14.7, 30], ded: [0, 5940, 13860, 22500, 85500, 720000],
      cols: ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'IPI', 'ICMS'],
      rep: [[5.5, 3.5, 11.51, 2.49, 37.5, 7.5, 32], [5.5, 3.5, 11.51, 2.49, 37.5, 7.5, 32], [5.5, 3.5, 11.51, 2.49, 37.5, 7.5, 32],
            [5.5, 3.5, 11.51, 2.49, 37.5, 7.5, 32], [5.5, 3.5, 11.51, 2.49, 37.5, 7.5, 32], [8.5, 7.5, 20.96, 4.54, 23.5, 35, 0]] },
    III: { nome: 'Anexo III - Serviços', nom: [6, 11.2, 13.5, 16, 21, 33], ded: [0, 9360, 17640, 35640, 125640, 648000],
      cols: ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ISS'],
      rep: [[4, 3.5, 12.82, 2.78, 43.4, 33.5], [4, 3.5, 14.05, 3.05, 43.4, 32], [4, 3.5, 13.64, 2.96, 43.4, 32.5],
            [4, 3.5, 13.64, 2.96, 43.4, 32.5], [4, 3.5, 12.82, 2.78, 43.4, 33.5], [35, 15, 16.03, 3.47, 30.5, 0]],
      tetoIss: { faixa: 5, limite: '14.92537', rep: [6.02, 5.26, 19.28, 4.18, 65.26, 0] } },
    IV: { nome: 'Anexo IV - Serviços (CPP fora do DAS)', nom: [4.5, 9, 10.2, 14, 22, 33], ded: [0, 8100, 12420, 39780, 183780, 828000],
      cols: ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'ISS'],
      rep: [[18.8, 15.2, 17.67, 3.83, 44.5], [19.8, 15.2, 20.55, 4.45, 40], [20.8, 15.2, 19.73, 4.27, 40],
            [17.8, 19.2, 18.9, 4.1, 40], [18.8, 19.2, 18.08, 3.92, 40], [53.5, 21.5, 20.55, 4.45, 0]],
      tetoIss: { faixa: 5, limite: '12.5', rep: [31.33, 32, 30.13, 6.54, 0] } },
    V: { nome: 'Anexo V - Serviços', nom: [15.5, 18, 19.5, 20.5, 23, 30.5], ded: [0, 4500, 9900, 17100, 62100, 540000],
      cols: ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ISS'],
      rep: [[25, 15, 14.1, 3.05, 28.85, 14], [23, 15, 14.1, 3.05, 27.85, 17], [24, 15, 14.92, 3.23, 23.85, 19],
            [21, 15, 15.74, 3.41, 23.85, 21], [23, 12.5, 14.1, 3.05, 23.85, 23.5], [35, 15.5, 16.44, 3.56, 29.5, 0]] }
  };
  var IBS_DIVISOR = 91; // IBS = arred2(percentual PIS+Cofins / 91): 15,50 -> 0,17; 14,00 -> 0,15; 17,10 -> 0,19; 23,46 -> 0,26

  /**
   * Aliquota efetiva do DAS e a parcela de CBS e IBS (pCBSSN, pIBSSN) para 2027.
   * @param anexo 'I'..'V'; rbt12 receita bruta dos ultimos 12 meses
   */
  function simplesAliquotas(anexo, rbt12) {
    var a = ANEXOS[anexo];
    if (!a) throw new Error('Anexo inválido');
    var r = D(rbt12);
    if (r <= 0n) r = D(0.01);
    var f = 0;
    while (f < 5 && toNum(r) > FAIXAS_RBT12[f]) f++;
    var excedeLimite = toNum(r) > FAIXAS_RBT12[5];
    var nom = D(a.nom[f]), ded = D(a.ded[f]);
    var efet = toNum(r) <= FAIXAS_RBT12[0] ? nom : div(mul(r, nom) - mul(ded, CEM), r); // %
    if (efet < 0n) efet = 0n;
    var rep = a.rep[f].slice();
    var iPis = a.cols.indexOf('PIS'), iCof = a.cols.indexOf('COFINS');
    var partes = {};
    var tetoAplicado = false;
    if (a.tetoIss && f + 1 === a.tetoIss.faixa && efet > D(a.tetoIss.limite)) {
      tetoAplicado = true;
      var exced = efet - D(5);
      a.cols.forEach(function (col, i) { partes[col] = col === 'ISS' ? D(5) : div(mul(exced, D(a.tetoIss.rep[i])), CEM); });
    } else {
      a.cols.forEach(function (col, i) { partes[col] = div(mul(efet, D(rep[i])), CEM); });
    }
    // percentuais de reparticao 2027: o antigo PIS+Cofins vira CBS + IBS
    var repPisCof = tetoAplicado ? (a.tetoIss.rep[iPis] + a.tetoIss.rep[iCof]) : (rep[iPis] + rep[iCof]);
    var repIbs = roundHE(div(D(repPisCof), D(IBS_DIVISOR)), 2);
    var repCbs = roundHE(D(repPisCof) - repIbs, 2);
    var baseRep = tetoAplicado ? (efet - D(5)) : efet;
    var pCBS = div(mul(baseRep, repCbs), CEM);
    var pIBS = div(mul(baseRep, repIbs), CEM);
    var partes2027 = {};
    a.cols.forEach(function (col) { if (col !== 'PIS' && col !== 'COFINS') partes2027[col] = partes[col]; });
    partes2027.CBS = pCBS; partes2027.IBS = pIBS;
    return {
      anexo: anexo, anexoNome: a.nome, faixa: f + 1, rbt12: r, aliquotaNominal: nom, parcelaDeduzir: ded,
      aliquotaEfetiva: efet, pCBSSN: pCBS, pIBSSN: pIBS, partes2027: partes2027, repCBS: repCbs, repIBS: repIbs,
      tetoIssAplicado: tetoAplicado, excedeLimite: excedeLimite
    };
  }

  /** Valor da CBS/IBS de um item do Simples (SimplesNacionalCalculoService). casas: null (NF-e) ou 2 (NFS-e) */
  function calcularItemSimples(base, pCBSSN, pIBSSN, casas) {
    var pc = casas == null ? D(pCBSSN) : roundHE(D(pCBSSN), casas);
    var pi = casas == null ? D(pIBSSN) : roundHE(D(pIBSSN), casas);
    var b = D(base);
    var vBC = roundHE(b, 2);
    var vCBS = roundHE(div(mul(b, pc), CEM), 2);
    var vIBS = roundHE(div(mul(b, pi), CEM), 2);
    return { vBC: vBC, pCBSSN: pc, pIBSSN: pi, vCBS: vCBS, vIBS: vIBS, total: vCBS + vIBS };
  }

  // ---------------------------------------------------------------- simulacao mensal da empresa
  var REGIMES = {
    LR: { nome: 'Lucro Real', grupo: 'regular' },
    LP: { nome: 'Lucro Presumido', grupo: 'regular' },
    SN: { nome: 'Simples Nacional (IBS/CBS dentro do DAS)', grupo: 'simples' },
    SNH: { nome: 'Simples Nacional optante pelo regime regular de IBS/CBS', grupo: 'hibrido' }
  };
  // reducoes de aliquota da LC 214/2025 usadas na composicao da receita
  var CATEGORIAS = [
    { k: 'integral', nome: 'Tributação integral', red: 0 },
    { k: 'red30', nome: 'Redução de 30% (profissões intelectuais)', red: 30 },
    { k: 'red40', nome: 'Redução de 40% (bares, restaurantes, hotelaria, turismo)', red: 40 },
    { k: 'red60', nome: 'Redução de 60% (saúde, educação, alimentos, higiene etc.)', red: 60 },
    { k: 'zero', nome: 'Alíquota zero (cesta básica, hortifrúti, medicamentos etc.)', red: 100 },
    { k: 'naoInc', nome: 'Exportação, imunidade, isenção ou suspensão', red: 100 }
  ];

  /**
   * Simulacao mensal aproximada.
   * e = { regime, receitaBruta, descontos, icms, iss, composicao:{k:%}, comprasRegular, comprasSimples,
   *       aliqCreditoSimples, anexo, rbt12, premissas }
   */
  function simularEmpresa(e) {
    var p = Object.assign({}, PREMISSAS_PADRAO, e.premissas || {});
    var reg = REGIMES[e.regime] || REGIMES.LP;
    var bruto = D(e.receitaBruta), desc = D(e.descontos), icms = D(e.icms), iss = D(e.iss);
    var res = { regime: e.regime, regimeNome: reg.nome, receitaBruta: bruto, deducoes: desc + icms + iss, avisos: [] };
    if (reg.grupo === 'simples' || reg.grupo === 'hibrido') {
      var s = simplesAliquotas(e.anexo || 'I', e.rbt12 || (toNum(bruto) * 12));
      if (e.pCBSSN !== undefined && e.pCBSSN !== '' && e.pCBSSN !== null) { s.pCBSSN = D(e.pCBSSN); s.pIBSSN = D(e.pIBSSN || 0); s.informadoPgdas = true; }
      res.simples = s;
    }
    if (reg.grupo === 'simples') {
      var base = bruto - desc; if (base < 0n) base = 0n; // no Simples ICMS/ISS nao sao excluidos
      res.base = roundHE(base, 2);
      var it = calcularItemSimples(base, res.simples.pCBSSN, res.simples.pIBSSN, null);
      res.cbsDebito = it.vCBS; res.ibsDebito = it.vIBS;
      res.cbsCredito = 0n; res.ibsCredito = 0n;
      res.das = roundHE(div(mul(base, res.simples.aliquotaEfetiva), CEM), 2);
      res.dasSemCbsIbs = res.das - it.vCBS - it.vIBS;
      res.avisos.push('No Simples Nacional a CBS e o IBS são recolhidos dentro do DAS; não há apropriação de créditos.');
    } else {
      var b = bruto - desc - icms - iss; if (b < 0n) b = 0n;
      res.base = roundHE(b, 2);
      var comp = e.composicao || { integral: 100 };
      var somaPct = 0;
      CATEGORIAS.forEach(function (c) { somaPct += Number(comp[c.k] || 0); });
      if (Math.abs(somaPct - 100) > 0.001) res.avisos.push('A composição da receita soma ' + somaPct.toFixed(2) + '% (deveria somar 100%). O restante foi tratado como tributação integral.');
      var debCbs = 0n, debIbsUf = 0n, debIbsMun = 0n, alocado = 0n;
      res.porCategoria = [];
      CATEGORIAS.forEach(function (c, i) {
        var pct = Number(comp[c.k] || 0);
        if (!pct && c.k !== 'integral') return;
        var parte = roundHE(div(mul(res.base, D(pct)), CEM), 2);
        if (c.k === 'integral' && somaPct < 100) parte = roundHE(div(mul(res.base, D(pct + (100 - somaPct))), CEM), 2);
        alocado += parte;
        var cls = { c: '-', cst: '-', red: { cbs: c.red, ibsUf: c.red, ibsMun: c.red }, baseFator: 1, gIBSCBS: true };
        var r = calcularItemRegular(parte, cls, p);
        debCbs += r.tributos.cbs.devido; debIbsUf += r.tributos.ibsUf.devido; debIbsMun += r.tributos.ibsMun.devido;
        res.porCategoria.push({ k: c.k, nome: c.nome, base: parte, cbs: r.tributos.cbs.devido, ibs: r.vIBS });
      });
      res.cbsDebito = debCbs; res.ibsDebito = debIbsUf + debIbsMun;
      // creditos: compras de fornecedores do regime regular (aliquota integral) e do Simples (valor destacado)
      var cr = calcularItemRegular(D(e.comprasRegular), null, p);
      var cs = D(e.comprasSimples);
      var aliqSn = D(e.aliqCreditoSimples === undefined || e.aliqCreditoSimples === '' ? 0 : e.aliqCreditoSimples);
      var crSn = roundHE(div(mul(cs, aliqSn), CEM), 2);
      var totAliq = D(p.cbs) + D(p.ibsUf) + D(p.ibsMun);
      var crSnCbs = totAliq > 0n ? roundHE(div(mul(crSn, D(p.cbs)), totAliq), 2) : 0n;
      res.cbsCredito = cr.tributos.cbs.devido + crSnCbs;
      res.ibsCredito = cr.vIBS + (crSn - crSnCbs);
      if (reg.grupo === 'hibrido') {
        res.das = roundHE(div(mul(bruto - desc, res.simples.aliquotaEfetiva), CEM), 2);
        var itH = calcularItemSimples(bruto - desc, res.simples.pCBSSN, res.simples.pIBSSN, null);
        res.dasSemCbsIbs = res.das - itH.total;
        res.avisos.push('Optante pelo regime regular de IBS/CBS: o DAS deixa de incluir a parcela de CBS/IBS, que passa a ser apurada fora do Simples, com direito a créditos.');
      }
    }
    res.cbsRecolher = res.cbsDebito - res.cbsCredito; if (res.cbsRecolher < 0n) res.cbsRecolher = 0n;
    res.ibsRecolher = res.ibsDebito - res.ibsCredito; if (res.ibsRecolher < 0n) res.ibsRecolher = 0n;
    res.saldoCredor = (res.cbsCredito + res.ibsCredito) - (res.cbsDebito + res.ibsDebito); if (res.saldoCredor < 0n) res.saldoCredor = 0n;
    res.totalRecolher = res.cbsRecolher + res.ibsRecolher;
    res.cargaEfetiva = bruto > 0n ? div(mul(res.totalRecolher, CEM), bruto) : 0n;
    // comparativo 2026 (PIS/Cofins) - apenas referencia
    if (e.regime === 'LP') {
      res.pisCofins2026 = roundHE(div(mul(bruto - desc - icms, D(3.65)), CEM), 2);
      res.pisCofinsNota = 'PIS/Cofins cumulativos (0,65% + 3%) sobre a receita, já sem ICMS.';
    } else if (e.regime === 'LR') {
      var bpc = bruto - desc - icms; var cpc = D(e.comprasRegular) + D(e.comprasSimples);
      var v = div(mul(bpc - cpc, D(9.25)), CEM); if (v < 0n) v = 0n;
      res.pisCofins2026 = roundHE(v, 2);
      res.pisCofinsNota = 'PIS/Cofins não cumulativos (1,65% + 7,6%) sobre a receita sem ICMS, menos créditos sobre as compras informadas.';
    }
    return res;
  }

  var API = {
    dec: dec, D: D, toNum: toNum, toStr: toStr, roundHE: roundHE,
    PREMISSAS_PADRAO: PREMISSAS_PADRAO, REGIMES: REGIMES, CATEGORIAS: CATEGORIAS, ANEXOS: ANEXOS, FAIXAS_RBT12: FAIXAS_RBT12,
    baseNFe: baseNFe, baseNFSe: baseNFSe, baseSimplesNFe: baseSimplesNFe,
    calcularItemRegular: calcularItemRegular, calcularItemSimples: calcularItemSimples,
    criarIndice: criarIndice, sujeitoIS: sujeitoIS, ncmNoAnexo: ncmNoAnexo, nbsNoAnexo: nbsNoAnexo, classificacoesPara: classificacoesPara,
    simplesAliquotas: simplesAliquotas, simularEmpresa: simularEmpresa
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.RTC = API;
})(typeof window !== 'undefined' ? window : globalThis);
